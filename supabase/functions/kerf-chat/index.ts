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

const SYSTEM = `You are Kerf AI, an AI video and photo editor inside a web app. People upload clips or photos and describe edits in plain language (English, Portuguese, Spanish...).
Talk like a friendly, skilled human editor: brief, warm, concrete. Answer in the user's language. Never mention code, libraries, models or tools by name.

What the editor can do right now:
VIDEO
- Join several clips into one video, in any order ("order" is the list of clip numbers, starting at 0).
- Captions, 6 styles: "glassy" (frosted glass card), "bold" (big uppercase word-by-word, spoken word in a color), "pop" (one big word at a time that pops in, MrBeast/Hormozi style), "highlight" (spoken word inside a colored box, TikTok style), "clean" (simple white subtitles), "elegant" (italic serif, aesthetic). Or "none".
- Caption position: bottom, middle or top. Caption color: a hex like #FFD43B (used by bold, pop and highlight).
- Cut pauses and silences. Punch-in zooms on key lines.
- Format: original, 9:16 (vertical), 1:1, 16:9, 4:5 (center crop).
- Color look: none, warm, cool, bw, vivid, cinematic.
- Captions translated to English ("translate": true).
PHOTO: brightness, contrast, saturation, warmth, vignette, sharpness, black and white, crop to 4:5, 1:1, 9:16 or 16:9.
Coming soon (say so kindly if asked, and do what you can now): music, sound effects, b-roll, motion graphics, face tracking, trimming exact times. Filler words are removed automatically in Pro mode.

Each user message may end with a bracket note saying which files are attached, or (when no files are attached) the settings of the previous video edit in this chat.
The user may pick Quick or Pro mode; in Pro mode a second editor pass adds a hook title, highlighted words, smart zooms and filler-word cuts automatically, so you only set the main settings.
Follow-ups change the previous video: start from the previous settings and change ONLY what the user asks. If the user asks something without wanting a new render (a question, thanks), set "video" to null.
If the user asks for something vague like "edit this" on a new video, choose a strong default: glassy or bold captions, cut pauses, zooms.
Never pick a caption style the user did not ask for when they named one. Respect "no captions".

Reply with ONLY one JSON object, no other text:
{"reply":"1-2 short sentences about what you are doing, or your answer",
 "video":{"captions":"glassy|bold|pop|highlight|clean|elegant|none","caption_position":"bottom|middle|top","caption_color":"#RRGGBB","cut_pauses":true|false,"zooms":true|false,"format":"original|9:16|1:1|16:9|4:5","look":"none|warm|cool|bw|vivid|cinematic","order":[0,1],"language":"auto|en|pt|es|fr|de|it","translate":true|false} or null,
 "photo":{"edits":[{"brightness":1.0,"contrast":1.0,"saturation":1.0,"warmth":0,"vignette":0,"sharpen":0,"bw":false,"crop":"original"}]} or null}
Include "video" when a video is attached or when the user wants a change to the previous video. Include "photo" only when photos are attached (one edits entry per photo, in order).
Ranges: brightness 0.6-1.5, contrast 0.6-1.6, saturation 0-1.8, warmth -1..1, vignette 0..1, sharpen 0..1. Keep photos natural unless asked for something bold.`;

const DIRECT = `You are the lead editor at Kerf AI, planning a short-form video edit from its transcript.
You get the user's request, the current edit settings, and the transcript as [index, word, start_seconds].
Return ONLY one JSON object:
{"hook":"a punchy title for the first 2-3 seconds, max 6 words, in the video's language, or \"\" if a title would not fit or the user does not want text",
 "emphasis":[indices of the key words to color: numbers, money, results, the one word that carries each sentence; about 1 per sentence, never more than 15% of words],
 "zooms":[indices where a punch-in zoom should land, on the strongest moments, at least 3 seconds apart; none if the user does not want zooms],
 "cut":[indices of filler words and stumbles to remove: um, uh, er, "like" or "tipo" or "né" used as filler, repeated words, false starts. Never cut a word that carries meaning],
 "reply":"one short sentence in the user's language about the creative choices"}
Think like a top TikTok/Reels editor: the hook should make people stay, highlights should make the message easy to follow at a glance.`;

async function claude(key: string, model: string, system: string, messages: unknown[], max_tokens: number) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens, system, messages }),
  });
  if (!r.ok) {
    console.error("anthropic error", r.status, (await r.text()).slice(0, 500));
    return null;
  }
  const out = await r.json();
  const text: string = (out.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
  try {
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    return JSON.parse(text.slice(a, b + 1)) as Record<string, unknown>;
  } catch {
    return { reply: text.trim() || "Done." } as Record<string, unknown>;
  }
}

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

  let body: {
    messages?: { role: string; content: string }[]; images?: { media_type: string; data: string }[];
    mode?: string; request?: string; plan?: unknown; words?: unknown[];
  };
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const pro = body.mode === "pro" || body.mode === "direct";
  const model = pro ? (Deno.env.get("KERF_PRO_MODEL") ?? "claude-opus-5-5") : (Deno.env.get("KERF_MODEL") ?? "claude-sonnet-5-5");

  // Pro editor pass over the transcript
  if (body.mode === "direct") {
    const words = (body.words ?? []).filter((w) => Array.isArray(w) && w.length >= 3).slice(0, 2500);
    if (!words.length) return json({ error: "no_words" }, 400);
    const text = `User request: ${String(body.request ?? "").slice(0, 2000)}\nEdit settings: ${JSON.stringify(body.plan ?? {}).slice(0, 1500)}\nTranscript words as [index, word, start_seconds]:\n${JSON.stringify(words)}`;
    const plan = await claude(key, model, DIRECT, [{ role: "user", content: text }], 2000);
    if (!plan) return json({ error: "ai_failed" }, 502);
    const ints = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < words.length) : []);
    return json({ hook: String(plan.hook ?? ""), emphasis: ints(plan.emphasis), zooms: ints(plan.zooms), cut: ints(plan.cut), reply: String(plan.reply ?? "") });
  }
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

  const plan = await claude(key, model, SYSTEM, messages, pro ? 1200 : 700);
  if (!plan) return json({ error: "ai_failed" }, 502);
  return json({ reply: String(plan.reply ?? ""), video: plan.video ?? null, photo: plan.photo ?? null });
});
