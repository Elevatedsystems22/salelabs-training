/* Practice-call credits.
   Every agent gets FREE_TRIES_PER_LEAD free practice calls per lead type (default 3). After that each call uses one purchased call.
   Exams are always free and never come through here. Managers are never charged (the course skips this for them).

   GET  /api/credits?uid=&invite=                     -> { free:{lead:left}, freePerLead, paid, price, min, payments }
   POST /api/credits/use     { uid, invite, lead }    -> { ok, used:"free"|"paid", useId } or 402 { error:"no_credits" }
   POST /api/credits/refund  { uid, invite, useId }   -> gives a call back if it was used less than 3 minutes ago (dropped or mistaken calls)
   POST /api/credits/checkout { uid, invite, qty }    -> { url }  Stripe Checkout page
   GET  /api/credits/confirm?session_id=              -> adds the calls if Stripe says it's paid (backup for the webhook)
   POST /api/credits/webhook                          -> Stripe: checkout.session.completed
   GET  /api/credits/team                             managers: every agent's usage
   POST /api/credits/grant   { account, qty }         managers: give an agent extra calls for free

   Env: STRIPE_SECRET_KEY (a restricted key with Checkout Sessions: Write is enough), STRIPE_WEBHOOK_SECRET.
   Price, minimum purchase and free calls per lead type are set by the owner on the Costs tab (saved with the cost meter's settings);
   CALL_PRICE_CENTS / MIN_CALLS_PER_PURCHASE / FREE_TRIES_PER_LEAD are only the starting defaults. */
import { getStore } from "@netlify/blobs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { allowed, json } from "../lib/guard.mjs";
import { authManager } from "../lib/auth.mjs";

const STRIPE = process.env.STRIPE_API_BASE || "https://api.stripe.com/v1";
const db = () => getStore({ name: "credits", consistency: "strong" });
let CFG = { free: 3, price: 200, min: 5 };
async function loadCfg() {
  const st = (await getStore({ name: "costs", consistency: "strong" }).get("settings", { type: "json" }).catch(() => null)) || {};
  const n = (v, d) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v))) ? d : Number(v);
  CFG = {
    free: Math.max(0, Math.round(n(st.freePerLead, n(process.env.FREE_TRIES_PER_LEAD, 3)))),
    price: Math.max(50, Math.round(n(st.callPriceCents, n(process.env.CALL_PRICE_CENTS, 200)))),
    min: Math.max(1, Math.round(n(st.minCalls, n(process.env.MIN_CALLS_PER_PURCHASE, 5))))
  };
}
const FREE = () => CFG.free, PRICE = () => CFG.price, MIN = () => CFG.min;
const LEADS = ["Pre-Submit", "ADP Referral", "Globe Lapsed", "Policy Owner"];
const str = (v, n) => String(v == null ? "" : v).slice(0, n);

// One account per invited agent (by invite token); falls back to the browser's id for anyone without an invite.
async function accountFor(uid, invite) {
  invite = str(invite, 80); uid = str(uid, 80);
  if (invite) { const inv = await getStore({ name: "invites", consistency: "strong" }).get(invite, { type: "json" }).catch(() => null); if (inv) return "inv_" + invite; }
  if (/^[A-Za-z0-9_-]{6,80}$/.test(uid)) return "uid_" + uid;
  return null;
}
async function load(acct) { return (await db().get("acct/" + acct, { type: "json" }).catch(() => null)) || { used: {}, paid: 0, uses: [], purchases: [] }; }
async function store(acct, a, extra) { a.updatedAt = Date.now(); Object.assign(a, extra || {}); await db().setJSON("acct/" + acct, a); }
function summary(a) {
  const free = {}; LEADS.forEach(l => free[l] = Math.max(0, FREE() - ((a.used || {})[l] || 0)));
  return { free, freePerLead: FREE(), paid: a.paid || 0, price: PRICE(), min: MIN(), payments: !!process.env.STRIPE_SECRET_KEY };
}
async function stripe(path, form) {
  const r = await fetch(STRIPE + path, { method: form ? "POST" : "GET", headers: { authorization: "Bearer " + process.env.STRIPE_SECRET_KEY, ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || "stripe " + r.status);
  return j;
}
// Adds purchased calls once per Stripe session, whether the webhook or the return page gets there first.
async function credit(session) {
  if (!session || session.payment_status !== "paid") return { ok: false };
  const md = session.metadata || {}, acct = str(md.account, 120), qty = Math.min(500, Math.max(0, parseInt(md.qty, 10) || 0));
  if (!acct || !qty) return { ok: false };
  const mark = "session/" + session.id;
  if (await db().get(mark).catch(() => null)) return { ok: true, already: true, acct };
  await db().set(mark, acct);
  const a = await load(acct);
  a.paid = (a.paid || 0) + qty;
  a.purchases = [{ at: Date.now(), qty, cents: session.amount_total || 0, session: session.id }, ...(a.purchases || [])].slice(0, 100);
  await store(acct, a);
  return { ok: true, acct, qty };
}
function verifyStripe(payload, header, secret) {
  const parts = Object.fromEntries(String(header || "").split(",").map(p => p.split("=")).filter(p => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = String(header || "").split(",").filter(p => p.trim().startsWith("v1=")).map(p => p.trim().slice(3));
  if (!parts.t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 600) return false;
  const want = createHmac("sha256", secret).update(parts.t + "." + payload).digest("hex");
  return sigs.some(s => s.length === want.length && timingSafeEqual(Buffer.from(s), Buffer.from(want)));
}

export default async (req) => {
  const url = new URL(req.url), path = url.pathname;
  await loadCfg();

  if (path === "/api/credits/webhook" && req.method === "POST") {
    const secret = process.env.STRIPE_WEBHOOK_SECRET; if (!secret) return json({ error: "missing_secret" }, 500);
    const payload = await req.text();
    if (!verifyStripe(payload, req.headers.get("stripe-signature"), secret)) return json({ error: "bad_signature" }, 400);
    let ev; try { ev = JSON.parse(payload); } catch (e) { return json({ error: "bad_request" }, 400); }
    if (ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") await credit(ev.data && ev.data.object);
    return json({ received: true });
  }

  if (path === "/api/credits" && req.method === "GET") {
    const acct = await accountFor(url.searchParams.get("uid"), url.searchParams.get("invite"));
    if (!acct) return json({ error: "bad_request" }, 400);
    return json(summary(await load(acct)));
  }

  if (path === "/api/credits/confirm" && req.method === "GET") {
    if (!process.env.STRIPE_SECRET_KEY) return json({ error: "payments_off" }, 503);
    const id = str(url.searchParams.get("session_id"), 200);
    if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return json({ error: "bad_request" }, 400);
    try { const r = await credit(await stripe("/checkout/sessions/" + id)); if (!r.ok) return json({ ok: false, pending: true }); return json({ ok: true, ...summary(await load(r.acct)), added: r.already ? 0 : r.qty }); }
    catch (e) { return json({ error: "stripe_error", message: e.message }, 502); }
  }

  if (req.method === "POST" && ["/api/credits/use", "/api/credits/refund", "/api/credits/checkout"].includes(path)) {
    if (!allowed(req)) return json({ error: "forbidden" }, 403);
    let b; try { b = await req.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
    const acct = await accountFor(b.uid, b.invite); if (!acct) return json({ error: "bad_request" }, 400);

    if (path === "/api/credits/use") {
      const lead = LEADS.includes(b.lead) ? b.lead : null; if (!lead) return json({ error: "bad_lead" }, 400);
      const a = await load(acct); a.used = a.used || {};
      let kind;
      if ((a.used[lead] || 0) < FREE()) { a.used[lead] = (a.used[lead] || 0) + 1; kind = "free"; }
      else if ((a.paid || 0) > 0) { a.paid -= 1; kind = "paid"; }
      else return json({ error: "no_credits", ...summary(a) }, 402);
      const useId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      a.uses = [{ id: useId, at: Date.now(), lead, kind, format: str(b.format, 10) }, ...(a.uses || [])].slice(0, 200);
      await store(acct, a, { name: str(b.name, 80) || a.name });
      return json({ ok: true, used: kind, useId, ...summary(a) });
    }
    if (path === "/api/credits/refund") {
      const a = await load(acct), u = (a.uses || []).find(x => x.id === b.useId);
      if (!u || u.refunded || Date.now() - u.at > 3 * 60 * 1000) return json({ ok: false, ...summary(a) });
      u.refunded = true;
      if (u.kind === "free") a.used[u.lead] = Math.max(0, (a.used[u.lead] || 0) - 1); else a.paid = (a.paid || 0) + 1;
      await store(acct, a);
      return json({ ok: true, ...summary(a) });
    }
    if (path === "/api/credits/checkout") {
      if (!process.env.STRIPE_SECRET_KEY) return json({ error: "payments_off", message: "Card payments aren't set up yet. Ask your manager." }, 503);
      const qty = Math.min(200, Math.max(MIN(), parseInt(b.qty, 10) || 0));
      const back = str(b.returnUrl, 500); let base;
      try { base = new URL(back); if (!/^https?:$/.test(base.protocol)) throw 0; } catch (e) { base = new URL(url.origin + "/"); }
      if (base.origin !== url.origin && !(process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).includes(base.origin)) base = new URL(url.origin + "/");
      const ret = base.origin + base.pathname;
      try {
        const s = await stripe("/checkout/sessions", {
          mode: "payment", "line_items[0][quantity]": String(qty), "line_items[0][price_data][currency]": "usd", "line_items[0][price_data][unit_amount]": String(PRICE()),
          "line_items[0][price_data][product_data][name]": "AI practice calls", "line_items[0][price_data][product_data][description]": "Practice calls with an AI family in the Virtual Presentation Academy",
          "metadata[account]": acct, "metadata[qty]": String(qty), client_reference_id: acct.slice(0, 200),
          success_url: ret + "?paid={CHECKOUT_SESSION_ID}#practice", cancel_url: ret + "#practice"
        });
        return json({ url: s.url });
      } catch (e) { return json({ error: "stripe_error", message: e.message }, 502); }
    }
  }

  const me = await authManager(req);
  if (!me) return json({ error: "unauthorized" }, 401);
  if (path === "/api/credits/team" && req.method === "GET") {
    const { blobs } = await db().list({ prefix: "acct/" });
    const rows = (await Promise.all(blobs.slice(0, 500).map(async x => { const a = await db().get(x.key, { type: "json" }).catch(() => null); if (!a) return null; const s = summary(a); return { account: x.key.slice(5), name: a.name || "", used: a.used || {}, paid: a.paid || 0, freeLeft: s.free, bought: (a.purchases || []).reduce((n, p) => n + (p.qty || 0), 0), spentCents: (a.purchases || []).reduce((n, p) => n + (p.cents || 0), 0), calls: (a.uses || []).filter(u => !u.refunded).length, updatedAt: a.updatedAt || 0 }; }))).filter(Boolean);
    return json({ rows: rows.sort((a, b) => b.updatedAt - a.updatedAt), freePerLead: FREE(), price: PRICE() });
  }
  if (path === "/api/credits/grant" && req.method === "POST") {
    let b; try { b = await req.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
    const acct = str(b.account, 120), qty = Math.max(-500, Math.min(500, parseInt(b.qty, 10) || 0));
    if (!/^(inv|uid)_[A-Za-z0-9_-]+$/.test(acct) || !qty) return json({ error: "bad_request" }, 400);
    const a = await load(acct); a.paid = Math.max(0, (a.paid || 0) + qty);
    a.purchases = [{ at: Date.now(), qty, cents: 0, grantedBy: me.id || me.name || "manager" }, ...(a.purchases || [])].slice(0, 100);
    await store(acct, a);
    return json({ ok: true, paid: a.paid });
  }
  return json({ error: "not_found" }, 404);
};

export const config = { path: ["/api/credits", "/api/credits/*"] };
