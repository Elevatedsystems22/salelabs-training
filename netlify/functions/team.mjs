/* Managers and agent invites.
   GET    /api/invite?token=…        public: the invited agent's details + their manager's card
   GET    /api/team                   manager code: all managers and invites
   POST   /api/team/manager           manager code: add or update a manager {id?, name, position, phone, email, photo}
   DELETE /api/team/manager?id=…      manager code
   POST   /api/team/invite            manager code: create an invite {first, last, phone, email, managerId}
   DELETE /api/team/invite?token=…    manager code
   Stored in Netlify Blobs ("managers", "invites"). */
import { getStore } from "@netlify/blobs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { json } from "../lib/guard.mjs";

const TOKEN = /^[A-Za-z0-9_-]{8,64}$/;
const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const PHOTO = /^(data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+|\/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp))$/;

const SEEDS = [
  { id: "brandon-carter", name: "Brandon Carter", position: "RAD/AD", phone: "251-725-4263", email: "blcarter@globe.life", photo: "/brandon-carter.jpg" },
  { id: "nathan-sedgeway", name: "Nathan Sedgeway", position: "GA (General Agent)", phone: "251-802-5045", email: "nathansedgeway@gmail.com", photo: "/nathan-sedgeway.jpg" }
];

function codeOk(req) {
  const want = process.env.MANAGER_CODE || "";
  const got = req.headers.get("x-manager-code") || "";
  if (!want || !got) return false;
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function allJSON(store) {
  const { blobs } = await store.list();
  const rows = await Promise.all(blobs.map(b => store.get(b.key, { type: "json" }).catch(() => null)));
  return rows.filter(Boolean);
}

async function managersList(mgrs) {
  let rows = await allJSON(mgrs);
  if (!rows.length) {
    rows = SEEDS.map((m, i) => ({ ...m, createdAt: new Date(Date.now() + i).toISOString(), confirmedAt: "" }));
    await Promise.all(rows.map(m => mgrs.setJSON(m.id, m)));
  }
  return rows.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
}

const publicManager = m => m ? { name: m.name, position: m.position, phone: m.phone, email: m.email, photo: m.photo } : null;

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const mgrs = getStore({ name: "managers", consistency: "strong" });
  const invites = getStore({ name: "invites", consistency: "strong" });

  // Public invite lookup for the agent opening their link
  if (path === "/api/invite" && req.method === "GET") {
    const token = url.searchParams.get("token") || "";
    if (!TOKEN.test(token)) return json({ error: "bad_request" }, 400);
    const inv = await invites.get(token, { type: "json" });
    if (!inv) return json({ error: "not_found" }, 404);
    const m = inv.managerId ? await mgrs.get(inv.managerId, { type: "json" }) : null;
    return json({ invite: { token: inv.token, first: inv.first, last: inv.last, phone: inv.phone, email: inv.email }, manager: publicManager(m || SEEDS.find(x => x.id === inv.managerId) || null) });
  }

  if (!path.startsWith("/api/team")) return json({ error: "not_found" }, 404);
  if (!process.env.MANAGER_CODE) return json({ error: "missing_code", message: "MANAGER_CODE is not set in Netlify." }, 500);
  if (!codeOk(req)) return json({ error: "wrong_code" }, 401);

  if (path === "/api/team" && req.method === "GET") {
    const [m, i] = await Promise.all([managersList(mgrs), allJSON(invites)]);
    return json({ managers: m, invites: i.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")) });
  }

  if (path === "/api/team/manager" && req.method === "POST") {
    let b; try { b = await req.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
    const name = str(b.name, 80);
    if (!name) return json({ error: "bad_request", message: "Name is required." }, 400);
    const photo = str(b.photo, 400000);
    if (photo && !PHOTO.test(photo)) return json({ error: "bad_request", message: "That photo couldn't be saved." }, 400);
    const id = TOKEN.test(String(b.id || "")) ? b.id : name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) + "-" + randomBytes(3).toString("hex");
    const prev = (await mgrs.get(id, { type: "json" })) || {};
    const rec = { id, name, position: str(b.position, 60), phone: str(b.phone, 30), email: str(b.email, 120), photo: photo || prev.photo || "", createdAt: prev.createdAt || new Date().toISOString(), confirmedAt: b.confirm ? new Date().toISOString() : (prev.confirmedAt || "") };
    await mgrs.setJSON(id, rec);
    return json({ manager: rec });
  }

  if (path === "/api/team/manager" && req.method === "DELETE") {
    const id = url.searchParams.get("id") || "";
    if (!TOKEN.test(id)) return json({ error: "bad_request" }, 400);
    await mgrs.delete(id);
    return json({ ok: true });
  }

  if (path === "/api/team/invite" && req.method === "POST") {
    let b; try { b = await req.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
    const first = str(b.first, 40), last = str(b.last, 40);
    if (!first || !last) return json({ error: "bad_request", message: "First and last name are required." }, 400);
    const token = randomBytes(12).toString("base64url");
    const rec = { token, first, last, phone: str(b.phone, 30), email: str(b.email, 120), managerId: str(b.managerId, 64), createdAt: new Date().toISOString(), acceptedAt: "", uid: "" };
    await invites.setJSON(token, rec);
    return json({ invite: rec });
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
