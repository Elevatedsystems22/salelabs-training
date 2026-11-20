/* First 25 lists and daily schedule sheets.
   GET  /api/lists/first25?uid=            an agent's First 25 list
   POST /api/lists/first25                 {uid, name, invite, leads:{1..25:{name,phone,city,notes,disposition}}, submit}
   GET  /api/lists/sched?uid=&date=        an agent's schedule sheet for a day
   POST /api/lists/sched                   {uid, name, invite, date, rows:[{name,address,phone,notes}], stats:{...}}
   GET  /api/lists/team/first25            managers: every agent's First 25
   GET  /api/lists/team/sched?date=        managers: every agent's schedule sheet for a day
   Stored in Netlify Blobs "lists". */
import { getStore } from "@netlify/blobs";
import { allowed, json } from "../lib/guard.mjs";
import { authManager } from "../lib/auth.mjs";

const UID = /^[A-Za-z0-9-]{8,64}$/, DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v, n) => String(v == null ? "" : v).slice(0, n);
const DISP = new Set(["", "no-contact", "callback", "no-appt", "appt"]);
const STAT_KEYS = ["noShows", "reschedules", "presentations", "refs", "sales"];

function cleanLeads(l) {
  const out = {};
  for (let i = 1; i <= 25; i++) {
    const x = (l && l[i]) || {};
    out[i] = { name: str(x.name, 80), phone: str(x.phone, 30), city: str(x.city, 60), notes: str(x.notes, 300), disposition: DISP.has(x.disposition) ? x.disposition : "" };
  }
  return out;
}
async function listAll(db, prefix) {
  const { blobs } = await db.list({ prefix });
  return (await Promise.all(blobs.map(b => db.get(b.key, { type: "json" }).catch(() => null)))).filter(Boolean);
}

export default async (req) => {
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, "");
  const db = getStore({ name: "lists", consistency: "strong" });
  const body = async () => { try { return await req.json(); } catch (e) { return null; } };

  if (path === "/api/lists/first25" && req.method === "GET") {
    const uid = url.searchParams.get("uid") || ""; if (!UID.test(uid)) return json({ error: "bad_request" }, 400);
    return json((await db.get("first25/" + uid, { type: "json" })) || { leads: cleanLeads({}), submittedAt: "" });
  }
  if (path === "/api/lists/first25" && req.method === "POST") {
    if (!allowed(req)) return json({ error: "forbidden" }, 403);
    const b = await body(); if (!b || !UID.test(String(b.uid || ""))) return json({ error: "bad_request" }, 400);
    const prev = (await db.get("first25/" + b.uid, { type: "json" })) || {};
    const rec = { uid: b.uid, name: str(b.name, 80) || prev.name || "", invite: str(b.invite, 64) || prev.invite || "", leads: cleanLeads(b.leads), submittedAt: b.submit ? new Date().toISOString() : (prev.submittedAt || ""), updatedAt: new Date().toISOString() };
    await db.setJSON("first25/" + b.uid, rec);
    return json(rec);
  }
  if (path === "/api/lists/sched" && req.method === "GET") {
    const uid = url.searchParams.get("uid") || "", date = url.searchParams.get("date") || "";
    if (!UID.test(uid) || !DATE.test(date)) return json({ error: "bad_request" }, 400);
    return json((await db.get(`sched/${date}/${uid}`, { type: "json" })) || { date, rows: [], stats: {} });
  }
  if (path === "/api/lists/sched" && req.method === "POST") {
    if (!allowed(req)) return json({ error: "forbidden" }, 403);
    const b = await body(); if (!b || !UID.test(String(b.uid || "")) || !DATE.test(String(b.date || ""))) return json({ error: "bad_request" }, 400);
    const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 16).map(r => ({ name: str(r && r.name, 80), address: str(r && r.address, 120), phone: str(r && r.phone, 30), notes: str(r && r.notes, 200) }));
    const stats = {}; STAT_KEYS.forEach(k => { stats[k] = str(b.stats && b.stats[k], 10); });
    const rec = { uid: b.uid, name: str(b.name, 80), invite: str(b.invite, 64), date: b.date, rows, stats, updatedAt: new Date().toISOString() };
    await db.setJSON(`sched/${b.date}/${b.uid}`, rec);
    return json(rec);
  }
  if (path.startsWith("/api/lists/team/")) {
    if (!(await authManager(req))) return json({ error: "signed_out" }, 401);
    if (path === "/api/lists/team/first25") return json({ lists: await listAll(db, "first25/") });
    if (path === "/api/lists/team/sched") {
      const date = url.searchParams.get("date") || ""; if (!DATE.test(date)) return json({ error: "bad_request" }, 400);
      return json({ date, sheets: await listAll(db, `sched/${date}/`) });
    }
  }
  return json({ error: "not_found" }, 404);
};

export const config = { path: ["/api/lists/*"] };
