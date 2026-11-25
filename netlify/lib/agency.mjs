/* Turning a paid Stripe checkout into an agency (new signup) or more seats (existing agency).
   Called by the Stripe webhook and by the return page, whichever gets there first; each session is only fulfilled once. */
import { getStore } from "@netlify/blobs";
import { randomBytes } from "node:crypto";
import { hashPw, managersStore } from "./auth.mjs";
import { agenciesStore } from "./org.mjs";
import { notify, managerWelcomeMsg } from "./notify.mjs";

export const pendingStore = () => getStore({ name: "agencypending", consistency: "strong" });
const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const slug = s => String(s || "agency").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "agency";
export const tempPassword = () => "Seat-" + randomBytes(3).toString("hex") + "-" + randomBytes(2).toString("hex");

export async function fulfillAgency(session, origin) {
  if (!session || session.payment_status !== "paid") return { ok: false };
  const md = session.metadata || {};
  if (md.type !== "agency_new" && md.type !== "seats") return { ok: false, skip: true };
  const mark = "fulfilled/" + session.id, ag = agenciesStore();
  const done = await ag.get(mark, { type: "json" }).catch(() => null);
  if (done) return { ok: true, already: true, ...done };
  const qty = Math.min(500, Math.max(1, parseInt(md.qty, 10) || 1)), paid = { at: Date.now(), qty, cents: session.amount_total || 0, session: session.id };

  if (md.type === "seats") {
    const org = await ag.get("org/" + str(md.org, 80), { type: "json" }).catch(() => null);
    if (!org) return { ok: false };
    org.seats = (org.seats || 0) + qty; org.purchases = [paid, ...(org.purchases || [])].slice(0, 200);
    await ag.setJSON("org/" + org.id, org);
    const res = { type: "seats", org: org.id, name: org.name, added: qty, seats: org.seats };
    await ag.setJSON(mark, res);
    return { ok: true, ...res };
  }

  // New agency: create the agency, then its owner's manager login with a temporary password.
  const p = await pendingStore().get(str(md.pending, 80), { type: "json" }).catch(() => null);
  if (!p) return { ok: false };
  const mgrs = managersStore(), { blobs } = await mgrs.list();
  const all = (await Promise.all(blobs.map(b => mgrs.get(b.key, { type: "json" }).catch(() => null)))).filter(Boolean);
  const clash = all.find(m => String(m.email || "").toLowerCase() === p.email);
  if (clash && clash.org) {
    // Already an agency owner or manager: add the seats to their agency instead of making a second one.
    const org = await ag.get("org/" + clash.org, { type: "json" }).catch(() => null);
    if (org) {
      org.seats = (org.seats || 0) + qty; org.purchases = [paid, ...(org.purchases || [])].slice(0, 200);
      await ag.setJSON("org/" + org.id, org);
      const res = { type: "seats", org: org.id, name: org.name, added: qty, seats: org.seats, email: p.email };
      await ag.setJSON(mark, res);
      return { ok: true, ...res };
    }
  }
  const id = slug(p.agencyName) + "-" + randomBytes(3).toString("hex"), temp = tempPassword();
  const ownerId = slug(p.ownerName) + "-" + randomBytes(3).toString("hex");
  const org = { id, name: p.agencyName, ownerId, seats: qty, seatsUsed: 0, createdAt: new Date().toISOString(), purchases: [paid], contact: { name: p.ownerName, email: p.email, phone: p.phone } };
  const owner = { id: ownerId, name: p.ownerName, position: "AO (Agency Owner)", phone: p.phone, email: clash ? "" : p.email, photo: "", admin: true, reportsTo: "", org: id,
    pwHash: hashPw(temp), mustChange: true, createdAt: new Date().toISOString(), confirmedAt: "", v: 0 };
  await ag.setJSON("org/" + id, org);
  await mgrs.setJSON(ownerId, owner);
  const [first, ...rest] = String(p.ownerName).split(" ");
  const notified = await notify(managerWelcomeMsg({ first, last: rest.join(" "), phone: p.phone, email: p.email, link: origin + "/#manager", temp, reset: false }));
  const res = { type: "agency_new", org: id, name: org.name, seats: qty, email: p.email, emailTaken: !!clash, notified: !!notified.sent };
  await ag.setJSON(mark, res);
  // The return page shows the temporary password once, as a backup to the text and email.
  await pendingStore().setJSON(str(md.pending, 80), { ...p, fulfilled: true, temp, shown: false, org: id });
  return { ok: true, ...res };
}
