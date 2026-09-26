import { mkdirSync } from "fs";
import { cliEnv, drainText, HttpError, killAfter, readLines, sseData, type BrainIO } from "./io";
import { isErrorText } from "./text";

/**
 * Chat backends for the fast cortex: persona lines and quickJson. Each one is
 * a plain object over BrainIO so tests can drive it with a fake fetch/spawn.
 *
 *   featherless  OpenAI-compatible, open-weight roleplay model (FEATHERLESS_API_KEY)
 *   openai       small fast chat model with model fallback (OPENAI_API_KEY)
 *   anthropic    Messages API, haiku (ANTHROPIC_API_KEY)
 *   claude-cli   stripped `claude -p --model haiku`, the jabby voice pattern (no key)
 */

export interface ChatMessage {
  system: string;
  user: string;
}

export interface ChatOpts {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Ask for a JSON object (JSON mode where the backend has one). */
  json?: boolean;
}

export interface ChatBackend {
  name: string;
  /** Has what it needs to try (key present / binary installed). */
  configured(): boolean;
  /** Token stream. Throws on transport/API failure. */
  stream(msg: ChatMessage, opts?: ChatOpts): AsyncGenerator<string>;
  /** The model actually in use, for diagnostics. */
  model(): string;
}

/** Drain a stream into one string. */
export async function complete(b: ChatBackend, msg: ChatMessage, opts?: ChatOpts): Promise<string> {
  let out = "";
  for await (const c of b.stream(msg, opts)) out += c;
  return out;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (Featherless, OpenAI)
// ---------------------------------------------------------------------------

async function* openAiCompatStream(io: BrainIO, where: string, url: string, key: string, body: Record<string, unknown>, signal?: AbortSignal): AsyncGenerator<string> {
  const res = await io.fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) throw new HttpError(res.status, await res.text().catch(() => ""), where);
  for await (const data of sseData(res.body)) {
    if (data === "[DONE]") return;
    let evt: { choices?: { delta?: { content?: string } }[]; error?: { message?: string } };
    try {
      evt = JSON.parse(data);
    } catch {
      continue;
    }
    if (evt.error) throw new Error(`${where}: ${evt.error.message ?? "stream error"}`);
    const delta = evt.choices?.[0]?.delta?.content;
    if (delta) yield delta;
  }
}

export const FEATHERLESS_MODELS = ["Sao10K/L3-8B-Stheno-v3.2", "NousResearch/Hermes-3-Llama-3.1-8B"];

export function featherlessBackend(io: BrainIO): ChatBackend {
  let idx = 0;
  const models = () => {
    const pinned = io.secret("FEATHERLESS_MODEL");
    return pinned ? [pinned, ...FEATHERLESS_MODELS.filter((m) => m !== pinned)] : FEATHERLESS_MODELS;
  };
  return {
    name: "featherless",
    configured: () => !!io.secret("FEATHERLESS_API_KEY"),
    model: () => models()[idx] ?? models()[0]!,
    async *stream(msg, o = {}) {
      const list = models();
      for (let i = idx; i < list.length; i++) {
        const body: Record<string, unknown> = {
          model: list[i],
          messages: [
            { role: "system", content: o.json ? `${msg.system}\n\nRespond with ONLY a JSON object.` : msg.system },
            { role: "user", content: msg.user },
          ],
          max_tokens: o.maxTokens ?? 120,
          temperature: o.temperature ?? 0.9,
        };
        try {
          yield* openAiCompatStream(io, "featherless", "https://api.featherless.ai/v1/chat/completions", io.secret("FEATHERLESS_API_KEY"), body, o.signal);
          idx = i;
          return;
        } catch (err) {
          // A model that's gated/missing/cold-failing: try the next one. Auth and quota: give up.
          const soft = err instanceof HttpError && (err.status === 400 || err.status === 404 || err.status >= 500);
          if (!soft || i === list.length - 1) throw err;
        }
      }
    },
  };
}

/** Preference order for the OpenAI fast chat model (SPONSORS.md section 7), newest first. */
export const OPENAI_MODELS = ["gpt-6-luna", "gpt-4.1-mini", "gpt-4o-mini"];

/** Request body tweaks per model family: reasoning models need effort off and max_completion_tokens. */
export function openAiBody(model: string, maxTokens: number, temperature: number): Record<string, unknown> {
  if (/^gpt-6/.test(model) || /^gpt-5\.[1-9]/.test(model)) return { reasoning_effort: "none", max_completion_tokens: maxTokens };
  if (/^gpt-5/.test(model) || /^o\d/.test(model)) return { reasoning_effort: "minimal", max_completion_tokens: maxTokens };
  return { max_tokens: maxTokens, temperature };
}

function modelMissing(err: unknown): boolean {
  return err instanceof HttpError && (err.status === 404 || (err.status === 400 && /model|reasoning|unsupported/i.test(err.body)));
}

export function openAiBackend(io: BrainIO): ChatBackend {
  let idx = 0;
  const models = () => {
    const pinned = io.secret("EVE_OPENAI_MODEL");
    return pinned ? [pinned, ...OPENAI_MODELS.filter((m) => m !== pinned)] : OPENAI_MODELS;
  };
  return {
    name: "openai",
    configured: () => !!io.secret("OPENAI_API_KEY"),
    model: () => models()[idx] ?? OPENAI_MODELS[0]!,
    async *stream(msg, o = {}) {
      const list = models();
      for (let i = idx; i < list.length; i++) {
        const model = list[i]!;
        const body: Record<string, unknown> = {
          model,
          messages: [
            { role: "system", content: msg.system },
            { role: "user", content: msg.user },
          ],
          ...openAiBody(model, o.maxTokens ?? 120, o.temperature ?? 0.9),
          ...(o.json ? { response_format: { type: "json_object" } } : {}),
        };
        let yielded = false;
        try {
          for await (const c of openAiCompatStream(io, "openai", "https://api.openai.com/v1/chat/completions", io.secret("OPENAI_API_KEY"), body, o.signal)) {
            yielded = true;
            yield c;
          }
          idx = i;
          return;
        } catch (err) {
          if (yielded || !modelMissing(err) || i === list.length - 1) throw err;
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

export const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

export function anthropicBackend(io: BrainIO): ChatBackend {
  const model = () => io.secret("EVE_ANTHROPIC_MODEL") || ANTHROPIC_MODEL;
  return {
    name: "anthropic",
    configured: () => !!io.secret("ANTHROPIC_API_KEY"),
    model,
    async *stream(msg, o = {}) {
      const res = await io.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": io.secret("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: model(),
          max_tokens: o.maxTokens ?? 120,
          temperature: o.temperature ?? 0.9,
          system: o.json ? `${msg.system}\n\nRespond with ONLY a JSON object.` : msg.system,
          messages: [{ role: "user", content: msg.user }],
          stream: true,
        }),
        signal: o.signal,
      });
      if (!res.ok || !res.body) throw new HttpError(res.status, await res.text().catch(() => ""), "anthropic");
      for await (const data of sseData(res.body)) {
        let evt: { type?: string; delta?: { type?: string; text?: string }; error?: { message?: string } };
        try {
          evt = JSON.parse(data);
        } catch {
          continue;
        }
        if (evt.type === "error") throw new Error(`anthropic: ${evt.error?.message ?? "stream error"}`);
        if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) yield evt.delta.text;
        if (evt.type === "message_stop") return;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// claude CLI, stripped (jabby's fast voice brain pattern)
// ---------------------------------------------------------------------------

/**
 * argv for the stripped persona CLI: haiku, zero MCP servers, no tools, no
 * session file, token streaming. Same core flags as jabby's
 * streamVoiceReply(); we add --system-prompt (drops the Claude Code system
 * prompt, faster and more in character) and --include-partial-messages
 * (real token deltas instead of whole messages).
 */
export function claudePersonaArgs(bin: string, msg: ChatMessage, json = false, model = "haiku"): string[] {
  return [
    bin,
    "-p",
    msg.user,
    "--model",
    model,
    "--strict-mcp-config",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--effort",
    "low",
    "--no-session-persistence",
    "--tools",
    "",
    "--system-prompt",
    json ? `${msg.system}\n\nRespond with ONLY a JSON object. No prose, no code fences.` : msg.system,
  ];
}

/**
 * Parse `claude -p --output-format stream-json [--include-partial-messages]`
 * lines into text. Token deltas when present, whole assistant blocks
 * otherwise, and the final `result` only if nothing streamed. Error results
 * throw (their text is never yielded).
 */
export async function* parseClaudeStream(lines: AsyncIterable<string>): AsyncGenerator<string> {
  let sawDelta = false;
  let sawText = false;
  for await (const line of lines) {
    let evt: Record<string, any>;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt.type === "stream_event") {
      const e = evt.event;
      if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) {
        sawDelta = sawText = true;
        yield e.delta.text as string;
      }
    } else if (evt.type === "assistant" && !sawDelta) {
      for (const block of evt.message?.content ?? []) {
        if (block?.type === "text" && block.text) {
          sawText = true;
          yield block.text as string;
        }
      }
    } else if (evt.type === "result") {
      const result = typeof evt.result === "string" ? evt.result : "";
      if (evt.is_error || (result && isErrorText(result) && !sawText)) throw new Error(`claude-cli: ${result || evt.subtype || "error result"}`);
      if (!sawText && result) yield result;
      return;
    }
  }
}

export function claudeCliBackend(io: BrainIO, timeoutMs = 30_000): ChatBackend {
  const model = () => io.secret("EVE_PERSONA_CLI_MODEL") || "haiku";
  return {
    name: "claude-cli",
    configured: () => !!io.which("claude"),
    model,
    async *stream(msg, o = {}) {
      const bin = io.which("claude");
      if (!bin) throw new Error("claude-cli: not installed");
      mkdirSync(io.workDir, { recursive: true });
      // Thinking off: measured 26.5s -> 3.2s wall for one persona line (haiku, --effort low still thinks).
      const proc = io.spawn(claudePersonaArgs(bin, msg, !!o.json, model()), { cwd: io.workDir, env: { ...cliEnv(), MAX_THINKING_TOKENS: "0" } });
      const dispose = killAfter(proc, timeoutMs, o.signal);
      let any = false;
      try {
        for await (const t of parseClaudeStream(readLines(proc.stdout))) {
          any = true;
          yield t;
        }
      } finally {
        dispose();
        if (!any) {
          const code = await Promise.race([proc.exited, Bun.sleep(200).then(() => null)]);
          if (code !== null && code !== 0) {
            const err = (await drainText(proc.stderr)).trim().slice(-300);
            // Surface the failure so the router falls back (never spoken).
            if (!o.signal?.aborted) throw new Error(`claude-cli exited ${code}${err ? `: ${err}` : ""}`);
          }
        } else proc.kill();
      }
    },
  };
}
