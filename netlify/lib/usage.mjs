/* Cost meter: every AI charge is added to a running total for the month, per trainee.
   Totals live in the "costs" blob store under "<YYYY-MM>/<uid>". Only the owner can read them (see functions/usage.mjs). */
import { getStore } from "@netlify/blobs";

export const costsStore = () => getStore({ name: "costs", consistency: "strong" });

// Claude list prices, USD per million tokens. Override with CLAUDE_PRICES='{"model":[in,cacheWrite,cacheRead,out]}' if Anthropic changes them.
const PRICES = {
  "claude-sonnet-5-5": [2, 2.5, 0.1, 10],
  "claude-haiku-5-5": [0.1, 0.125, 0.01, 0.5],
  "claude-opus-5-5": [4, 5, 0.2, 20]
};
export function claudePrice(model) {
  try { const o = JSON.parse(process.env.CLAUDE_PRICES || "{}"); if (o[model]) return o[model]; } catch (e) {}
  return PRICES[model] || PRICES["claude-sonnet-5-5"];
}

export function chicagoMonth(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit" }).formatToParts(d);
  return p.find(x => x.type === "year").value + "-" + p.find(x => x.type === "month").value;
}
const cleanUid = u => String(u || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "unknown";

/* who: { uid, name }. add: numbers to add, e.g. { claudeIn: 1200, claudeOut: 90, claudeCost: 0.003 } */
export async function addUsage(who, add) {
  try {
    const store = costsStore(), key = chicagoMonth() + "/" + cleanUid(who && who.uid);
    const cur = (await store.get(key, { type: "json" }).catch(() => null)) || { uid: cleanUid(who && who.uid), name: "", calls: 0 };
    if (who && who.name) cur.name = String(who.name).slice(0, 80);
    for (const [k, v] of Object.entries(add)) if (Number.isFinite(v)) cur[k] = (cur[k] || 0) + v;
    cur.updatedAt = new Date().toISOString();
    await store.setJSON(key, cur);
  } catch (e) {}
}

/* Who is asking, from headers the course sends (or query params on audio links). */
export function whoFrom(req) {
  const u = new URL(req.url);
  let name = req.headers.get("x-vpa-name") || u.searchParams.get("n") || "";
  try { name = decodeURIComponent(name); } catch (e) {}
  return { uid: req.headers.get("x-vpa-uid") || u.searchParams.get("u") || "", name };
}
