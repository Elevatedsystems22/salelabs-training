/* Family voices for practice calls (ElevenLabs).
   GET  /api/tts/status?speakers=Tasha:f,Earl:mo,...   -> { ok, cast:{name:voiceId} }   ok=false when no key (the course falls back to built-in voices)
   POST /api/tts            { text, voiceId }           -> audio/mpeg
   GET  /api/tts/voices     managers: voices on the ElevenLabs account
   POST /api/tts/cast       admins: { cast:{name:voiceId} } saves voice picks for every agent
   Needs ELEVENLABS_API_KEY. Optional: ELEVENLABS_MODEL (default eleven_flash_v2_5),
   TTS_DAILY_CHAR_LIMIT (default 400000 characters a day across the whole team, roughly 130 practice calls). */
import { addUsage, whoFrom } from "../lib/usage.mjs";
import { getStore } from "@netlify/blobs";
import { allowed, json } from "../lib/guard.mjs";
import { authManager } from "../lib/auth.mjs";

const API = process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io/v1";
const KEY = () => process.env.ELEVENLABS_API_KEY;
const VID = /^[A-Za-z0-9]{10,40}$/;
const db = () => getStore({ name: "tts", consistency: "strong" });
const chicagoDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

let voicesCache = null, voicesAt = 0;
async function voices() {
  if (voicesCache && Date.now() - voicesAt < 10 * 60 * 1000) return voicesCache;
  const r = await fetch(`${API}/voices`, { headers: { "xi-api-key": KEY() } });
  if (!r.ok) throw new Error("voices " + r.status);
  const j = await r.json();
  voicesCache = (j.voices || []).map(v => ({ id: v.voice_id, name: v.name, category: v.category, gender: (v.labels && v.labels.gender) || "", age: (v.labels && v.labels.age) || "", accent: (v.labels && v.labels.accent) || "", desc: (v.labels && (v.labels.description || v.labels.descriptive)) || "", use: (v.labels && (v.labels.use_case || v.labels.use)) || "", preview: v.preview_url || "" }));
  voicesAt = Date.now();
  return voicesCache;
}
// Picks a different voice for each person: matching gender, American if possible, older voices for older people.
function autoCast(list, speakers, saved) {
  const out = {}, used = new Set(Object.values(saved || {}));
  const score = (v, sp) => {
    let s = 0;
    if (v.gender && v.gender[0] === sp.g) s += 10; else if (v.gender) s -= 20;
    if (/americ/i.test(v.accent)) s += 4;
    if (/convers|social|narrat|character/i.test(v.use)) s += 1;
    if (sp.old && /old|middle/i.test(v.age)) s += 3;
    if (!sp.old && /young|middle/i.test(v.age)) s += 2;
    return s;
  };
  for (const sp of speakers) {
    if (saved && saved[sp.name] && list.some(v => v.id === saved[sp.name])) { out[sp.name] = saved[sp.name]; continue; }
    const best = list.filter(v => !used.has(v.id)).sort((a, b) => score(b, sp) - score(a, sp))[0] || list[0];
    if (best) { out[sp.name] = best.id; used.add(best.id); }
  }
  return out;
}

const parseSpeakers = req => String(new URL(req.url).searchParams.get("speakers") || "").split(",").slice(0, 20).map(s => { const [name, t = ""] = s.split(":"); return { name: String(name || "").slice(0, 30), g: t[0] === "f" ? "f" : "m", old: t.includes("o") }; }).filter(s => s.name);

/* The team-wide daily voice cap: the owner's Costs-tab setting wins, then TTS_DAILY_CHAR_LIMIT. Cached for a minute. */
let capCache = { at: 0, v: 0 };
async function voiceCap() {
  if (Date.now() - capCache.at < 60000 && capCache.v) return capCache.v;
  let v = Number(process.env.TTS_DAILY_CHAR_LIMIT || 400000);
  try { const st = await getStore({ name: "costs", consistency: "strong" }).get("settings", { type: "json" }); if (st && Number(st.ttsDailyChars) > 0) v = Number(st.ttsDailyChars); } catch (e) {}
  capCache = { at: Date.now(), v }; return v;
}

export default async (req) => {
  const path = new URL(req.url).pathname;
  if (path === "/api/tts/status") {
    if (!KEY()) return json({ ok: false, reason: "missing_key" });
    const speakers = parseSpeakers(req);
    try {
      const saved = (await db().get("cast", { type: "json" }).catch(() => null)) || {};
      return json({ ok: true, cast: autoCast(await voices(), speakers, saved) });
    } catch (e) { return json({ ok: false, reason: "elevenlabs_error" }); }
  }
  if (!KEY()) return json({ error: "missing_key", message: "ELEVENLABS_API_KEY is not set in Netlify." }, 500);

  // GET /api/tts/play?v=<voice>&t=<text>: same as POST, but an <audio> element can start playing while it downloads.
  const play = path === "/api/tts/play" && req.method === "GET";
  if ((path === "/api/tts" && req.method === "POST") || play) {
    const sameSite = req.headers.get("sec-fetch-site") === "same-origin";
    if (!allowed(req) && !(play && sameSite)) return json({ error: "forbidden" }, 403);
    let b; try { b = play ? { voiceId: new URL(req.url).searchParams.get("v"), text: new URL(req.url).searchParams.get("t") } : await req.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
    const text = String(b.text || "").replace(/\[[^\]]*\]/g, "").trim().slice(0, 600);
    if (!text || !VID.test(String(b.voiceId || ""))) return json({ error: "bad_request" }, 400);
    // Daily spending cap for the whole team.
    const limit = await voiceCap(), uk = "usage/" + chicagoDay(), store = db();
    const used = Number((await store.get(uk).catch(() => null)) || 0);
    if (used + text.length > limit) return json({ error: "daily_limit" }, 429);
    await store.set(uk, String(used + text.length)).catch(() => {});
    const r = await fetch(`${API}/text-to-speech/${b.voiceId}/stream?output_format=mp3_44100_64&optimize_streaming_latency=2`, {
      method: "POST",
      headers: { "xi-api-key": KEY(), "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5", voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true } }),
      signal: req.signal
    });
    if (!r.ok || !r.body) return json({ error: "elevenlabs_error", status: r.status, detail: (await r.text()).slice(0, 300) }, 502);
    // Cost meter: Flash/Turbo bill 0.5 credits per character, other models 1.
    const model = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";
    await addUsage(whoFrom(req), { ttsChars: text.length, ttsCredits: text.length * (/flash|turbo/.test(model) ? 0.5 : 1) });
    return new Response(r.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
  }

  const me = await authManager(req);
  if (!me) return json({ error: "unauthorized" }, 401);
  if (path === "/api/tts/voices" && req.method === "GET") {
    try {
      const saved = (await db().get("cast", { type: "json" }).catch(() => null)) || {};
      const used = Number((await db().get("usage/" + chicagoDay()).catch(() => null)) || 0);
      const list = await voices();
      return json({ voices: list, saved, cast: autoCast(list, parseSpeakers(req), saved), usedToday: used, limit: await voiceCap() });
    } catch (e) { return json({ error: "elevenlabs_error", message: String(e.message || e) }, 502); }
  }
  if (path === "/api/tts/cast" && req.method === "POST") {
    if (!me.admin) return json({ error: "forbidden", message: "Only admins can change voices." }, 403);
    let b; try { b = await req.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
    const cast = {};
    for (const [k, v] of Object.entries(b.cast || {}).slice(0, 30)) if (/^[A-Za-z .'-]{1,30}$/.test(k) && VID.test(String(v))) cast[k] = String(v);
    await db().setJSON("cast", cast);
    return json({ ok: true, cast });
  }
  return json({ error: "not_found" }, 404);
};

export const config = { path: ["/api/tts", "/api/tts/*"] };
