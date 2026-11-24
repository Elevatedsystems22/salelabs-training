/* Cost meter. Only the owner (Brandon's manager login, or the MANAGER_CODE master key) can read it.
   POST /api/usage/video     {uid, name, seconds}  the course reports how long a video face was on screen
   GET  /api/usage/owner                           -> {owner}  (signed-in manager: may this person see costs?)
   GET  /api/usage/report?month=YYYY-MM            owner only: per-trainee costs, plan totals, month-end estimate
   POST /api/usage/settings                        owner only: plan prices {elPlan, elCredits, elRate, anamPlan, anamMin, anamRate, otherFixed}
   OWNER_MANAGER_ID (optional) changes whose login is the owner; default "brandon-carter". */
import { allowed, json } from "../lib/guard.mjs";
import { authManager } from "../lib/auth.mjs";
import { addUsage, costsStore, chicagoMonth } from "../lib/usage.mjs";

const DEFAULTS = { elPlan: 22, elCredits: 121000, elRate: 0.30, anamPlan: 49, anamMin: 250, anamRate: 0.14, otherFixed: 0 };
const isOwner = me => !!me && (me.id === "_master" || me.id === (process.env.OWNER_MANAGER_ID || "brandon-carter"));
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

async function elevenSubscription() {
  if (!process.env.ELEVENLABS_API_KEY) return null;
  try {
    const r = await fetch((process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io/v1") + "/user/subscription", { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } });
    if (!r.ok) return { error: r.status };
    const j = await r.json();
    return { tier: j.tier || "", used: j.character_count || 0, limit: j.character_limit || 0, resetsAt: j.next_character_count_reset_unix ? new Date(j.next_character_count_reset_unix * 1000).toISOString() : "" };
  } catch (e) { return { error: "unreachable" }; }
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
  const settings = Object.assign({}, DEFAULTS, (await store.get("settings", { type: "json" }).catch(() => null)) || {});

  if (path === "/api/usage/settings" && req.method === "POST") {
    let b; try { b = await req.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
    const next = {
      elPlan: num(b.elPlan, 0, 10000, settings.elPlan), elCredits: num(b.elCredits, 0, 1e9, settings.elCredits), elRate: num(b.elRate, 0, 10, settings.elRate),
      anamPlan: num(b.anamPlan, 0, 10000, settings.anamPlan), anamMin: num(b.anamMin, 0, 1e6, settings.anamMin), anamRate: num(b.anamRate, 0, 10, settings.anamRate),
      otherFixed: num(b.otherFixed, 0, 10000, settings.otherFixed)
    };
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
    return json({ month, thisMonth, months: [...months].sort().reverse(), rows, settings, eleven: month === thisMonth ? await elevenSubscription() : null });
  }
  return json({ error: "not_found" }, 404);
};

export const config = { path: ["/api/usage/video", "/api/usage/owner", "/api/usage/report", "/api/usage/settings"] };
