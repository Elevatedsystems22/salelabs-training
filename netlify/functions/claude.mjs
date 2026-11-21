/* The AI family brain and the grader. Streams plain text back to the course.
   Needs the environment variable ANTHROPIC_API_KEY.
   Optional: MODEL_FAMILY (the AI family on practice calls and exams; default Sonnet), MODEL_FAST (drills and quick checks; default Haiku)
   and MODEL_SMART (final call grading; default Sonnet).
   The family's instructions are sent as a cached "system" block so each turn of a call only pays full price for the new part. */
import { allowed, json } from "../lib/guard.mjs";

const MAX_PROMPT = 120000;

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!allowed(req)) return json({ error: "forbidden" }, 403);
  if (!process.env.ANTHROPIC_API_KEY) return json({ error: "missing_key", message: "ANTHROPIC_API_KEY is not set in Netlify." }, 500);
  let body;
  try { body = await req.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
  const prompt = String(body.prompt || "");
  if (!prompt || prompt.length > MAX_PROMPT) return json({ error: "bad_request" }, 400);
  const smart = body.tier === "complex", family = body.tier === "family";
  const model = smart ? (process.env.MODEL_SMART || "claude-sonnet-5-5") : family ? (process.env.MODEL_FAMILY || "claude-sonnet-5-5") : (process.env.MODEL_FAST || "claude-haiku-5-5");
  const system = typeof body.system === "string" && body.system.length && body.system.length <= MAX_PROMPT ? [{ type: "text", text: body.system, cache_control: { type: "ephemeral" } }] : undefined;

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: smart ? 4000 : 1200, stream: true, ...(system ? { system } : {}), messages: [{ role: "user", content: prompt }] }),
    signal: req.signal
  });
  if (!upstream.ok || !upstream.body) {
    const status = upstream.status === 429 ? 429 : 502;
    return json({ error: status === 429 ? "rate_limited" : "upstream_error", detail: (await upstream.text()).slice(0, 500) }, status);
  }

  const enc = new TextEncoder(), dec = new TextDecoder();
  const reader = upstream.body.getReader();
  const out = new ReadableStream({
    async start(controller) {
      let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line.startsWith("data:")) continue;
            try {
              const ev = JSON.parse(line.slice(5));
              if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") controller.enqueue(enc.encode(ev.delta.text));
            } catch (e) {}
          }
        }
      } catch (e) {}
      controller.close();
    },
    cancel() { try { reader.cancel(); } catch (e) {} }
  });
  return new Response(out, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
};

export const config = { path: "/api/claude" };
