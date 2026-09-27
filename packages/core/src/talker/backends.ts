import { mkdirSync } from "fs";
import { ANTHROPIC_MODEL, claudePersonaArgs, FEATHERLESS_MODELS, GATEWAY_CHAT_URL, openAiBody, parseClaudeStream } from "../brains/chat";
import { cliEnv, drainText, HttpError, killAfter, readLines, sseData, type BrainIO } from "../brains/io";
import { anthropicTool, InlineDelegateParser, INLINE_RULE, lookupIntent, openAiTool, parseDelegateArgs, partialStall, type DelegateCall } from "./tools";

/**
 * Talker backends: a streaming persona model that can call delegate(). Each
 * yields text as it streams, a `stall` as soon as the tool call's stall
 * string is complete, and one `delegate` event when the call is whole.
 *
 *   anthropic    Messages API, native tool_use (ANTHROPIC_API_KEY)
 *   gateway      Vercel AI Gateway chat completions + tools (AI_GATEWAY_API_KEY)
 *   openai       chat completions + tools (OPENAI_API_KEY)
 *   featherless  open-weight chat, inline ">>delegate" protocol (FEATHERLESS_API_KEY)
 *   claude-cli   `claude -p --model haiku`, inline protocol + keyword routing (no key)
 */

export type TalkerEvent = { type: "text"; text: string } | { type: "stall"; text: string } | { type: "delegate"; call: DelegateCall };

export interface TalkerMessage {
  system: string;
  user: string;
}

export interface TalkerStreamOpts {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** What he said: the default task if a call comes back without one, and the keyword router's input. */
  userText?: string;
}

export interface TalkerBackend {
  name: string;
  /** native: real tool calls. inline: the >>delegate text protocol. */
  tools: "native" | "inline";
  configured(): boolean;
  model(): string;
  stream(msg: TalkerMessage, opts?: TalkerStreamOpts): AsyncGenerator<TalkerEvent>;
}

// ---------------------------------------------------------------------------
// Stream parsers (pure over SSE payloads, tested directly)
// ---------------------------------------------------------------------------

/** Anthropic Messages SSE payloads -> talker events. */
export async function* parseAnthropicTalker(payloads: AsyncIterable<string>, userText = ""): AsyncGenerator<TalkerEvent> {
  const tools = new Map<number, { name: string; json: string; stalled: boolean }>();
  for await (const data of payloads) {
    let evt: Record<string, any>;
    try {
      evt = JSON.parse(data);
    } catch {
      continue;
    }
    if (evt.type === "error") throw new Error(`anthropic: ${evt.error?.message ?? "stream error"}`);
    if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") {
      const input = evt.content_block.input;
      tools.set(evt.index, { name: String(evt.content_block.name ?? ""), json: input && Object.keys(input).length ? JSON.stringify(input) : "", stalled: false });
    } else if (evt.type === "content_block_delta") {
      if (evt.delta?.type === "text_delta" && evt.delta.text) yield { type: "text", text: evt.delta.text };
      else if (evt.delta?.type === "input_json_delta") {
        const t = tools.get(evt.index);
        if (!t) continue;
        t.json += evt.delta.partial_json ?? "";
        if (!t.stalled && t.name === "delegate") {
          const s = partialStall(t.json);
          if (s) {
            t.stalled = true;
            yield { type: "stall", text: s };
          }
        }
      }
    } else if (evt.type === "content_block_stop") {
      const t = tools.get(evt.index);
      if (t && t.name === "delegate") {
        tools.delete(evt.index);
        const call = parseDelegateArgs(t.json, userText);
        if (call) {
          if (!t.stalled && call.stall) yield { type: "stall", text: call.stall };
          yield { type: "delegate", call };
        }
      }
    } else if (evt.type === "message_stop") return;
  }
}

/** OpenAI-style chat completion SSE payloads (with tool_calls) -> talker events. */
export async function* parseOpenAiTalker(payloads: AsyncIterable<string>, userText = "", where = "openai"): AsyncGenerator<TalkerEvent> {
  const calls = new Map<number, { name: string; args: string; stalled: boolean }>();
  let done = false;
  const finish = function* (): Generator<TalkerEvent> {
    if (done) return;
    done = true;
    for (const c of calls.values()) {
      if (c.name !== "delegate") continue;
      const call = parseDelegateArgs(c.args, userText);
      if (!call) continue;
      if (!c.stalled && call.stall) yield { type: "stall", text: call.stall };
      yield { type: "delegate", call };
      return;
    }
  };
  for await (const data of payloads) {
    if (data === "[DONE]") break;
    let evt: Record<string, any>;
    try {
      evt = JSON.parse(data);
    } catch {
      continue;
    }
    if (evt.error) throw new Error(`${where}: ${evt.error.message ?? "stream error"}`);
    const choice = evt.choices?.[0];
    const delta = choice?.delta ?? {};
    if (typeof delta.content === "string" && delta.content) yield { type: "text", text: delta.content };
    for (const tc of delta.tool_calls ?? []) {
      const i = typeof tc.index === "number" ? tc.index : 0;
      let c = calls.get(i);
      if (!c) calls.set(i, (c = { name: "", args: "", stalled: false }));
      if (tc.function?.name) c.name += tc.function.name;
      if (typeof tc.function?.arguments === "string") c.args += tc.function.arguments;
      if (!c.stalled && (c.name === "delegate" || !c.name)) {
        const s = partialStall(c.args);
        if (s) {
          c.stalled = true;
          yield { type: "stall", text: s };
        }
      }
    }
    if (choice?.finish_reason === "tool_calls") yield* finish();
  }
  yield* finish();
}

/** Plain text chunks through the inline protocol -> talker events. */
export async function* parseInlineTalker(chunks: AsyncIterable<string>, userText = ""): AsyncGenerator<TalkerEvent> {
  const p = new InlineDelegateParser();
  for await (const c of chunks) {
    const out = p.push(c);
    if (out) yield { type: "text", text: out };
  }
  const end = p.end(userText);
  if (end.text) yield { type: "text", text: end.text };
  if (end.call) {
    if (end.call.stall) yield { type: "stall", text: end.call.stall };
    yield { type: "delegate", call: end.call };
  }
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

const withRule = (msg: TalkerMessage): TalkerMessage => ({ ...msg, system: `${msg.system}\n\n${INLINE_RULE}` });

export function anthropicTalker(io: BrainIO): TalkerBackend {
  const model = () => io.secret("EVE_TALKER_ANTHROPIC_MODEL") || io.secret("EVE_ANTHROPIC_MODEL") || ANTHROPIC_MODEL;
  return {
    name: "anthropic",
    tools: "native",
    configured: () => !!io.secret("ANTHROPIC_API_KEY"),
    model,
    async *stream(msg, o = {}) {
      const res = await io.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": io.secret("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: model(),
          max_tokens: o.maxTokens ?? 300,
          temperature: o.temperature ?? 0.9,
          system: msg.system,
          messages: [{ role: "user", content: msg.user }],
          tools: [anthropicTool()],
          tool_choice: { type: "auto", disable_parallel_tool_use: true },
          stream: true,
        }),
        signal: o.signal,
      });
      if (!res.ok || !res.body) throw new HttpError(res.status, await res.text().catch(() => ""), "anthropic");
      yield* parseAnthropicTalker(sseData(res.body), o.userText);
    },
  };
}

export const TALKER_GATEWAY_MODELS = ["anthropic/claude-haiku-4.5", "openai/gpt-6-luna-fast"];

function modelMissing(err: unknown): boolean {
  return err instanceof HttpError && (err.status === 404 || (err.status === 400 && /model|reasoning|unsupported|tool/i.test(err.body)));
}

/** OpenAI-compatible chat completions with native tools, walking a model list on "model missing". */
function openAiCompatTalker(
  io: BrainIO,
  name: string,
  url: string,
  keyName: string,
  list: () => string[],
): TalkerBackend & { idx: number } {
  const self = {
    name,
    idx: 0,
    tools: "native" as const,
    configured: () => !!io.secret(keyName),
    model: () => list()[self.idx] ?? list()[0]!,
    async *stream(msg: TalkerMessage, o: TalkerStreamOpts = {}): AsyncGenerator<TalkerEvent> {
      const models = list();
      for (let i = self.idx; i < models.length; i++) {
        const model = models[i]!;
        const bare = model.split("/").pop()!;
        const tuning = bare.startsWith("gpt-") ? openAiBody(bare, o.maxTokens ?? 300, o.temperature ?? 0.9) : { max_tokens: o.maxTokens ?? 300, temperature: o.temperature ?? 0.9 };
        const res = await io.fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${io.secret(keyName)}`, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: msg.system },
              { role: "user", content: msg.user },
            ],
            tools: [openAiTool()],
            tool_choice: "auto",
            parallel_tool_calls: false,
            stream: true,
            ...tuning,
          }),
          signal: o.signal,
        });
        if (!res.ok || !res.body) {
          const err = new HttpError(res.status, await res.text().catch(() => ""), name);
          if (modelMissing(err) && i < models.length - 1) continue;
          throw err;
        }
        self.idx = i;
        yield* parseOpenAiTalker(sseData(res.body), o.userText, name);
        return;
      }
    },
  };
  return self;
}

export function gatewayTalker(io: BrainIO): TalkerBackend {
  const list = () => {
    const pinned = io.secret("EVE_TALKER_MODEL") || io.secret("EVE_GATEWAY_MODEL");
    return pinned ? [pinned, ...TALKER_GATEWAY_MODELS.filter((m) => m !== pinned)] : TALKER_GATEWAY_MODELS;
  };
  return openAiCompatTalker(io, "gateway", GATEWAY_CHAT_URL, "AI_GATEWAY_API_KEY", list);
}

export function openAiTalker(io: BrainIO): TalkerBackend {
  const list = () => {
    const pinned = io.secret("EVE_OPENAI_MODEL");
    const base = ["gpt-6-luna", "gpt-4.1-mini"];
    return pinned ? [pinned, ...base.filter((m) => m !== pinned)] : base;
  };
  return openAiCompatTalker(io, "openai", "https://api.openai.com/v1/chat/completions", "OPENAI_API_KEY", list);
}

/** Featherless: open-weight roleplay models, no reliable tool calling, so the inline protocol. */
export function featherlessTalker(io: BrainIO): TalkerBackend {
  const model = () => io.secret("FEATHERLESS_MODEL") || FEATHERLESS_MODELS[0]!;
  return {
    name: "featherless",
    tools: "inline",
    configured: () => !!io.secret("FEATHERLESS_API_KEY"),
    model,
    async *stream(msg, o = {}) {
      if (o.userText && lookupIntent(o.userText)) return yield* keywordDelegate(o.userText);
      const m = withRule(msg);
      const res = await io.fetch("https://api.featherless.ai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${io.secret("FEATHERLESS_API_KEY")}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: model(),
          messages: [
            { role: "system", content: m.system },
            { role: "user", content: m.user },
          ],
          max_tokens: o.maxTokens ?? 300,
          temperature: o.temperature ?? 0.9,
          stream: true,
        }),
        signal: o.signal,
      });
      if (!res.ok || !res.body) throw new HttpError(res.status, await res.text().catch(() => ""), "featherless");
      const text = (async function* () {
        for await (const e of parseOpenAiTalker(sseData(res.body!), o.userText, "featherless")) if (e.type === "text") yield e.text;
      })();
      yield* parseInlineTalker(text, o.userText);
    },
  };
}

/** Stall lines for keyword-routed lookups (also prerendered in her voice: speech/lines.ts STALL_LINES). */
export const KEYWORD_STALLS = ["ooh, lemme look.", "one sec, checking.", "hm, let me check."];

async function* keywordDelegate(userText: string): AsyncGenerator<TalkerEvent> {
  const stall = KEYWORD_STALLS[userText.length % KEYWORD_STALLS.length]!;
  yield { type: "stall", text: stall };
  yield { type: "delegate", call: { kind: "answer", task: userText, stall } };
}

/** The claude CLI (no key): inline protocol, and obvious lookups skip the model entirely. */
export function claudeCliTalker(io: BrainIO, timeoutMs = 30_000): TalkerBackend {
  const model = () => io.secret("EVE_PERSONA_CLI_MODEL") || "haiku";
  return {
    name: "claude-cli",
    tools: "inline",
    configured: () => !!io.which("claude"),
    model,
    async *stream(msg, o = {}) {
      if (o.userText && lookupIntent(o.userText)) return yield* keywordDelegate(o.userText);
      const bin = io.which("claude");
      if (!bin) throw new Error("claude-cli: not installed");
      mkdirSync(io.workDir, { recursive: true });
      const proc = io.spawn(claudePersonaArgs(bin, withRule(msg), false, model()), { cwd: io.workDir, env: { ...cliEnv(), MAX_THINKING_TOKENS: "0" } });
      const dispose = killAfter(proc, timeoutMs, o.signal);
      let any = false;
      try {
        const text = (async function* () {
          for await (const t of parseClaudeStream(readLines(proc.stdout))) {
            any = true;
            yield t;
          }
        })();
        yield* parseInlineTalker(text, o.userText);
      } finally {
        dispose();
        if (!any) {
          const code = await Promise.race([proc.exited, Bun.sleep(200).then(() => null)]);
          if (code !== null && code !== 0) {
            const err = (await drainText(proc.stderr)).trim().slice(-300);
            if (!o.signal?.aborted) throw new Error(`claude-cli exited ${code}${err ? `: ${err}` : ""}`);
          }
        } else proc.kill();
      }
    },
  };
}

/** Default order: Anthropic API > Gateway > OpenAI > Featherless > claude CLI. */
export function defaultTalkerBackends(io: BrainIO): TalkerBackend[] {
  return [anthropicTalker(io), gatewayTalker(io), openAiTalker(io), featherlessTalker(io), claudeCliTalker(io)];
}
