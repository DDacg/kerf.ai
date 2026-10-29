// Kerf AI chat: turns what the user typed into a reply plus an edit plan the browser carries out.
// Needs the Supabase secret ANTHROPIC_API_KEY. Without it, the site falls back to its built-in planner.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SYSTEM = `You are Kerf AI, an AI video and photo editor inside a web app. People upload clips or photos and describe edits in plain English (or Portuguese, Spanish, etc.).
Be brief, warm and concrete. Answer in the user's language. Never mention code, libraries, models or tools by name.

What the editor can do right now:
VIDEO: captions (styles: "glassy" frosted card, "bold" big word-by-word with yellow highlight, "clean" simple white), cutting pauses/silences, punch-in zooms on key lines.
PHOTO: brightness, contrast, saturation, warmth, vignette, sharpness, black and white, crop to 4:5, 1:1, 9:16 or 16:9.
Things like b-roll, music, motion graphics, face tracking and reframing are coming soon: if asked, say so kindly and do what you can now.

Reply with ONLY one JSON object, no other text:
{"reply":"1-3 short sentences to the user about what you will do or your answer",
 "video":{"captions":"glassy|bold|clean|none","cut_pauses":true|false,"zooms":true|false,"language":"auto|en|pt|es|fr|de|it"} or null,
 "photo":{"edits":[{"brightness":1.0,"contrast":1.0,"saturation":1.0,"warmth":0,"vignette":0,"sharpen":0,"bw":false,"crop":"original"}]} or null}
Rules: include "video" only when a video is attached; include "photo" only when photos are attached (one edits entry per photo, in order).
Ranges: brightness 0.6-1.5, contrast 0.6-1.6, saturation 0-1.8, warmth -1..1, vignette 0..1, sharpen 0..1, crop original|4:5|1:1|9:16|16:9.
If the user asks for captions without a style, use "glassy". Keep photos natural unless asked for something bold.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ error: "no_key" }, 503);

  // Who is asking? Only admins and people with credits can use the AI.
  const auth = req.headers.get("Authorization") ?? "";
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data: u } = await db.auth.getUser();
  if (!u?.user) return json({ error: "sign_in" }, 401);
  const { data: profile } = await db.from("profiles").select("is_admin, credits").eq("id", u.user.id).maybeSingle();
  if (!profile || (!profile.is_admin && profile.credits <= 0)) return json({ error: "no_credits" }, 402);

  let body: { messages?: { role: string; content: string }[]; images?: { media_type: string; data: string }[] };
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const turns = (body.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!turns.length || turns[turns.length - 1].role !== "user") return json({ error: "no_message" }, 400);
  while (turns.length && turns[0].role !== "user") turns.shift();

  const images = (body.images ?? []).slice(0, 4).filter((i) => /^image\/(jpeg|png|webp|gif)$/.test(i.media_type) && i.data.length < 6_000_000);
  const last = turns[turns.length - 1];
  const messages = [
    ...turns.slice(0, -1),
    {
      role: "user",
      content: [
        ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: i.data } })),
        { type: "text", text: last.content },
      ],
    },
  ];

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: Deno.env.get("KERF_MODEL") ?? "claude-sonnet-5-5", max_tokens: 900, system: SYSTEM, messages }),
  });
  if (!r.ok) {
    console.error("anthropic error", r.status, (await r.text()).slice(0, 500));
    return json({ error: "ai_failed" }, 502);
  }
  const out = await r.json();
  const text: string = (out.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
  let plan: Record<string, unknown> = {};
  try {
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    plan = JSON.parse(text.slice(a, b + 1));
  } catch {
    plan = { reply: text.trim() || "Done." };
  }
  return json({ reply: String(plan.reply ?? ""), video: plan.video ?? null, photo: plan.photo ?? null });
});
