import { readFileSync } from "fs";
import { dirname } from "path";
import { parseClaudeStream } from "../brains/chat";
import { cliEnv, drainText, HttpError, killAfter, readLines, type BrainIO } from "../brains/io";
import { redactScreenText } from "./redact";

/**
 * Level 3 eyes: one window image in, one or two plain sentences out. Engines,
 * in order (EVE_SCREEN_VISION pins one):
 *
 *   gateway    AI Gateway chat completions with an image_url data URL (AI_GATEWAY_API_KEY)
 *   anthropic  Messages API with a base64 image block (ANTHROPIC_API_KEY)
 *   claude     the local claude CLI, Read tool only, pointed at the temp file (no key)
 *
 * The description is redacted again before anyone sees it. The image itself
 * is owned (and deleted) by capture.withWindowImage.
 */

export const VISION_SYSTEM = [
  "You are Eve's eyes. Eve is a witty desktop companion glancing at ONE app window on her person's screen.",
  "Describe what's in the window in at most 2 short plain sentences: the app or site, and the thing that matters (the error and file, the product and price, the headline, what the video is).",
  "Be concrete. No preamble, no markdown.",
  "Never repeat emails, phone numbers, addresses, account or card numbers, passwords, or codes.",
  "If the window is private (banking, passwords, medical, legal, intimate messages), reply with exactly: PRIVATE",
].join(" ");

export interface VisionRequest {
  imagePath: string;
  /** What the user asked, if this look is for a question ("what do you think of this"). */
  question?: string;
  /** The level-2 summary, as a hint. */
  hint?: string;
  timeoutMs?: number;
}

export interface VisionResult {
  ok: boolean;
  description: string;
  by: string;
  ms: number;
  private?: boolean;
  error?: string;
}

export interface VisionEngine {
  name: string;
  configured(): boolean;
  describe(req: VisionRequest, signal: AbortSignal): Promise<string>;
}

export const VISION_MODELS = { gateway: "anthropic/claude-haiku-4.5", anthropic: "claude-haiku-4-5-20251001", claude: "haiku" };

function userText(req: VisionRequest): string {
  const parts = ["Describe this window."];
  if (req.question) parts.push(`They just asked you: "${req.question}". Describe what they'd be asking about.`);
  if (req.hint) parts.push(`Text read from the window (may be partial): ${req.hint}`);
  return parts.join("\n");
}

const mime = (p: string) => (/\.png$/i.test(p) ? "image/png" : "image/jpeg");

export function gatewayVision(io: BrainIO): VisionEngine {
  return {
    name: "gateway",
    configured: () => !!io.secret("AI_GATEWAY_API_KEY"),
    async describe(req, signal) {
      const b64 = readFileSync(req.imagePath).toString("base64");
      const res = await io.fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${io.secret("AI_GATEWAY_API_KEY")}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: io.secret("EVE_SCREEN_VISION_MODEL") || VISION_MODELS.gateway,
          max_tokens: 160,
          temperature: 0.2,
          messages: [
            { role: "system", content: VISION_SYSTEM },
            {
              role: "user",
              content: [
                { type: "text", text: userText(req) },
                { type: "image_url", image_url: { url: `data:${mime(req.imagePath)};base64,${b64}` } },
              ],
            },
          ],
        }),
        signal,
      });
      if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ""), "vision gateway");
      const j = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
      const c = j.choices?.[0]?.message?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x as { text?: string }).text ?? "").join("") : "";
      if (!text.trim()) throw new Error("vision gateway: empty reply");
      return text;
    },
  };
}

export function anthropicVision(io: BrainIO): VisionEngine {
  return {
    name: "anthropic",
    configured: () => !!io.secret("ANTHROPIC_API_KEY"),
    async describe(req, signal) {
      const b64 = readFileSync(req.imagePath).toString("base64");
      const res = await io.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": io.secret("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: io.secret("EVE_ANTHROPIC_MODEL") || VISION_MODELS.anthropic,
          max_tokens: 160,
          system: VISION_SYSTEM,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mime(req.imagePath), data: b64 } },
                { type: "text", text: userText(req) },
              ],
            },
          ],
        }),
        signal,
      });
      if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ""), "vision anthropic");
      const j = (await res.json()) as { content?: { type: string; text?: string }[] };
      const text = (j.content ?? []).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
      if (!text.trim()) throw new Error("vision anthropic: empty reply");
      return text;
    },
  };
}

/** argv for the claude CLI look: haiku, Read tool only, only the temp dir, no MCP, no session file. */
export function claudeVisionArgs(bin: string, req: VisionRequest): string[] {
  const dir = dirname(req.imagePath);
  return [
    bin,
    "-p",
    `${userText(req)}\n\nThe window screenshot is the image file at ${req.imagePath}. Read it with the Read tool, then answer.`,
    "--model",
    VISION_MODELS.claude,
    "--strict-mcp-config",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--tools",
    "Read",
    "--allowedTools",
    "Read",
    "--permission-mode",
    "dontAsk",
    "--add-dir",
    dir,
    "--system-prompt",
    VISION_SYSTEM,
  ];
}

export function claudeVision(io: BrainIO, timeoutMs = 45_000): VisionEngine {
  return {
    name: "claude",
    configured: () => !!io.which("claude"),
    async describe(req, signal) {
      const bin = io.which("claude");
      if (!bin) throw new Error("claude-cli: not installed");
      const proc = io.spawn(claudeVisionArgs(bin, req), { cwd: dirname(req.imagePath), env: { ...cliEnv(), MAX_THINKING_TOKENS: "0" } });
      const dispose = killAfter(proc, req.timeoutMs ?? timeoutMs, signal);
      let text = "";
      try {
        for await (const t of parseClaudeStream(readLines(proc.stdout))) text += t;
      } finally {
        dispose();
        proc.kill();
      }
      if (!text.trim()) {
        const err = (await drainText(proc.stderr)).trim().slice(-200);
        throw new Error(`claude-cli vision: no answer${err ? ` (${err})` : ""}`);
      }
      return text;
    },
  };
}

/** Clean a description: one or two sentences, no markdown, redacted, capped. */
export function cleanDescription(raw: string): { text: string; private: boolean } {
  const t = raw
    .replace(/[*_`#>]+/g, "")
    .replace(/[—–]/g, ",")
    .replace(/\s+/g, " ")
    .trim();
  if (/^PRIVATE\b/i.test(t)) return { text: "", private: true };
  const sentences = t.match(/[^.!?]+[.!?]+/g) ?? [t];
  const two = sentences.slice(0, 2).join(" ").trim() || t;
  return { text: redactScreenText(two.slice(0, 320)).text, private: false };
}

export function defaultVisionEngines(io: BrainIO): VisionEngine[] {
  const all = [gatewayVision(io), anthropicVision(io), claudeVision(io)];
  const pin = io.secret("EVE_SCREEN_VISION");
  if (pin) return [...all.filter((e) => e.name === pin), ...all.filter((e) => e.name !== pin)];
  return all;
}

/** Try each configured engine until one answers. Never throws. */
export async function describeImage(engines: VisionEngine[], req: VisionRequest, now: () => number = Date.now): Promise<VisionResult> {
  const t0 = now();
  const errors: string[] = [];
  for (const e of engines) {
    if (!e.configured()) continue;
    const signal = AbortSignal.timeout(req.timeoutMs ?? 45_000);
    try {
      const raw = await e.describe(req, signal);
      const c = cleanDescription(raw);
      return { ok: true, description: c.text, by: e.name, ms: now() - t0, ...(c.private ? { private: true } : {}) };
    } catch (err) {
      errors.push(`${e.name}: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
    }
  }
  return { ok: false, description: "", by: "none", ms: now() - t0, error: errors.join("; ") || "no vision engine configured" };
}
