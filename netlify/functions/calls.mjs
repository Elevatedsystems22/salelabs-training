/* Real-call tracking (from the Make a call screen).
   POST /api/calls            {uid, name, invite, call:{t, lead, contact, appt, label, now}}   log one call
   POST /api/calls/undo       {uid}                                                            remove today's last call
   GET  /api/calls/me?uid=    your daily totals (all time) + today's calls
   GET  /api/calls/day?uid=&date=YYYY-MM-DD   one day's calls (for CSV)
   GET  /api/calls/board?range=today|week|month   leaderboard: agents and teams (first name + last initial)
   GET  /api/calls/team       managers only: every agent's daily totals
   Stored in Netlify Blobs "calls": agent/<uid> (summary) and day/<date>/<uid> (call list). Dates and hours are Central time. */
import { getStore } from "@netlify/blobs";
import { allowed, json } from "../lib/guard.mjs";
import { authManager, managersStore } from "../lib/auth.mjs";

const UID = /^[A-Za-z0-9-]{8,64}$/;
const TZ = "America/Chicago";
const str = (v, n) => String(v == null ? "" : v).slice(0, n);
const APPT = new Set(["yes", "callback", "no"]);

function central(t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour };
}
const blankDay = () => ({ total: 0, contacts: 0, appts: 0, callbacks: 0, byLead: {}, byHour: {} });
function add(day, c, sign) {
  const k = (o, key) => (o[key] = o[key] || { t: 0, c: 0, a: 0 });
  day.total += sign; if (c.contact) day.contacts += sign; if (c.appt === "yes") day.appts += sign; if (c.appt === "callback") day.callbacks += sign;
  for (const b of [k(day.byLead, c.lead || "Other"), k(day.byHour, String(c.hour))]) { b.t += sign; if (c.contact) b.c += sign; if (c.appt === "yes") b.a += sign; }
}
const shortName = n => { const p = String(n || "").trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : (p[0] || "Agent"); };
function rangeDates(range) {
  const now = Date.now(), list = [];
  for (let i = 0; i < 31; i++) list.push(central(now - i * 864e5).date);
  if (range === "today") return list.slice(0, 1);
  if (range === "week") { const wd = new Date(new Date().toLocaleString("en-US", { timeZone: TZ })).getDay(); return list.slice(0, ((wd + 6) % 7) + 1); }
  const m = list[0].slice(0, 7); return list.filter(d => d.startsWith(m));
}

export default async (req) => {
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, "");
  const db = getStore({ name: "calls", consistency: "strong" });

  if (path === "/api/calls" && req.method === "POST") {
    if (!allowed(req)) return json({ error: "forbidden" }, 403);
    let b; try { b = await req.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
    if (!b || !UID.test(String(b.uid || "")) || !b.call) return json({ error: "bad_request" }, 400);
    const t = Number(b.call.t) || Date.now();
    if (Math.abs(Date.now() - t) > 3 * 864e5) return json({ error: "bad_time" }, 400);
    const { date, hour } = central(t);
    const c = { t, hour, lead: str(b.call.lead, 40) || "Other", contact: !!b.call.contact, appt: APPT.has(b.call.appt) ? b.call.appt : "no", label: str(b.call.label, 80), now: !!b.call.now };
    if (!c.contact) c.appt = "no";
    const sumKey = "agent/" + b.uid, dayKey = `day/${date}/${b.uid}`;
    const sum = (await db.get(sumKey, { type: "json" })) || { uid: b.uid, days: {} };
    sum.name = str(b.name, 80) || sum.name || ""; sum.invite = str(b.invite, 64) || sum.invite || ""; sum.updatedAt = new Date().toISOString();
    sum.days[date] = sum.days[date] || blankDay(); add(sum.days[date], c, 1);
    const day = (await db.get(dayKey, { type: "json" })) || { calls: [] };
    day.calls.push(c); if (day.calls.length > 600) day.calls = day.calls.slice(-600);
    await Promise.all([db.setJSON(sumKey, sum), db.setJSON(dayKey, day)]);
    return json({ ok: true, today: sum.days[date], date, hour });
  }

  if (path === "/api/calls/undo" && req.method === "POST") {
    if (!allowed(req)) return json({ error: "forbidden" }, 403);
    let b; try { b = await req.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
    if (!b || !UID.test(String(b.uid || ""))) return json({ error: "bad_request" }, 400);
    const { date } = central(Date.now());
    const sumKey = "agent/" + b.uid, dayKey = `day/${date}/${b.uid}`;
    const [sum, day] = await Promise.all([db.get(sumKey, { type: "json" }), db.get(dayKey, { type: "json" })]);
    if (!sum || !day || !day.calls.length) return json({ error: "nothing_to_undo" }, 400);
    const c = day.calls.pop(); add(sum.days[date], c, -1);
    await Promise.all([db.setJSON(sumKey, sum), db.setJSON(dayKey, day)]);
    return json({ ok: true, removed: c, today: sum.days[date] });
  }

  if (path === "/api/calls/me" && req.method === "GET") {
    const uid = url.searchParams.get("uid") || "";
    if (!UID.test(uid)) return json({ error: "bad_request" }, 400);
    const { date, hour } = central(Date.now());
    const [sum, day] = await Promise.all([db.get("agent/" + uid, { type: "json" }), db.get(`day/${date}/${uid}`, { type: "json" })]);
    return json({ date, hour, days: (sum && sum.days) || {}, todayCalls: (day && day.calls) || [] });
  }

  if (path === "/api/calls/day" && req.method === "GET") {
    const uid = url.searchParams.get("uid") || "", date = url.searchParams.get("date") || "";
    if (!UID.test(uid) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "bad_request" }, 400);
    const day = await db.get(`day/${date}/${uid}`, { type: "json" });
    return json({ date, calls: (day && day.calls) || [] });
  }

  const allSummaries = async () => {
    const { blobs } = await db.list({ prefix: "agent/" });
    return (await Promise.all(blobs.map(x => db.get(x.key, { type: "json" }).catch(() => null)))).filter(Boolean);
  };

  if (path === "/api/calls/board" && req.method === "GET") {
    const range = ["today", "week", "month"].includes(url.searchParams.get("range")) ? url.searchParams.get("range") : "today";
    const dates = rangeDates(range);
    const [sums, invList, mgrList] = await Promise.all([
      allSummaries(),
      (async () => { const s = getStore({ name: "invites", consistency: "strong" }); const { blobs } = await s.list(); return (await Promise.all(blobs.map(x => s.get(x.key, { type: "json" }).catch(() => null)))).filter(Boolean); })(),
      (async () => { const s = managersStore(); const { blobs } = await s.list(); return (await Promise.all(blobs.map(x => s.get(x.key, { type: "json" }).catch(() => null)))).filter(Boolean); })()
    ]);
    const inv = Object.fromEntries(invList.map(i => [i.token, i])), mg = Object.fromEntries(mgrList.map(m => [m.id, m]));
    const agents = sums.map(s => {
      const tot = { total: 0, contacts: 0, appts: 0 };
      dates.forEach(d => { const x = s.days[d]; if (x) { tot.total += x.total; tot.contacts += x.contacts; tot.appts += x.appts; } });
      const m = s.invite && inv[s.invite] ? mg[inv[s.invite].managerId] : null;
      return { uid: s.uid, name: shortName(s.name), team: m ? m.name : "", ...tot };
    }).filter(a => a.total > 0).sort((a, b) => b.appts - a.appts || b.contacts - a.contacts || b.total - a.total);
    const teams = {};
    agents.forEach(a => { const k = a.team || "Unassigned"; teams[k] = teams[k] || { name: k, agents: 0, total: 0, contacts: 0, appts: 0 }; const t = teams[k]; t.agents++; t.total += a.total; t.contacts += a.contacts; t.appts += a.appts; });
    return json({ range, agents: agents.map(({ uid, ...r }) => ({ ...r, me: uid === url.searchParams.get("uid") })), teams: Object.values(teams).sort((a, b) => b.appts - a.appts || b.total - a.total) });
  }

  if (path === "/api/calls/team" && req.method === "GET") {
    if (!(await authManager(req))) return json({ error: "signed_out" }, 401);
    const { date, hour } = central(Date.now());
    return json({ date, hour, weekDates: rangeDates("week"), monthDates: rangeDates("month"), agents: (await allSummaries()).map(s => ({ uid: s.uid, name: s.name, invite: s.invite, updatedAt: s.updatedAt, days: s.days })) });
  }

  return json({ error: "not_found" }, 404);
};

export const config = { path: ["/api/calls", "/api/calls/*"] };
