/* Selling the training to other agency owners: $75 (default) per agent seat, paid once through Stripe.
   Public:
     GET  /api/agency/info                       -> { seatPrice, payments }
     POST /api/agency/checkout  { agencyName, ownerName, email, phone, seats }   -> { url } Stripe Checkout for a new agency
     GET  /api/agency/confirm?session_id=        -> after paying: the agency, plus the owner's temporary password once
   Signed in:
     POST /api/agency/seats     { qty }          agency admins: buy more seats -> { url }
     GET  /api/agency/list                       owner only: every agency, seats and trainees
     POST /api/agency/grant     { org, qty }     owner only: add or remove seats for free (comps, refunds)
   Seat price is set by the owner on the Costs tab (seatPriceCents). Payments go to your Stripe account (STRIPE_SECRET_KEY). */
import { randomBytes } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { allowed, json } from "../lib/guard.mjs";
import { authManager, managersStore } from "../lib/auth.mjs";
import { agenciesStore, orgOf, isOwner, inviteMap, orgIsTest, TEST_SEAT_CENTS } from "../lib/org.mjs";
import { fulfillAgency, pendingStore } from "../lib/agency.mjs";
import { ALLOWANCE_DEFAULTS, ALLOWANCE_VERSION } from "../lib/allowance.mjs";

const STRIPE = process.env.STRIPE_API_BASE || "https://api.stripe.com/v1";
const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function seatPrice() {
  const st = (await getStore({ name: "costs", consistency: "strong" }).get("settings", { type: "json" }).catch(() => null)) || {};
  const v = st.allowanceVersion === ALLOWANCE_VERSION ? Number(st.seatPriceCents) : NaN;
  return Math.max(100, Math.round(Number.isFinite(v) && v > 0 ? v : (Number(process.env.SEAT_PRICE_CENTS) || ALLOWANCE_DEFAULTS.seatPriceCents)));
}
async function stripe(path, form) {
  const r = await fetch(STRIPE + path, { method: form ? "POST" : "GET", headers: { authorization: "Bearer " + process.env.STRIPE_SECRET_KEY, ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || "stripe " + r.status);
  return j;
}
const checkout = async (origin, { qty, price, meta, email, back }) => stripe("/checkout/sessions", {
  mode: "payment", "line_items[0][quantity]": String(qty), "line_items[0][price_data][currency]": "usd", "line_items[0][price_data][unit_amount]": String(price),
  "line_items[0][price_data][product_data][name]": "Virtual Presentation Academy: Agent Seat",
  "line_items[0][price_data][product_data][description]": "One agent's training: the 6-Day Quick Start, AI practice calls and the phone and Zoom certification exams",
  ...Object.fromEntries(Object.entries(meta).map(([k, v]) => ["metadata[" + k + "]", String(v)])), ...(email ? { customer_email: email } : {}),
  success_url: origin + back + (back.includes("?") ? "&" : "?") + "paid={CHECKOUT_SESSION_ID}", cancel_url: origin + back
});

export default async (req) => {
  const url = new URL(req.url), path = url.pathname, origin = url.origin;

  if (path === "/api/agency/info" && req.method === "GET") return json({ seatPrice: url.searchParams.get("test") ? TEST_SEAT_CENTS : await seatPrice(), payments: !!process.env.STRIPE_SECRET_KEY });

  if (path === "/api/agency/checkout" && req.method === "POST") {
    if (!allowed(req)) return json({ error: "forbidden" }, 403);
    if (!process.env.STRIPE_SECRET_KEY) return json({ error: "payments_off", message: "Card payments aren't set up yet." }, 503);
    let b; try { b = await req.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
    const p = { agencyName: str(b.agencyName, 80), ownerName: str(b.ownerName, 80), email: str(b.email, 120).toLowerCase(), phone: str(b.phone, 30), seats: Math.min(200, Math.max(1, parseInt(b.seats, 10) || 1)), createdAt: new Date().toISOString() };
    // Test mode ($1 seats) only works for the owner's own login.
    if (b.test) { if (!isOwner(await authManager(req).catch(() => null))) return json({ error: "owner_only", message: "Test mode only works when you're signed in as the owner in this browser." }, 403); p.test = true; }
    if (!p.agencyName || !p.ownerName || !EMAIL.test(p.email)) return json({ error: "bad_request", message: "Agency name, your name and a valid email are required." }, 400);
    // Someone on Brandon's own team can't open a separate agency under the same email.
    const mgrs = managersStore(), { blobs } = await mgrs.list();
    const all = (await Promise.all(blobs.map(x => mgrs.get(x.key, { type: "json" }).catch(() => null)))).filter(Boolean);
    const clash = all.find(m => String(m.email || "").toLowerCase() === p.email);
    if (clash && !clash.org) return json({ error: "email_taken", message: "That email is already used by a manager on another team. Use a different email." }, 400);
    const pending = randomBytes(12).toString("base64url");
    await pendingStore().setJSON(pending, p);
    try { const s = await checkout(origin, { qty: p.seats, price: p.test ? TEST_SEAT_CENTS : await seatPrice(), meta: { type: "agency_new", pending, qty: p.seats, ...(p.test ? { test: 1 } : {}) }, email: p.email, back: p.test ? "/test" : "/agency" }); return json({ url: s.url }); }
    catch (e) { return json({ error: "stripe_error", message: e.message }, 502); }
  }

  if (path === "/api/agency/confirm" && req.method === "GET") {
    if (!process.env.STRIPE_SECRET_KEY) return json({ error: "payments_off" }, 503);
    const id = str(url.searchParams.get("session_id"), 200);
    if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return json({ error: "bad_request" }, 400);
    try {
      const session = await stripe("/checkout/sessions/" + id), r = await fulfillAgency(session, origin);
      if (!r.ok) return json({ ok: false, pending: session.payment_status !== "paid" });
      let temp = "";
      const pid = session.metadata && session.metadata.pending;
      if (r.type === "agency_new" && pid) { const p = await pendingStore().get(pid, { type: "json" }).catch(() => null); if (p && p.temp && !p.shown) { temp = p.temp; await pendingStore().setJSON(pid, { ...p, shown: true, temp: "" }); } }
      return json({ ok: true, type: r.type, name: r.name, seats: r.seats, added: r.added, email: r.email || "", notified: !!r.notified, temp, signIn: origin + "/#manager" });
    } catch (e) { return json({ error: "stripe_error", message: e.message }, 502); }
  }

  const me = await authManager(req);
  if (!me) return json({ error: "signed_out" }, 401);
  const ag = agenciesStore();

  if (path === "/api/agency/seats" && req.method === "POST") {
    const org = orgOf(me);
    if (!org) return json({ error: "bad_request", message: "Your team doesn't use seats." }, 400);
    if (!me.admin) return json({ error: "forbidden", message: "Only your agency's admin can buy seats." }, 403);
    if (!process.env.STRIPE_SECRET_KEY) return json({ error: "payments_off", message: "Card payments aren't set up yet." }, 503);
    let b; try { b = await req.json(); } catch (e) { b = {}; }
    const qty = Math.min(200, Math.max(1, parseInt(b.qty, 10) || 1));
    try { const s = await checkout(origin, { qty, price: (await orgIsTest(org)) ? TEST_SEAT_CENTS : await seatPrice(), meta: { type: "seats", org, qty }, email: me.email, back: "/?agency=seats" }); return json({ url: s.url }); }
    catch (e) { return json({ error: "stripe_error", message: e.message }, 502); }
  }

  if (path === "/api/agency/list" && req.method === "GET") {
    if (!isOwner(me)) return json({ error: "forbidden" }, 403);
    const { blobs } = await ag.list({ prefix: "org/" });
    const orgs = (await Promise.all(blobs.map(x => ag.get(x.key, { type: "json" }).catch(() => null)))).filter(Boolean);
    const inv = await inviteMap(), byOrg = {};
    Object.values(inv).forEach(i => { if (i.org) { const o = byOrg[i.org] = byOrg[i.org] || { invited: 0, started: 0 }; o.invited++; if (i.acceptedAt) o.started++; } });
    return json({ seatPrice: await seatPrice(), agencies: orgs.map(o => ({ id: o.id, name: o.name, contact: o.contact || {}, seats: o.seats || 0, seatsUsed: o.seatsUsed || 0, createdAt: o.createdAt, test: !!o.test,
      paidCents: (o.purchases || []).reduce((n, p) => n + (p.cents || 0), 0), ...(byOrg[o.id] || { invited: 0, started: 0 }) })).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")) });
  }
  if (path === "/api/agency/grant" && req.method === "POST") {
    if (!isOwner(me)) return json({ error: "forbidden" }, 403);
    let b; try { b = await req.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
    const org = await ag.get("org/" + str(b.org, 80), { type: "json" }).catch(() => null), qty = Math.max(-500, Math.min(500, parseInt(b.qty, 10) || 0));
    if (!org || !qty) return json({ error: "bad_request" }, 400);
    org.seats = Math.max(org.seatsUsed || 0, (org.seats || 0) + qty);
    org.purchases = [{ at: Date.now(), qty, cents: 0, grantedBy: me.id }, ...(org.purchases || [])].slice(0, 200);
    await ag.setJSON("org/" + org.id, org);
    return json({ ok: true, seats: org.seats });
  }
  return json({ error: "not_found" }, 404);
};

export const config = { path: ["/api/agency/*"] };
