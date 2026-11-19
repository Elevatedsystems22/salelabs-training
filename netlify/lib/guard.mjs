/* Only answer requests that come from this site, so other websites can't spend your API credits.
   ALLOWED_ORIGINS (optional): comma-separated extra origins, e.g. https://salelabs.site */
export function allowed(req) {
  const origin = req.headers.get("origin") || "";
  const host = req.headers.get("host") || "";
  if (!origin) return false;
  try {
    const o = new URL(origin);
    if (o.host === host) return true;
    if (/\.netlify\.app$/.test(o.host) && /\.netlify\.app$/.test(host)) return o.host.split("--").pop() === host.split("--").pop();
  } catch (e) { return false; }
  const extra = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  return extra.includes(origin);
}
export const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
