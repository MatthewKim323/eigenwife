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
  message?: string;
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

async function main() {
  let raw = "";
  try {
    raw = await Bun.stdin.text();
  } catch {}
  let input: HookInput = {};
  try {
    input = JSON.parse(raw || "{}");
  } catch {}
  const outs = mapHook(input);
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
