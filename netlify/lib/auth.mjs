/* Manager logins: password hashing and signed session tokens.
   Tokens are signed with SESSION_SECRET if set, otherwise MANAGER_CODE. */
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { getStore } from "@netlify/blobs";

const key = () => process.env.SESSION_SECRET || process.env.MANAGER_CODE || "";

export function hashPw(pw) {
  const salt = randomBytes(16);
  return salt.toString("hex") + ":" + scryptSync(String(pw), salt, 32).toString("hex");
}
export function checkPw(pw, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [s, h] = stored.split(":");
  const a = scryptSync(String(pw), Buffer.from(s, "hex"), 32), b = Buffer.from(h, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
export function safeEq(x, y) {
  const a = Buffer.from(String(x)), b = Buffer.from(String(y));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
export function makeToken(id, v, days = 7) {
  const p = Buffer.from(JSON.stringify({ id, v: v || 0, exp: Date.now() + days * 864e5 })).toString("base64url");
  return p + "." + createHmac("sha256", key()).update(p).digest("base64url");
}
function readToken(t) {
  if (!t || !key() || !t.includes(".")) return null;
  const [p, sig] = t.split(".");
  const want = createHmac("sha256", key()).update(p).digest("base64url");
  if (!safeEq(sig, want)) return null;
  try { const d = JSON.parse(Buffer.from(p, "base64url").toString()); return d.exp > Date.now() ? d : null; } catch (e) { return null; }
}
export const managersStore = () => getStore({ name: "managers", consistency: "strong" });

/* Returns the signed-in manager record, or null. The MANAGER_CODE header still works as a master admin key. */
export async function authManager(req) {
  const code = req.headers.get("x-manager-code") || "";
  if (code && process.env.MANAGER_CODE && safeEq(code, process.env.MANAGER_CODE)) return { id: "_master", name: "Master code", admin: true };
  const h = req.headers.get("authorization") || "";
  const d = readToken(h.startsWith("Bearer ") ? h.slice(7) : "");
  if (!d) return null;
  const rec = await managersStore().get(d.id, { type: "json" }).catch(() => null);
  if (!rec || (rec.v || 0) !== d.v) return null;
  return rec;
}
export const publicMgr = m => ({ id: m.id, name: m.name, position: m.position, phone: m.phone, email: m.email, photo: m.photo, admin: !!m.admin, reportsTo: m.reportsTo || "", hasPassword: !!m.pwHash, mustChange: !!m.mustChange, createdAt: m.createdAt, confirmedAt: m.confirmedAt || "" });
