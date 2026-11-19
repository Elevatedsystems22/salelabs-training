/* Managers, manager logins and agent invites.
   Public:
     GET  /api/invite?token=…            the invited agent's details + their manager's card
     POST /api/team/login                 {email, password} -> {token, manager}
   Signed in (Authorization: Bearer <token>):
     GET    /api/team                     managers and invites
     GET    /api/team/me                  your own record
     POST   /api/team/password            change your password {current, next}
     POST   /api/team/manager             add a manager, or edit yourself (admins can edit anyone)
     POST   /api/team/invite              create an invite {first, last, phone, email, managerId}
     DELETE /api/team/invite?token=…
   Admins only:
     POST   /api/team/password/reset      {id, temp} sets a temporary password; they pick their own at next sign-in
     DELETE /api/team/manager?id=…
   First sign-in for an admin with no password yet: their email + MANAGER_CODE, then they set a password. */
import { getStore } from "@netlify/blobs";
import { randomBytes } from "node:crypto";
import { json } from "../lib/guard.mjs";
import { hashPw, checkPw, safeEq, makeToken, authManager, managersStore, publicMgr } from "../lib/auth.mjs";
import { notify, agentInviteMsg, managerWelcomeMsg } from "../lib/notify.mjs";

const TOKEN = /^[A-Za-z0-9_-]{8,64}$/;
const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const PHOTO = /^(data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+|\/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp))$/;

const SEEDS = [
  { id: "brandon-carter", name: "Brandon Carter", position: "RAD (Regional Agency Director)", phone: "251-725-4263", email: "blcarter@globe.life", photo: "/brandon-carter.jpg", admin: true },
  { id: "nathan-sedgeway", name: "Nathan Sedgeway", position: "GA (General Agent)", phone: "251-802-5045", email: "nathansedgeway@gmail.com", photo: "/nathan-sedgeway.jpg", admin: false, reportsTo: "brandon-carter" }
];

async function allJSON(store) {
  const { blobs } = await store.list();
  const rows = await Promise.all(blobs.map(b => store.get(b.key, { type: "json" }).catch(() => null)));
  return rows.filter(Boolean);
}
async function managersList(mgrs) {
  let rows = await allJSON(mgrs);
  if (!rows.length) {
    rows = SEEDS.map((m, i) => ({ ...m, createdAt: new Date(Date.now() + i).toISOString(), confirmedAt: "", v: 0 }));
    await Promise.all(rows.map(m => mgrs.setJSON(m.id, m)));
  }
  const nate = rows.find(r => r.id === "nathan-sedgeway");
  if (nate && nate.reportsTo === undefined && rows.some(r => r.id === "brandon-carter")) { nate.reportsTo = "brandon-carter"; await mgrs.setJSON(nate.id, nate); }
  if (!rows.some(r => r.admin)) { const b = rows.find(r => r.id === "brandon-carter"); if (b) { b.admin = true; await mgrs.setJSON(b.id, b); } }
  return rows.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
}
const cardOf = m => m ? { name: m.name, position: m.position, phone: m.phone, email: m.email, photo: m.photo } : null;
const pwOk = p => typeof p === "string" && p.length >= 8 && p.length <= 200;

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const mgrs = managersStore();
  const invites = getStore({ name: "invites", consistency: "strong" });
  const body = async () => { try { return await req.json(); } catch (e) { return null; } };
  const inviteUrl = t => url.origin + "/?invite=" + encodeURIComponent(t);
  const managerUrl = url.origin + "/#manager";
  const sendInvite = async inv => {
    const m = inv.managerId ? await mgrs.get(inv.managerId, { type: "json" }).catch(() => null) : null;
    return notify(agentInviteMsg({ first: inv.first, last: inv.last, phone: inv.phone, email: inv.email, link: inviteUrl(inv.token), manager: m }));
  };
  const sendManager = (m, temp, reset) => { const [first, ...rest] = String(m.name || "").split(" "); return notify(managerWelcomeMsg({ first, last: rest.join(" "), phone: m.phone, email: m.email, link: managerUrl, temp, reset })); };

  if (path === "/api/invite" && req.method === "GET") {
    const token = url.searchParams.get("token") || "";
    if (!TOKEN.test(token)) return json({ error: "bad_request" }, 400);
    const inv = await invites.get(token, { type: "json" });
    if (!inv) return json({ error: "not_found" }, 404);
    const all = await managersList(mgrs), byId = Object.fromEntries(all.map(m => [m.id, m]));
    const upline = [], seen = new Set();
    for (let cur = byId[inv.managerId]; cur && !seen.has(cur.id) && upline.length < 8; cur = byId[cur.reportsTo]) { seen.add(cur.id); upline.push(cardOf(cur)); }
    return json({ invite: { token: inv.token, first: inv.first, last: inv.last, phone: inv.phone, email: inv.email }, manager: upline[0] || null, upline });
  }
  if (!path.startsWith("/api/team")) return json({ error: "not_found" }, 404);
  if (!process.env.MANAGER_CODE && !process.env.SESSION_SECRET) return json({ error: "missing_code", message: "MANAGER_CODE is not set in Netlify." }, 500);

  if (path === "/api/team/login" && req.method === "POST") {
    const b = await body(); if (!b) return json({ error: "bad_request" }, 400);
    const email = str(b.email, 120).toLowerCase(), pw = String(b.password || "");
    const rows = await managersList(mgrs);
    const rec = rows.find(r => String(r.email || "").toLowerCase() === email);
    const fail = json({ error: "bad_login", message: "That email and password don't match." }, 401);
    if (!rec || !pw) return fail;
    if (rec.lockUntil && Date.parse(rec.lockUntil) > Date.now()) return json({ error: "locked", message: "Too many tries. Wait 10 minutes and try again." }, 429);
    let ok = false, bootstrap = false;
    if (rec.pwHash) ok = checkPw(pw, rec.pwHash);
    else if (rec.admin && process.env.MANAGER_CODE && safeEq(pw, process.env.MANAGER_CODE)) { ok = true; bootstrap = true; }
    if (!ok) {
      const fails = (rec.fails || 0) + 1;
      await mgrs.setJSON(rec.id, { ...rec, fails: fails >= 5 ? 0 : fails, lockUntil: fails >= 5 ? new Date(Date.now() + 10 * 60000).toISOString() : "" });
      return rec.pwHash || rec.admin ? fail : json({ error: "no_password", message: "You don't have a password yet. Ask your admin to set one up for you." }, 401);
    }
    const next = { ...rec, fails: 0, lockUntil: "", mustChange: bootstrap ? true : !!rec.mustChange, lastLogin: new Date().toISOString() };
    await mgrs.setJSON(rec.id, next);
    return json({ token: makeToken(rec.id, rec.v || 0), manager: publicMgr(next) });
  }

  const me = await authManager(req);
  if (!me) return json({ error: "signed_out", message: "Your sign-in expired. Sign in again." }, 401);
  const isAdmin = !!me.admin;

  if (path === "/api/team" && req.method === "GET") {
    const [m, i] = await Promise.all([managersList(mgrs), allJSON(invites)]);
    return json({ me: me.id === "_master" ? null : publicMgr(me), managers: m.map(publicMgr), invites: i.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")) });
  }
  if (path === "/api/team/me" && req.method === "GET") return json({ me: publicMgr(me) });

  if (path === "/api/team/password" && req.method === "POST") {
    if (me.id === "_master") return json({ error: "bad_request" }, 400);
    const b = await body(); if (!b) return json({ error: "bad_request" }, 400);
    if (!pwOk(b.next)) return json({ error: "weak", message: "Use at least 8 characters." }, 400);
    if (!me.mustChange && !(me.pwHash && checkPw(String(b.current || ""), me.pwHash))) return json({ error: "bad_current", message: "Your current password isn't right." }, 400);
    const rec = { ...me, pwHash: hashPw(b.next), mustChange: false, v: (me.v || 0) + 1 };
    await mgrs.setJSON(me.id, rec);
    return json({ token: makeToken(rec.id, rec.v), manager: publicMgr(rec) });
  }

  if (path === "/api/team/password/reset" && req.method === "POST") {
    if (!isAdmin) return json({ error: "forbidden", message: "Only an admin can set passwords." }, 403);
    const b = await body(); if (!b) return json({ error: "bad_request" }, 400);
    if (!pwOk(b.temp)) return json({ error: "weak", message: "Use at least 8 characters." }, 400);
    const rec = await mgrs.get(str(b.id, 64), { type: "json" });
    if (!rec) return json({ error: "not_found" }, 404);
    const next = { ...rec, pwHash: hashPw(b.temp), mustChange: true, v: (rec.v || 0) + 1, fails: 0, lockUntil: "" };
    await mgrs.setJSON(rec.id, next);
    const notified = b.send === false ? { sent: false, reason: "skipped" } : await sendManager(next, b.temp, !!rec.pwHash);
    return json({ manager: publicMgr(next), notified });
  }

  if (path === "/api/team/manager" && req.method === "POST") {
    const b = await body(); if (!b) return json({ error: "bad_request" }, 400);
    const name = str(b.name, 80);
    if (!name) return json({ error: "bad_request", message: "Name is required." }, 400);
    const photo = str(b.photo, 400000);
    if (photo && !PHOTO.test(photo)) return json({ error: "bad_request", message: "That photo couldn't be saved." }, 400);
    const existing = TOKEN.test(String(b.id || "")) ? await mgrs.get(b.id, { type: "json" }) : null;
    if (existing && existing.id !== me.id && !isAdmin) return json({ error: "forbidden", message: "You can only edit your own card. Ask an admin to change someone else's." }, 403);
    const email = str(b.email, 120).toLowerCase();
    if (email) { const clash = (await allJSON(mgrs)).find(r => String(r.email || "").toLowerCase() === email && (!existing || r.id !== existing.id)); if (clash) return json({ error: "dup", message: "Another manager already uses that email." }, 400); }
    const id = existing ? existing.id : name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) + "-" + randomBytes(3).toString("hex");
    const prev = existing || {};
    const rec = { ...prev, id, name, position: str(b.position, 60), phone: str(b.phone, 30), email, photo: photo || prev.photo || "",
      admin: isAdmin && typeof b.admin === "boolean" && id !== me.id ? b.admin : !!prev.admin,
      reportsTo: b.reportsTo !== undefined ? (str(b.reportsTo, 64) === id ? "" : str(b.reportsTo, 64)) : (prev.reportsTo || ""),
      createdAt: prev.createdAt || new Date().toISOString(), confirmedAt: b.confirm && id === me.id ? new Date().toISOString() : (prev.confirmedAt || ""), v: prev.v || 0 };
    let notified = null;
    if (!existing && isAdmin && pwOk(b.temp)) { rec.pwHash = hashPw(b.temp); rec.mustChange = true; }
    await mgrs.setJSON(id, rec);
    if (!existing && rec.pwHash && b.send !== false) notified = await sendManager(rec, b.temp, false);
    return json({ manager: publicMgr(rec), notified });
  }

  if (path === "/api/team/manager" && req.method === "DELETE") {
    if (!isAdmin) return json({ error: "forbidden", message: "Only an admin can remove managers." }, 403);
    const id = url.searchParams.get("id") || "";
    if (!TOKEN.test(id) || id === me.id) return json({ error: "bad_request", message: "You can't remove yourself." }, 400);
    await mgrs.delete(id);
    return json({ ok: true });
  }

  if (path === "/api/team/invite" && req.method === "POST") {
    const b = await body(); if (!b) return json({ error: "bad_request" }, 400);
    const first = str(b.first, 40), last = str(b.last, 40);
    if (!first || !last) return json({ error: "bad_request", message: "First and last name are required." }, 400);
    const token = randomBytes(12).toString("base64url");
    const rec = { token, first, last, phone: str(b.phone, 30), email: str(b.email, 120), managerId: str(b.managerId, 64), invitedBy: me.id, createdAt: new Date().toISOString(), acceptedAt: "", uid: "" };
    await invites.setJSON(token, rec);
    const notified = b.send === false ? { sent: false, reason: "skipped" } : await sendInvite(rec);
    return json({ invite: rec, notified });
  }
  if (path === "/api/team/invite/resend" && req.method === "POST") {
    const b = await body(); const t = b && String(b.token || "");
    if (!TOKEN.test(t)) return json({ error: "bad_request" }, 400);
    const inv = await invites.get(t, { type: "json" });
    if (!inv) return json({ error: "not_found" }, 404);
    return json({ notified: await sendInvite(inv) });
  }
  if (path === "/api/team/invite" && req.method === "DELETE") {
    const token = url.searchParams.get("token") || "";
    if (!TOKEN.test(token)) return json({ error: "bad_request" }, 400);
    await invites.delete(token);
    return json({ ok: true });
  }
  return json({ error: "method_not_allowed" }, 405);
};

export const config = { path: ["/api/team", "/api/team/*", "/api/invite"] };
