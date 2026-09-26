#!/usr/bin/env bun
/**
 * Claude Code hook -> Eve's face. When the frontier brain (Claude Code) works,
 * she looks like she's thinking; when it stops, she's pleased.
 *
 * Reads the hook JSON on stdin and POSTs envelopes to the core (/emit):
 *   UserPromptSubmit, PreToolUse  -> avatar.state thinking + diag "claude: <tool> <detail>"
 *   PostToolUse                   -> diag "claude: <tool> done"
 *   Notification                  -> avatar.mood surprised
 *   Stop, SubagentStop            -> avatar.mood happy + avatar.state idle
 *   + work.claude {event, cwd, sessionId, tool?, ok?} for the work module (docs/WORK.md)
 *
 * Never blocks Claude: 800ms budget, prints nothing, always exits 0.
 * Install: see docs/AGENCY.md ("Claude Code hooks").
 */

const CORE = (process.env.EIGEN_CORE ?? "http://127.0.0.1:7777").replace(/\/$/, "");
const SOURCE = "claude-code";

interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  message?: string;
  cwd?: string;
  session_id?: string;
}

type Out = { type: string; data: Record<string, unknown> };

let n = 0;
function envelope(o: Out) {
  n++;
  return { ...o, ts: Date.now(), source: SOURCE, id: `cc_${Date.now().toString(36)}${n}${Math.random().toString(36).slice(2, 6)}` };
}

/** Short, human detail for the HUD: the file, the command's first word, the pattern. Never the whole payload. */
export function detail(tool: string, input: Record<string, unknown> = {}): string {
  const pick = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  let d = "";
  if (pick("file_path")) d = pick("file_path").split("/").pop() ?? "";
  else if (pick("command")) d = pick("command").trim().split(/\s+/)[0] ?? "";
  else if (pick("pattern")) d = pick("pattern");
  else if (pick("url")) d = pick("url").replace(/^https?:\/\//, "").split("/")[0] ?? "";
  else if (pick("description")) d = pick("description");
  return `${tool}${d ? ` ${d}` : ""}`.slice(0, 60);
}

export function mapHook(h: HookInput): Out[] {
  const tool = h.tool_name ?? "tool";
  switch (h.hook_event_name) {
    case "UserPromptSubmit":
      return [
        { type: "avatar.state", data: { state: "thinking" } },
        { type: "diag", data: { label: "claude", value: "thinking...", ttlMs: 8000 } },
      ];
    case "PreToolUse":
      return [
        { type: "avatar.state", data: { state: "thinking" } },
        { type: "diag", data: { label: "claude", value: detail(tool, h.tool_input), ttlMs: 8000 } },
      ];
    case "PostToolUse":
      return [{ type: "diag", data: { label: "claude", value: `${detail(tool, h.tool_input)} done`, ttlMs: 3000 } }];
    case "Notification":
      return [{ type: "avatar.mood", data: { mood: "surprised", intensity: 0.5, holdMs: 1500 } }];
    case "Stop":
    case "SubagentStop":
      return [
        { type: "avatar.mood", data: { mood: "happy", intensity: 0.8, holdMs: 2500 } },
        { type: "avatar.state", data: { state: "idle" } },
        { type: "diag", data: { label: "claude", value: "done", ttlMs: 3000 } },
      ];
    default:
      return [];
  }
}

const TEST_CMD = /\b(?:bun\s+(?:run\s+)?test|npm\s+(?:run\s+)?test|pnpm\s+test|yarn\s+test|pytest|cargo\s+test|go\s+test|vitest|jest)\b/;

/** Did a test command pass? From the Bash tool's response. undefined when it can't tell. */
export function testOutcome(response: unknown): boolean | undefined {
  const r = (response ?? {}) as Record<string, unknown>;
  if (typeof r.exit_code === "number") return r.exit_code === 0;
  if (typeof r.exitCode === "number") return r.exitCode === 0;
  if (r.interrupted === true) return undefined;
  const text = typeof response === "string" ? response : `${String(r.stdout ?? "")}\n${String(r.stderr ?? "")}\n${String(r.output ?? "")}`;
  const bun = /(\d+)\s+pass[\s\S]*?(\d+)\s+fail/.exec(text);
  if (bun) return bun[2] === "0";
  if (/\b[1-9]\d*\s+failed\b|Tests:\s+\d+\s+failed|test result: FAILED|^FAIL\s/m.test(text)) return false;
  if (/\b\d+\s+passed\b|test result: ok|^ok\s|Tests:\s+\d+\s+passed/m.test(text)) return true;
  return undefined;
}

/**
 * The work module's view (docs/WORK.md): where the session runs, tool use,
 * test results, when it stops. cwd and session id only, never prompts or file contents.
 */
export function workEvents(h: HookInput): Out[] {
  const base = { ...(h.cwd ? { cwd: h.cwd } : {}), ...(h.session_id ? { sessionId: h.session_id } : {}) };
  switch (h.hook_event_name) {
    case "UserPromptSubmit":
      return [{ type: "work.claude", data: { event: "prompt", ...base } }];
    case "PreToolUse":
      return [{ type: "work.claude", data: { event: "tool", ...base, tool: h.tool_name ?? "tool" } }];
    case "PostToolUse": {
      const cmd = typeof h.tool_input?.command === "string" ? (h.tool_input.command as string) : "";
      if (h.tool_name !== "Bash" || !TEST_CMD.test(cmd)) return [];
      const ok = testOutcome(h.tool_response);
      return ok === undefined ? [] : [{ type: "work.claude", data: { event: "test", ...base, ok } }];
    }
    case "Stop":
      return [{ type: "work.claude", data: { event: "stop", ...base } }];
    default:
      return [];
  }
}

async function main() {
  let raw = "";
  try {
    raw = await Bun.stdin.text();
  } catch {}
  let input: HookInput = {};
  try {
    input = JSON.parse(raw || "{}");
  } catch {}
  const outs = [...mapHook(input), ...workEvents(input)];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 800);
  try {
    // In order: state before diag before mood matters for how the face reads it.
    for (const o of outs)
      await fetch(`${CORE}/emit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope(o)), signal: ac.signal });
  } catch {
    // Core not running: Claude must never notice.
  } finally {
    clearTimeout(timer);
  }
}

if (import.meta.main) await main().finally(() => process.exit(0));
