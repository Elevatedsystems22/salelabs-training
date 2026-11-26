/* Agencies (orgs). Brandon's own team is the default agency (org ""), so all data from before agencies existed stays his.
   Every other agency owner buys seats, and their managers, invites and trainees only ever see their own agency. */
import { getStore } from "@netlify/blobs";

export const agenciesStore = () => getStore({ name: "agencies", consistency: "strong" });
export const orgOf = me => (me && me.org) || "";
// Test agencies are made from the owner-only test page (/test): $1 seats and cheap extra calls, for trying payments and texts end to end.
export const TEST_SEAT_CENTS = 100, TEST_CALL_CENTS = 20;
export async function orgIsTest(id) { if (!id) return false; const o = await agenciesStore().get("org/" + id, { type: "json" }).catch(() => null); return !!(o && o.test); }
export const isOwner = me => !!me && (me.id === "_master" || me.id === (process.env.OWNER_MANAGER_ID || "brandon-carter"));

export async function inviteMap() {
  const s = getStore({ name: "invites", consistency: "strong" }), { blobs } = await s.list();
  const rows = await Promise.all(blobs.map(b => s.get(b.key, { type: "json" }).catch(() => null)));
  return Object.fromEntries(rows.filter(Boolean).map(i => [i.token, i]));
}
/* Which agency a trainee record belongs to: the agency of the invite it came in on; anyone without an invite is on Brandon's team. */
export const rowOrg = (row, inv) => { const i = row && row.invite && inv[row.invite]; return i ? (i.org || "") : ""; };
export const inScope = (row, me, inv) => rowOrg(row, inv) === orgOf(me);
/* Same, for a credits account id ("inv_<token>" or "uid_<id>"). */
export const accountOrg = (acct, inv) => { const m = /^inv_(.+)$/.exec(acct || ""); return m && inv[m[1]] ? (inv[m[1]].org || "") : ""; };
