/* Free allowance + purchased calls for every AI activity.

   Each agent has a free AI budget (default $50) split into three buckets, so no single activity can use it all up:
     learn    (lesson role-plays, objection drills)      default $12
     practice (practice calls with an AI family)         default $13, plus 3 free calls per lead type
     exam     (phone presentation and Zoom exams)         default $25
   Every free start counts a conservative cost estimate against its bucket. Free starts also have daily limits.
   When the free allowance for something is used up (for today or for good), the agent can keep going with purchased calls:
     practice call = 1 call, phone exam = 1 call, Zoom exam = 3 calls, 10 more role-plays or drills = 1 call.
   Managers have the same limits; only the owner's login (OWNER_MANAGER_ID, default "brandon-carter") is never limited.

   GET  /api/credits?uid=&invite=                          -> summary
   POST /api/credits/start   { uid, invite, kind, lead, format }   kind: practice | exam_tele | exam_zoom | roleplay | drill
                                                            -> { ok, used:"free"|"paid"|"pack", useId } or 402 { error:"no_credits", reason, need }
   POST /api/credits/use     { uid, invite, lead, format }  (older name for kind=practice)
   POST /api/credits/refund  { uid, invite, useId }         gives it back if it was started less than 3 minutes ago
   POST /api/credits/checkout { uid, invite, qty }          -> { url } Stripe Checkout
   GET  /api/credits/confirm?session_id=                    adds bought calls (backup for the webhook)
   POST /api/credits/webhook                                Stripe: checkout.session.completed
   GET  /api/credits/team                                   managers: everyone's usage
   POST /api/credits/grant   { account, qty, resetToday }   managers: free calls, or reset today's limits

   Env: STRIPE_SECRET_KEY (restricted key, Checkout Sessions: Write), STRIPE_WEBHOOK_SECRET.
   All prices and limits are set by the owner on the Costs tab (saved with the cost meter's settings). */
import { getStore } from "@netlify/blobs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { allowed, json } from "../lib/guard.mjs";
import { authManager } from "../lib/auth.mjs";
import { ALLOWANCE_DEFAULTS, ALLOWANCE_VERSION } from "../lib/allowance.mjs";

const STRIPE = process.env.STRIPE_API_BASE || "https://api.stripe.com/v1";
const db = () => getStore({ name: "credits", consistency: "strong" });
const LEADS = ["Pre-Submit", "ADP Referral", "Globe Lapsed", "Policy Owner"];
const KINDS = ["practice", "exam_tele", "exam_zoom", "roleplay", "drill"];
const BUCKET = { practice: "practice", exam_tele: "exam", exam_zoom: "exam", roleplay: "learn", drill: "learn" };
const str = (v, n) => String(v == null ? "" : v).slice(0, n);
const isOwner = me => !!me && (me.id === "_master" || me.id === (process.env.OWNER_MANAGER_ID || "brandon-carter"));


let C = { ...ALLOWANCE_DEFAULTS };
async function loadCfg() {
  let st = (await getStore({ name: "costs", consistency: "strong" }).get("settings", { type: "json" }).catch(() => null)) || {};
  if (st.allowanceVersion !== ALLOWANCE_VERSION) st = {}; // saved before the current plan: use the new starting values
  const env = { freePerLead: process.env.FREE_TRIES_PER_LEAD, callPriceCents: process.env.CALL_PRICE_CENTS, minCalls: process.env.MIN_CALLS_PER_PURCHASE };
  C = {};
  for (const [k, d] of Object.entries(ALLOWANCE_DEFAULTS)) {
    const v = st[k] !== undefined && st[k] !== null && st[k] !== "" ? st[k] : env[k];
    C[k] = Number.isFinite(Number(v)) && v !== undefined && v !== null && v !== "" ? Math.max(0, Number(v)) : d;
  }
  C.callPriceCents = Math.max(50, Math.round(C.callPriceCents)); C.minCalls = Math.max(1, Math.round(C.minCalls)); C.learnPackReps = Math.max(1, Math.round(C.learnPackReps));
}
const budget = b => b === "learn" ? C.budgetLearn : b === "practice" ? C.budgetPractice : C.budgetExam;
const daily = k => ({ practice: C.dailyPractice, exam_tele: C.dailyExamTele, exam_zoom: C.dailyExamZoom, roleplay: C.dailyRoleplay, drill: C.dailyDrill })[k];
const est = (k, format) => k === "practice" ? (format === "dial" ? C.estDial : C.estCall) : ({ exam_tele: C.estExamTele, exam_zoom: C.estExamZoom, roleplay: C.estRoleplay, drill: C.estDrill })[k];
const callsFor = k => k === "exam_tele" ? C.examTeleCalls : k === "exam_zoom" ? C.examZoomCalls : 1;

function chicagoDay(d = new Date()) { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(d); }

// One account per invited agent (by invite token); falls back to the browser's id for anyone without an invite.
async function accountFor(uid, invite) {
  invite = str(invite, 80); uid = str(uid, 80);
  if (invite) { const inv = await getStore({ name: "invites", consistency: "strong" }).get(invite, { type: "json" }).catch(() => null); if (inv) return "inv_" + invite; }
  if (/^[A-Za-z0-9_-]{6,80}$/.test(uid)) return "uid_" + uid;
  return null;
}
async function load(acct) { return (await db().get("acct/" + acct, { type: "json" }).catch(() => null)) || { used: {}, paid: 0, uses: [], purchases: [] }; }
async function save(acct, a, extra) { a.updatedAt = Date.now(); Object.assign(a, extra || {}); await db().setJSON("acct/" + acct, a); }
function today(a) { const d = chicagoDay(); if (!a.day || a.day.date !== d) a.day = { date: d, counts: {} }; return a.day.counts; }
function summary(a) {
  const t = today(a), spent = a.spent || {};
  const free = {}; LEADS.forEach(l => free[l] = Math.max(0, C.freePerLead - ((a.used || {})[l] || 0)));
  const todayLeft = {}; KINDS.forEach(k => todayLeft[k] = Math.max(0, daily(k) - (t[k] || 0)));
  const budgetLeft = {}; ["learn", "practice", "exam"].forEach(b => budgetLeft[b] = Math.max(0, Math.round((budget(b) - (spent[b] || 0)) * 100) / 100));
  return { free, freePerLead: C.freePerLead, paid: a.paid || 0, learnReps: a.learnReps || 0, todayLeft, budgetLeft,
    daily: Object.fromEntries(KINDS.map(k => [k, daily(k)])), budgetTotal: C.budgetLearn + C.budgetPractice + C.budgetExam, calls: { practice: 1, exam_tele: C.examTeleCalls, exam_zoom: C.examZoomCalls, learn: 1 }, learnPackReps: C.learnPackReps,
    price: C.callPriceCents, min: C.minCalls, payments: !!process.env.STRIPE_SECRET_KEY };
}
/* Decide how a start is paid for. Returns { mode, credits } or { error reason, need }. */
function decide(a, kind, lead, format) {
  const t = today(a), b = BUCKET[kind], spent = (a.spent || {})[b] || 0, cost = est(kind, format);
  const dayOk = (t[kind] || 0) < daily(kind), budgetOk = spent + cost <= budget(b) + 1e-9;
  const leadOk = kind !== "practice" || ((a.used || {})[lead] || 0) < C.freePerLead;
  if (dayOk && budgetOk && leadOk) return { mode: "free", cost };
  const reason = !leadOk ? "lead" : !budgetOk ? "budget" : "daily";
  if (b === "learn") {
    if ((a.learnReps || 0) > 0) return { mode: "pack", reason };
    if ((a.paid || 0) >= 1) return { mode: "paid", credits: 1, pack: true, reason };
    return { error: true, reason, need: 1 };
  }
  const need = callsFor(kind);
  if ((a.paid || 0) >= need) return { mode: "paid", credits: need, reason };
  return { error: true, reason, need };
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
  await save(acct, a);
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

  // The owner is never limited (signed in to the manager view in the same browser).
  const owner = req.headers.get("authorization") ? isOwner(await authManager(req).catch(() => null)) : false;

  if (path === "/api/credits" && req.method === "GET") {
    if (owner) return json({ owner: true, payments: !!process.env.STRIPE_SECRET_KEY });
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

  if (req.method === "POST" && ["/api/credits/use", "/api/credits/start", "/api/credits/refund", "/api/credits/checkout"].includes(path)) {
    if (!allowed(req)) return json({ error: "forbidden" }, 403);
    let b; try { b = await req.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
    const acct = await accountFor(b.uid, b.invite); if (!acct) return json({ error: "bad_request" }, 400);

    if (path === "/api/credits/use" || path === "/api/credits/start") {
      const kind = path === "/api/credits/use" ? "practice" : (KINDS.includes(b.kind) ? b.kind : null);
      if (!kind) return json({ error: "bad_kind" }, 400);
      if (owner) return json({ ok: true, used: "owner", owner: true });
      const lead = LEADS.includes(b.lead) ? b.lead : null, format = str(b.format, 10);
      if (kind === "practice" && !lead) return json({ error: "bad_lead" }, 400);
      const a = await load(acct); a.used = a.used || {}; a.spent = a.spent || {};
      const d = decide(a, kind, lead, format);
      if (d.error) return json({ error: "no_credits", reason: d.reason, need: d.need, kind, ...summary(a) }, 402);
      // Purchased calls are only spent after the agent says yes in the course.
      if (d.mode === "paid" && !b.allowPaid) return json({ error: "confirm_paid", reason: d.reason, need: d.credits, kind, ...summary(a) }, 402);
      const t = today(a), bucket = BUCKET[kind], use = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), at: Date.now(), kind, lead, format, mode: d.mode };
      if (d.mode === "free") { t[kind] = (t[kind] || 0) + 1; a.spent[bucket] = Math.round(((a.spent[bucket] || 0) + d.cost) * 1000) / 1000; use.est = d.cost; if (kind === "practice") a.used[lead] = (a.used[lead] || 0) + 1; }
      else if (d.mode === "pack") a.learnReps -= 1;
      else { a.paid -= d.credits; use.credits = d.credits; if (d.pack) a.learnReps = (a.learnReps || 0) + C.learnPackReps - 1; }
      a.uses = [use, ...(a.uses || [])].slice(0, 300);
      await save(acct, a, { name: str(b.name, 80) || a.name });
      return json({ ok: true, used: d.mode, reason: d.reason, useId: use.id, ...summary(a) });
    }
    if (path === "/api/credits/refund") {
      const a = await load(acct), u = (a.uses || []).find(x => x.id === b.useId);
      if (!u || u.refunded || Date.now() - u.at > 3 * 60 * 1000) return json({ ok: false, ...summary(a) });
      u.refunded = true;
      if (u.mode === "free" || !u.mode) {
        const k = u.kind || "practice", t = today(a);
        if (t[k]) t[k] -= 1;
        if (u.est) { a.spent = a.spent || {}; a.spent[BUCKET[k]] = Math.max(0, (a.spent[BUCKET[k]] || 0) - u.est); }
        if (k === "practice" && u.lead) a.used[u.lead] = Math.max(0, (a.used[u.lead] || 0) - 1);
      } else if (u.mode === "pack") a.learnReps = (a.learnReps || 0) + 1;
      else if (u.credits) { if (BUCKET[u.kind] === "learn") a.learnReps = (a.learnReps || 0) + 1; else a.paid = (a.paid || 0) + u.credits; }
      else a.paid = (a.paid || 0) + 1; // older practice-call records
      await save(acct, a);
      return json({ ok: true, ...summary(a) });
    }
    if (path === "/api/credits/checkout") {
      if (!process.env.STRIPE_SECRET_KEY) return json({ error: "payments_off", message: "Card payments aren't set up yet. Ask your manager." }, 503);
      const qty = Math.min(200, Math.max(C.minCalls, parseInt(b.qty, 10) || 0));
      const back = str(b.returnUrl, 500); let base;
      try { base = new URL(back); if (!/^https?:$/.test(base.protocol)) throw 0; } catch (e) { base = new URL(url.origin + "/"); }
      if (base.origin !== url.origin && !(process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).includes(base.origin)) base = new URL(url.origin + "/");
      const ret = base.origin + base.pathname;
      try {
        const s = await stripe("/checkout/sessions", {
          mode: "payment", "line_items[0][quantity]": String(qty), "line_items[0][price_data][currency]": "usd", "line_items[0][price_data][unit_amount]": String(C.callPriceCents),
          "line_items[0][price_data][product_data][name]": "AI practice calls", "line_items[0][price_data][product_data][description]": "Practice calls, exam retakes and extra practice with AI clients in the Virtual Presentation Academy",
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
    const rows = (await Promise.all(blobs.slice(0, 500).map(async x => { const a = await db().get(x.key, { type: "json" }).catch(() => null); if (!a) return null; const s = summary(a); const sp = a.spent || {}; return { account: x.key.slice(5), name: a.name || "", paid: a.paid || 0, freeSpent: Math.round(((sp.learn || 0) + (sp.practice || 0) + (sp.exam || 0)) * 100) / 100, budgetLeft: s.budgetLeft, bought: (a.purchases || []).filter(p => p.cents > 0).reduce((n, p) => n + (p.qty || 0), 0), spentCents: (a.purchases || []).reduce((n, p) => n + (p.cents || 0), 0), updatedAt: a.updatedAt || 0 }; }))).filter(Boolean);
    return json({ rows: rows.sort((a, b) => b.updatedAt - a.updatedAt), budgetTotal: C.budgetLearn + C.budgetPractice + C.budgetExam });
  }
  if (path === "/api/credits/grant" && req.method === "POST") {
    let b; try { b = await req.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
    const acct = str(b.account, 120), qty = Math.max(-500, Math.min(500, parseInt(b.qty, 10) || 0));
    if (!/^(inv|uid)_[A-Za-z0-9_-]+$/.test(acct) || (!qty && !b.resetToday)) return json({ error: "bad_request" }, 400);
    const a = await load(acct);
    if (qty) { a.paid = Math.max(0, (a.paid || 0) + qty); a.purchases = [{ at: Date.now(), qty, cents: 0, grantedBy: me.id || me.name || "manager" }, ...(a.purchases || [])].slice(0, 100); }
    if (b.resetToday) a.day = { date: chicagoDay(), counts: {} };
    await save(acct, a);
    return json({ ok: true, ...summary(a) });
  }
  return json({ error: "not_found" }, 404);
};

export const config = { path: ["/api/credits", "/api/credits/*"] };
