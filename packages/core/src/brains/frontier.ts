import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { complete, openAiBackend } from "./chat";
import { describe, type HealthBook } from "./health";
import { cliEnv, drainText, killAfter, readLines, sseData, withTimeout, type BrainIO } from "./io";
import { extractJson, isErrorText } from "./text";

/**
 * The frontal cortex. Slow, rare, smart. Four engines behind one shape:
 *
 *   jabby   the live jabby daemon (POST /api/chat, SSE). matt's memory, tools,
 *           playbook. This is the real brain; ~10-20s.
 *   claude  headless `claude -p` in a scratch dir under ~/.eve/work
 *   codex   `codex exec --json`, read-only sandbox, ephemeral
 *   openai  plain chat completion, last resort
 */

/** Same shape the harem's Brain interface streams (packages/harem/src/types.ts). */
export type BrainEvent = { kind: "tool"; name: string; detail?: string } | { kind: "text"; text: string };

export interface EngineRun {
  /** Who is asking (logs, per-agent scratch dir). */
  agent: string;
  system: string;
  prompt: string;
  /** Want a JSON object back. */
  json: boolean;
  /** JSON schema for structured output (implies json). */
  schema?: object;
  /** Built-in tool allowlist. [] = pure reasoning. */
  tools: string[];
  model?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onEvent?: (e: BrainEvent) => void;
}

export interface EngineOut {
  text: string;
  json?: unknown;
}

export interface FrontierEngine {
  name: string;
  available(): Promise<boolean>;
  run(r: EngineRun): Promise<EngineOut>;
}

export const READ_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch"];

function jsonInstruction(r: EngineRun): string {
  if (!r.json && !r.schema) return "";
  return r.schema
    ? `\n\nReply with ONLY one JSON object that matches this JSON schema. No prose, no code fences.\n${JSON.stringify(r.schema)}`
    : "\n\nReply with ONLY one JSON object. No prose, no code fences.";
}

// ---------------------------------------------------------------------------
// jabby daemon
// ---------------------------------------------------------------------------

const TOOL_TRACE_RE = /\n?_\[tool: ([^\]]*?)(?: -> ([^\]]*))?\]_\n?/g;

/** Split jabby's streamed chat text into prose and tool trace events. */
export function splitJabbyChunk(chunk: string): { text: string; tools: { name: string; detail?: string }[] } {
  const tools: { name: string; detail?: string }[] = [];
  const text = chunk.replace(TOOL_TRACE_RE, (_m, name: string, detail?: string) => {
    tools.push(detail ? { name: name.trim(), detail: detail.trim() } : { name: name.trim() });
    return "";
  });
  return { text, tools };
}

export function jabbyEngine(io: BrainIO, baseUrl: string, health?: HealthBook): FrontierEngine {
  let cache: { at: number; ok: boolean } | null = null;
  const url = baseUrl.replace(/\/$/, "");
  const available = async () => {
    if (cache && io.now() - cache.at < 10_000) return cache.ok;
    let ok = false;
    try {
      const res = await io.fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
      ok = res.ok && ((await res.json().catch(() => ({}))) as { ok?: boolean }).ok === true;
    } catch {}
    cache = { at: io.now(), ok };
    if (health) health.get("jabby").ok = ok;
    return ok;
  };
  return {
    name: "jabby",
    available,
    async run(r) {
      const message = `[eigenwife: request from Eve's body (agent ${r.agent}). answer directly; no discord formatting.]\n${r.system}\n\n${r.prompt}${jsonInstruction(r)}`;
      const signal = withTimeout(r.timeoutMs, r.signal);
      const res = await io.fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
        signal,
      });
      if (!res.ok || !res.body) throw new Error(`jabby http ${res.status}`);
      let text = "";
      let done = false;
      for await (const data of sseData(res.body)) {
        let evt: { type?: string; text?: string; message?: string; ok?: boolean; error?: string };
        try {
          evt = JSON.parse(data);
        } catch {
          continue;
        }
        if (evt.ok === false) throw new Error(`jabby: ${evt.error ?? "refused"}`);
        if (evt.type === "chunk" && evt.text) {
          const { text: prose, tools } = splitJabbyChunk(evt.text);
          for (const t of tools) r.onEvent?.({ kind: "tool", ...t });
          if (prose.trim()) r.onEvent?.({ kind: "text", text: prose.trim() });
          text += prose;
        } else if (evt.type === "error") throw new Error(`jabby: ${evt.message ?? "error"}`);
        else if (evt.type === "done") {
          done = true;
          break;
        }
      }
      if (!done && signal.aborted) throw new Error("jabby: timed out");
      text = text.trim();
      if (!text) throw new Error("jabby: empty reply");
      if (isErrorText(text) && text.length < 400) throw new Error(`jabby: ${text.slice(0, 200)}`);
      return { text };
    },
  };
}

// ---------------------------------------------------------------------------
// claude -p (full headless)
// ---------------------------------------------------------------------------

export function claudeFrontierArgs(bin: string, r: EngineRun): string[] {
  const args = [
    bin,
    "-p",
    r.prompt + (r.schema ? "" : jsonInstruction(r)),
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--append-system-prompt",
    r.system,
    "--model",
    r.model ?? "sonnet",
    "--effort",
    process.env.EVE_FRONTIER_EFFORT ?? "low",
    "--tools",
    r.tools.join(","),
  ];
  // Pure reasoning skips MCP boot (seconds). With tools, it's the full CLI.
  if (!r.tools.length) args.push("--strict-mcp-config");
  else args.push("--allowedTools", r.tools.join(","));
  if (r.schema) args.push("--json-schema", JSON.stringify(r.schema));
  return args;
}

/** Parse full claude stream-json output: text, tool events, structured output, errors. */
export async function parseClaudeRun(lines: AsyncIterable<string>, onEvent?: (e: BrainEvent) => void): Promise<{ text: string; structured?: unknown; error?: string }> {
  let text = "";
  let structured: unknown;
  let error: string | undefined;
  let result = "";
  for await (const line of lines) {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "assistant") {
      for (const block of msg.message?.content ?? []) {
        if (block?.type === "tool_use") {
          if (block.name === "StructuredOutput") structured = block.input;
          else onEvent?.({ kind: "tool", name: String(block.name), detail: toolDetail(block.input) });
        } else if (block?.type === "text" && block.text?.trim()) {
          onEvent?.({ kind: "text", text: block.text.trim() });
          text += block.text;
        }
      }
    } else if (msg.type === "result") {
      if (msg.structured_output !== undefined && structured === undefined) structured = msg.structured_output;
      if (typeof msg.result === "string") result = msg.result;
      if (msg.is_error) error = String(msg.result || msg.subtype || "claude error");
    }
  }
  return { text: (result || text).trim(), structured, error };
}

function toolDetail(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const i = input as Record<string, unknown>;
  const v = i.query ?? i.url ?? i.command ?? i.pattern ?? i.file_path;
  return typeof v === "string" ? v.slice(0, 120) : undefined;
}

export function claudeEngine(io: BrainIO): FrontierEngine {
  return {
    name: "claude",
    available: async () => !!io.which("claude"),
    async run(r) {
      const bin = io.which("claude");
      if (!bin) throw new Error("claude: not installed");
      const cwd = join(io.workDir, safeDir(r.agent));
      mkdirSync(cwd, { recursive: true });
      const proc = io.spawn(claudeFrontierArgs(bin, { ...r, model: r.model ?? (io.secret("EVE_FRONTIER_MODEL") || undefined) }), { cwd, env: cliEnv() });
      const dispose = killAfter(proc, r.timeoutMs, r.signal);
      try {
        const out = await parseClaudeRun(readLines(proc.stdout), r.onEvent);
        const code = await proc.exited;
        if (r.signal?.aborted) throw new Error("claude: aborted");
        if (out.error) throw new Error(`claude: ${out.error.slice(0, 240)}`);
        if (out.structured !== undefined) return { text: out.text || JSON.stringify(out.structured), json: out.structured };
        if (!out.text) {
          const err = (await drainText(proc.stderr)).trim().slice(-240);
          throw new Error(`claude exited ${code} with no output${err ? `: ${err}` : ""}`);
        }
        if (isErrorText(out.text) && out.text.length < 400) throw new Error(`claude: ${out.text.slice(0, 200)}`);
        return { text: out.text };
      } finally {
        dispose();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// codex exec (reimplemented from jabby's buildCodexArgs / CodexAccumulator,
// which we can't import: its module pulls jabby's harness types)
// ---------------------------------------------------------------------------

export function codexArgs(bin: string, cwd: string, r: EngineRun, schemaFile?: string): string[] {
  const args = [bin, "exec", "--json", "--skip-git-repo-check", "--ephemeral", "-C", cwd, "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"'];
  if (r.model && !/^(sonnet|opus|haiku)/.test(r.model)) args.push("-m", r.model);
  const effort = process.env.EVE_CODEX_EFFORT ?? "low";
  args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
  if (r.tools.some((t) => /web/i.test(t))) args.push("-c", "tools.web_search=true");
  if (schemaFile) args.push("--output-schema", schemaFile);
  args.push("-");
  return args;
}

const CODEX_FAIL = /usage limit|rate limit|too many requests|you've hit your|quota exceeded|not logged in|login required|unauthorized/i;

export async function parseCodexRun(lines: AsyncIterable<string>, onEvent?: (e: BrainEvent) => void): Promise<{ text: string; errors: string[] }> {
  const messages: string[] = [];
  const errors: string[] = [];
  for await (const line of lines) {
    if (line[0] !== "{") continue;
    let e: Record<string, any>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "turn.failed") errors.push(String(e.error?.message ?? "turn failed"));
    else if (e.type === "error" && typeof e.message === "string") errors.push(e.message);
    else if (e.type === "item.started" || e.type === "item.completed") {
      const item = e.item ?? {};
      if (item.type === "agent_message" && e.type === "item.completed" && typeof item.text === "string") {
        messages.push(item.text);
        onEvent?.({ kind: "text", text: item.text.slice(0, 400) });
      } else if (e.type === "item.started" && item.type === "command_execution") onEvent?.({ kind: "tool", name: "shell", detail: String(item.command ?? "").slice(0, 120) });
      else if (e.type === "item.started" && item.type === "web_search") onEvent?.({ kind: "tool", name: "web_search", detail: String(item.query ?? "").slice(0, 120) });
      else if (e.type === "item.started" && item.type === "mcp_tool_call") onEvent?.({ kind: "tool", name: `mcp:${item.server ?? "?"}.${item.tool ?? "?"}` });
    }
  }
  return { text: (messages.at(-1) ?? "").trim(), errors };
}

export function codexEngine(io: BrainIO): FrontierEngine {
  return {
    name: "codex",
    available: async () => !!io.which("codex"),
    async run(r) {
      const bin = io.which("codex");
      if (!bin) throw new Error("codex: not installed");
      const cwd = join(io.workDir, safeDir(r.agent));
      mkdirSync(cwd, { recursive: true });
      let schemaFile: string | undefined;
      if (r.schema) {
        schemaFile = join(cwd, `schema-${io.now()}.json`);
        writeFileSync(schemaFile, JSON.stringify(r.schema));
      }
      const stdin = `${r.system}\n\n${r.prompt}${jsonInstruction(r)}`;
      const proc = io.spawn(codexArgs(bin, cwd, r, schemaFile), { cwd, env: cliEnv(), stdin });
      const dispose = killAfter(proc, r.timeoutMs, r.signal);
      try {
        const out = await parseCodexRun(readLines(proc.stdout), r.onEvent);
        const code = await proc.exited;
        if (r.signal?.aborted) throw new Error("codex: aborted");
        if (!out.text) {
          const err = out.errors.at(-1) ?? (await drainText(proc.stderr)).trim().slice(-240);
          throw new Error(`codex exited ${code}${err ? `: ${err.slice(0, 240)}` : ""}`);
        }
        if (CODEX_FAIL.test(out.text) && out.text.length < 300) throw new Error(`codex: ${out.text}`);
        return { text: out.text };
      } finally {
        dispose();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// openai (last resort)
// ---------------------------------------------------------------------------

export function openAiEngine(io: BrainIO): FrontierEngine {
  const chat = openAiBackend(io);
  return {
    name: "openai",
    available: async () => chat.configured(),
    async run(r) {
      const text = await complete(
        chat,
        { system: r.system + jsonInstruction(r), user: r.prompt },
        { json: r.json || !!r.schema, maxTokens: 2000, temperature: 0.4, signal: withTimeout(r.timeoutMs, r.signal) },
      );
      if (!text.trim()) throw new Error("openai: empty reply");
      return { text: text.trim() };
    },
  };
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

export interface ChainResult extends EngineOut {
  engine: string;
  ms: number;
  errors: string[];
}

/**
 * Try engines in order. Skips unavailable or parked ones, records health, and
 * (for json runs) treats "no parseable JSON" as a failure so the next engine
 * gets a shot.
 */
export async function runChain(engines: FrontierEngine[], r: EngineRun, health: HealthBook, now: () => number = Date.now): Promise<ChainResult> {
  const errors: string[] = [];
  for (const e of engines) {
    if (r.signal?.aborted) break;
    if (health.cooling(e.name)) {
      errors.push(`${e.name}: parked`);
      continue;
    }
    let ok = false;
    try {
      ok = await e.available();
    } catch {}
    if (!ok) {
      errors.push(`${e.name}: unavailable`);
      continue;
    }
    const t0 = now();
    try {
      const out = await e.run(r);
      const wantJson = r.json || !!r.schema;
      const json = out.json !== undefined ? out.json : wantJson ? extractJson(out.text) : undefined;
      if (wantJson && (json === undefined || json === null || typeof json !== "object")) throw new Error(`${e.name}: no JSON in reply`);
      health.ok(e.name, now() - t0);
      return { text: out.text, ...(json !== undefined ? { json } : {}), engine: e.name, ms: now() - t0, errors };
    } catch (err) {
      if (r.signal?.aborted) {
        errors.push(`${e.name}: aborted`);
        break;
      }
      health.fail(e.name, err);
      errors.push(`${e.name}: ${describe(err).slice(0, 200)}`);
    }
  }
  const aborted = r.signal?.aborted;
  throw Object.assign(new Error(aborted ? "aborted" : `all frontier engines failed (${errors.join("; ")})`), { errors });
}

function safeDir(agent: string): string {
  return agent.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 60) || "frontier";
}
