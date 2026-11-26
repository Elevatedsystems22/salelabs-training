/* System check: is every outside service the course depends on answering right now?
   GET /api/health -> { at, cached, checks: { name: { ok, detail } } }
   The result is saved for 15 minutes, so opening this page over and over costs nothing extra (one check is about a cent). */
import { getStore } from "@netlify/blobs";
import { json } from "../lib/guard.mjs";

const TTL = 15 * 60 * 1000;
const short = (s, n = 160) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

async function claude(model, system, user, max) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: max, system, messages: [{ role: "user", content: user }] })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, detail: model + ": " + short((j.error && j.error.message) || "HTTP " + r.status) };
  return { ok: true, detail: model + " replied: “" + short((j.content || []).map(c => c.text || "").join(" ")) + "”" };
}

async function runChecks() {
  const c = {};
  const family = process.env.MODEL_FAMILY || "claude-sonnet-5-5", fast = process.env.MODEL_FAST || "claude-haiku-5-5", smart = process.env.MODEL_SMART || "claude-sonnet-5-5";
  if (!process.env.ANTHROPIC_API_KEY) c.ai_family = c.ai_fast = { ok: false, detail: "ANTHROPIC_API_KEY is not set" };
  else {
    const sys = "You are Danielle Brooks, 34, a dental office manager in Mobile, Alabama. Your coworker referred you for a no-cost accidental death benefit through Globe Life Liberty National. You are on a phone call with an insurance agent. Answer like a real person on the phone: one or two short sentences, no stage directions.";
    const [a, b] = await Promise.all([
      claude(family, sys, "Agent: Hi, is this Danielle? This is Jordan with Globe Life Liberty National. Your coworker Tasha put you down for the no-cost benefit. Did she mention I'd be calling?", 120),
      claude(fast, "Reply with exactly one word.", "Say ready.", 10)
    ]);
    c.ai_family = a; c.ai_fast = b;
    if (smart !== family && smart !== fast) c.ai_grader = await claude(smart, "Reply with exactly one word.", "Say ready.", 10);
  }
  if (!process.env.ELEVENLABS_API_KEY) c.voices = { ok: false, detail: "ELEVENLABS_API_KEY is not set (calls fall back to the browser's built-in voice)" };
  else {
    const r = await fetch((process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io/v1") + "/voices", { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } });
    const j = await r.json().catch(() => ({}));
    c.voices = r.ok ? { ok: true, detail: (j.voices || []).length + " voices available" } : { ok: false, detail: short((j.detail && (j.detail.message || j.detail)) || "HTTP " + r.status) };
  }
  if (!process.env.ANAM_API_KEY) c.video = { ok: false, detail: "ANAM_API_KEY is not set (the Zoom exam's video person won't load)" };
  else {
    const r = await fetch("https://api.anam.ai/v1/avatars?perPage=1", { headers: { Authorization: "Bearer " + process.env.ANAM_API_KEY } });
    c.video = r.ok ? { ok: true, detail: "Video person service answered" } : { ok: false, detail: "HTTP " + r.status };
  }
  if (!process.env.STRIPE_SECRET_KEY) c.payments = { ok: false, detail: "STRIPE_SECRET_KEY is not set" };
  else {
    const r = await fetch((process.env.STRIPE_API_BASE || "https://api.stripe.com/v1") + "/checkout/sessions?limit=1", { headers: { authorization: "Bearer " + process.env.STRIPE_SECRET_KEY } });
    // A restricted key that can only create checkouts may not be allowed to list them; that still means the key is live.
    c.payments = r.ok || r.status === 403 ? { ok: true, detail: "Stripe key accepted" + (process.env.STRIPE_WEBHOOK_SECRET ? ", webhook secret set" : ", but STRIPE_WEBHOOK_SECRET is missing") } : { ok: false, detail: "Stripe said HTTP " + r.status };
    if (!process.env.STRIPE_WEBHOOK_SECRET) c.payments.ok = false;
  }
  c.texting = process.env.NOTIFY_WEBHOOK_URL ? { ok: true, detail: "Texting and email webhook is set" } : { ok: false, detail: "NOTIFY_WEBHOOK_URL is not set" };
  return c;
}

export default async (req) => {
  const st = getStore({ name: "costs", consistency: "strong" });
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  const prev = await st.get("health", { type: "json" }).catch(() => null);
  // "?fresh=1" re-runs the checks, but not more than once a minute.
  if (prev && Date.now() - prev.ts < (fresh ? 60 * 1000 : TTL)) return json({ at: new Date(prev.ts).toISOString(), cached: true, checks: prev.checks });
  const checks = await runChecks();
  await st.setJSON("health", { ts: Date.now(), checks });
  return json({ at: new Date().toISOString(), cached: false, checks });
};

export const config = { path: "/api/health" };
