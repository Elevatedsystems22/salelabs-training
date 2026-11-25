/* Cost meter. Only the owner (Brandon's manager login, or the MANAGER_CODE master key) can read it.
   POST /api/usage/video     {uid, name, seconds}  the course reports how long a video face was on screen
   GET  /api/usage/owner                           -> {owner}  (signed-in manager: may this person see costs?)
   GET  /api/usage/report?month=YYYY-MM            owner only: per-trainee costs, plan totals, month-end estimate
   POST /api/usage/settings                        owner only: plan prices {elPlan, elCredits, elRate, anamPlan, anamMin, anamRate, otherFixed}
   ANTHROPIC_ADMIN_KEY (optional) reads actual Claude charges from Anthropic billing; ANTHROPIC_WORKSPACE_ID limits it to one workspace.
   OWNER_MANAGER_ID (optional) changes whose login is the owner; default "brandon-carter". */
import { getStore } from "@netlify/blobs";
import { allowed, json } from "../lib/guard.mjs";
import { authManager } from "../lib/auth.mjs";
import { addUsage, costsStore, chicagoMonth } from "../lib/usage.mjs";
import { ALLOWANCE_DEFAULTS, ALLOWANCE_VERSION } from "../lib/allowance.mjs";

const DEFAULTS = { elPlan: 22, elCredits: 121000, elRate: 0.30, anamPlan: 49, anamMin: 250, anamRate: 0.14, otherFixed: 0, ttsDailyChars: 400000, ...ALLOWANCE_DEFAULTS };
const isOwner = me => !!me && (me.id === "_master" || me.id === (process.env.OWNER_MANAGER_ID || "brandon-carter"));
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

async function elevenSubscription() {
  if (!process.env.ELEVENLABS_API_KEY) return null;
  try {
    const r = await fetch((process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io/v1") + "/user/subscription", { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } });
    if (!r.ok) return { error: r.status };
    const j = await r.json();
    const inv = j.next_invoice || null, over = j.current_overage || null;
    return { tier: j.tier || "", status: j.status || "", used: j.character_count || 0, limit: j.character_limit || 0, resetsAt: j.next_character_count_reset_unix ? new Date(j.next_character_count_reset_unix * 1000).toISOString() : "",
      nextInvoice: inv && Number.isFinite(inv.amount_due_cents) ? { amount: inv.amount_due_cents / 100, subtotal: (inv.subtotal_cents || 0) / 100, tax: (inv.tax_cents || 0) / 100, dueAt: inv.next_payment_attempt_unix ? new Date(inv.next_payment_attempt_unix * 1000).toISOString() : "" } : null,
      overage: over && over.amount != null ? Number(over.amount) : null };
  } catch (e) { return { error: "unreachable" }; }
}

/* Actual Claude spend from Anthropic's billing (needs ANTHROPIC_ADMIN_KEY, an Admin key from the Claude Console).
   ANTHROPIC_WORKSPACE_ID (optional) counts only that workspace, so other projects on the same account aren't included. */
async function anthropicCost(month) {
  const key = process.env.ANTHROPIC_ADMIN_KEY; if (!key) return null;
  const [y, m] = month.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1)).toISOString(), end = new Date(Date.UTC(y, m, 1)).toISOString(), ws = process.env.ANTHROPIC_WORKSPACE_ID || "";
  let total = 0, page = "", days = 0, refreshed = "";
  try {
    for (let i = 0; i < 5; i++) {
      const q = new URLSearchParams({ starting_at: start, ending_at: end, bucket_width: "1d", limit: "31" }); q.append("group_by[]", "workspace_id"); if (page) q.set("page", page);
      const r = await fetch("https://api.anthropic.com/v1/organizations/cost_report?" + q, { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
      if (!r.ok) return { error: r.status, detail: (await r.text()).slice(0, 200) };
      const j = await r.json(); refreshed = j.data_refreshed_at || refreshed;
      (j.data || []).forEach(b => { const day = (b.results || []).filter(x => !ws || x.workspace_id === ws).reduce((a, x) => a + Number(x.amount || 0), 0); if (day) days++; total += day; });
      if (!j.has_more || !j.next_page) break; page = j.next_page;
    }
  } catch (e) { return { error: "unreachable" }; }
  return { amount: total / 100, workspace: ws || "all", daysWithCost: days, refreshedAt: refreshed };
}

/* Practice calls trainees bought through Stripe this month (manager gifts don't count as sales). */
async function practiceSales(month) {
  try {
    const db = getStore({ name: "credits", consistency: "strong" }), { blobs } = await db.list({ prefix: "acct/" });
    const accts = (await Promise.all(blobs.slice(0, 1000).map(b => db.get(b.key, { type: "json" }).catch(() => null)))).filter(Boolean);
    let cents = 0, calls = 0, buyers = 0, freeUsed = 0, paidUsed = 0;
    accts.forEach(a => {
      const bought = (a.purchases || []).filter(p => p.cents > 0 && chicagoMonth(new Date(p.at)) === month);
      if (bought.length) buyers++;
      bought.forEach(p => { cents += p.cents; calls += p.qty; });
      (a.uses || []).filter(u => !u.refunded && chicagoMonth(new Date(u.at)) === month).forEach(u => u.kind === "free" ? freeUsed++ : paidUsed++);
    });
    return { amount: cents / 100, calls, buyers, freeUsed, paidUsed };
  } catch (e) { return null; }
}

export default async (req) => {
  const url = new URL(req.url), path = url.pathname;

  if (path === "/api/usage/video" && req.method === "POST") {
    if (!allowed(req)) return json({ error: "forbidden" }, 403);
    let b; try { b = JSON.parse(await req.text()); } catch (e) { return json({ error: "bad_request" }, 400); }
    const sec = num(b.seconds, 0, 7200, 0);
    if (sec > 0) await addUsage({ uid: b.uid, name: b.name }, { videoSeconds: sec, videoSessions: 1 });
    return json({ ok: true });
  }

  const me = await authManager(req);
  if (path === "/api/usage/owner") return json({ owner: isOwner(me) });
  if (!isOwner(me)) return json({ error: "forbidden" }, 403);
  const store = costsStore();
  const saved = (await store.get("settings", { type: "json" }).catch(() => null)) || {};
  if (saved.allowanceVersion !== ALLOWANCE_VERSION) for (const k of Object.keys(ALLOWANCE_DEFAULTS)) delete saved[k]; // older plan: show the new starting values
  const settings = Object.assign({}, DEFAULTS, saved);

  if (path === "/api/usage/settings" && req.method === "POST") {
    let b; try { b = await req.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
    const next = {
      elPlan: num(b.elPlan, 0, 10000, settings.elPlan), elCredits: num(b.elCredits, 0, 1e9, settings.elCredits), elRate: num(b.elRate, 0, 10, settings.elRate),
      anamPlan: num(b.anamPlan, 0, 10000, settings.anamPlan), anamMin: num(b.anamMin, 0, 1e6, settings.anamMin), anamRate: num(b.anamRate, 0, 10, settings.anamRate),
      otherFixed: num(b.otherFixed, 0, 10000, settings.otherFixed), ttsDailyChars: Math.round(num(b.ttsDailyChars, 0, 1e8, settings.ttsDailyChars))
    };
    // free allowance and purchased-call settings
    for (const k of Object.keys(ALLOWANCE_DEFAULTS)) next[k] = num(b[k], 0, /Cents$/.test(k) ? 1000000 : 1000, settings[k]);
    next.callPriceCents = Math.max(50, Math.round(next.callPriceCents)); next.minCalls = Math.max(1, Math.round(next.minCalls));
    next.allowanceVersion = ALLOWANCE_VERSION;
    await store.setJSON("settings", next);
    return json({ settings: next });
  }

  if (path === "/api/usage/report" && req.method === "GET") {
    const thisMonth = chicagoMonth();
    const month = /^\d{4}-\d{2}$/.test(url.searchParams.get("month") || "") ? url.searchParams.get("month") : thisMonth;
    const { blobs } = await store.list({ prefix: month + "/" });
    const rows = (await Promise.all(blobs.map(b => store.get(b.key, { type: "json" }).catch(() => null)))).filter(Boolean);
    const months = new Set([thisMonth]);
    try { const all = await store.list({ directories: true }); (all.directories || []).forEach(d => /^\d{4}-\d{2}$/.test(d) && months.add(d)); } catch (e) {}
    const [eleven, anthropic, sales] = await Promise.all([month === thisMonth ? elevenSubscription() : null, anthropicCost(month), practiceSales(month)]);
    return json({ month, thisMonth, months: [...months].sort().reverse(), rows, settings, eleven, anthropic, sales, payments: !!process.env.STRIPE_SECRET_KEY, stripeWebhook: !!process.env.STRIPE_WEBHOOK_SECRET });
  }
  return json({ error: "not_found" }, 404);
};

export const config = { path: ["/api/usage/video", "/api/usage/owner", "/api/usage/report", "/api/usage/settings"] };
