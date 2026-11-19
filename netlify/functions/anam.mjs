/* Video avatars (Anam).
   POST /api/anam/session  { avatarId, voiceId, name }  -> { sessionToken }  (Anam's own AI is off; the family brain talks)
   GET  /api/anam/catalog                                -> { avatars, voices }  (for the casting page)
   Needs the environment variable ANAM_API_KEY. */
import { allowed, json } from "../lib/guard.mjs";

const API = "https://api.anam.ai/v1";
const auth = () => ({ Authorization: `Bearer ${process.env.ANAM_API_KEY}`, "content-type": "application/json" });

export default async (req) => {
  if (!allowed(req) && req.method === "POST") return json({ error: "forbidden" }, 403);
  if (!process.env.ANAM_API_KEY) return json({ error: "missing_key", message: "ANAM_API_KEY is not set in Netlify." }, 500);
  const path = new URL(req.url).pathname;

  if (path.endsWith("/session") && req.method === "POST") {
    let b; try { b = await req.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
    if (!b.avatarId || !b.voiceId) return json({ error: "bad_request", message: "avatarId and voiceId are required" }, 400);
    const r = await fetch(`${API}/auth/session-token`, {
      method: "POST", headers: auth(),
      body: JSON.stringify({
        clientLabel: "salelabs-training",
        expiresInSeconds: 600,
        personaConfig: { name: String(b.name || "Family member").slice(0, 40), avatarId: b.avatarId, voiceId: b.voiceId, llmId: "CUSTOMER_CLIENT_V1", maxSessionLengthSeconds: 3600, skipGreeting: true },
        sessionOptions: { dataRetention: { recording: false, transcripts: false } }
      })
    });
    const t = await r.text();
    if (!r.ok) return json({ error: "anam_error", status: r.status, detail: t.slice(0, 500) }, 502);
    try { return json({ sessionToken: JSON.parse(t).sessionToken }); } catch (e) { return json({ error: "anam_error" }, 502); }
  }

  if (path.endsWith("/catalog") && req.method === "GET") {
    const get = async (p) => { const r = await fetch(`${API}/${p}?perPage=100`, { headers: auth() }); return r.ok ? r.json() : { data: [], error: r.status }; };
    const [avatars, voices] = await Promise.all([get("avatars"), get("voices")]);
    return json({ avatars, voices });
  }
  return json({ error: "not_found" }, 404);
};

export const config = { path: ["/api/anam/session", "/api/anam/catalog"] };
