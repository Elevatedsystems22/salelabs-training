/* Trainee progress for the Manager view.
   POST /api/progress   the course saves a small progress snapshot for each trainee (no AI cost).
   GET  /api/progress   the manager view reads everyone; needs the header x-manager-code.
   DELETE /api/progress?uid=…   removes one trainee from the list; needs x-manager-code.
   Needs the environment variable MANAGER_CODE (your manager passcode). Data is kept in Netlify Blobs. */
import { getStore } from "@netlify/blobs";
import { timingSafeEqual } from "node:crypto";
import { allowed, json } from "../lib/guard.mjs";

const UID = /^[A-Za-z0-9-]{8,64}$/;
const str = (v, n) => String(v == null ? "" : v).slice(0, n);
const num = (v, lo, hi) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : 0; };

function codeOk(req) {
  const want = process.env.MANAGER_CODE || "";
  const got = req.headers.get("x-manager-code") || "";
  if (!want || !got) return false;
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

function clean(s) {
  return {
    uid: s.uid,
    name: str(s.name, 80),
    joinedAt: str(s.joinedAt, 40),
    lastActive: str(s.lastActive, 40),
    savedAt: new Date().toISOString(),
    lessons: num(s.lessons, 0, 200),
    lessonsTotal: num(s.lessonsTotal, 1, 200),
    quizAvg: num(s.quizAvg, 0, 100),
    calls: num(s.calls, 0, 100000),
    avgScore: num(s.avgScore, 0, 100),
    weak: str(s.weak, 60),
    examTele: !!s.examTele,
    examZoom: !!s.examZoom,
    certified: !!s.certified,
    next: str(s.next, 80),
    invite: /^[A-Za-z0-9_-]{8,64}$/.test(String(s.invite || "")) ? s.invite : "",
    lastCall: s.lastCall && typeof s.lastCall === "object" ? {
      family: str(s.lastCall.family, 60), format: str(s.lastCall.format, 20), total: num(s.lastCall.total, 0, 100),
      pass: !!s.lastCall.pass, date: str(s.lastCall.date, 40), summary: str(s.lastCall.summary, 400)
    } : null
  };
}

export default async (req) => {
  const db = getStore({ name: "trainees", consistency: "strong" });

  if (req.method === "POST") {
    if (!allowed(req)) return json({ error: "forbidden" }, 403);
    let body; try { body = await req.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
    const s = body && body.snapshot;
    if (!s || !UID.test(String(s.uid || "")) || !String(s.name || "").trim()) return json({ error: "bad_request" }, 400);
    const rec = clean(s);
    await db.setJSON(s.uid, rec);
    if (rec.invite) {
      const invites = getStore({ name: "invites", consistency: "strong" });
      const inv = await invites.get(rec.invite, { type: "json" }).catch(() => null);
      if (inv && !inv.acceptedAt) await invites.setJSON(rec.invite, { ...inv, acceptedAt: new Date().toISOString(), uid: rec.uid });
    }
    return json({ ok: true });
  }

  if (req.method === "GET") {
    if (!process.env.MANAGER_CODE) return json({ error: "missing_code", message: "MANAGER_CODE is not set in Netlify." }, 500);
    if (!codeOk(req)) return json({ error: "wrong_code" }, 401);
    const { blobs } = await db.list();
    const rows = await Promise.all(blobs.map(b => db.get(b.key, { type: "json" }).catch(() => null)));
    return json({ trainees: rows.filter(Boolean) });
  }

  if (req.method === "DELETE") {
    if (!codeOk(req)) return json({ error: "wrong_code" }, 401);
    const uid = new URL(req.url).searchParams.get("uid") || "";
    if (!UID.test(uid)) return json({ error: "bad_request" }, 400);
    await db.delete(uid);
    return json({ ok: true });
  }

  return json({ error: "method_not_allowed" }, 405);
};

export const config = { path: "/api/progress" };
