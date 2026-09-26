import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Brain, BrainEvent, StructuredRequest } from "./types";

/**
 * Stopgap frontier brain: headless `claude -p` with a JSON schema. Core's
 * brains bridge (packages/core/src/brains) replaces this once it lands, so
 * rate-limit fallback lives in one place. Pass it in as deps.brain.
 */
export class ClaudeCliBrain implements Brain {
  name = "claude-cli";
  constructor(
    private opts: { bin?: string; model?: string; scratch?: string } = {},
  ) {}

  async structured<T>(req: StructuredRequest): Promise<T> {
    const tools = req.tools ?? [];
    const cwd = join(this.opts.scratch ?? join(homedir(), ".eve", "harem"), req.agent);
    mkdirSync(cwd, { recursive: true });
    const args = [
      "-p",
      req.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--append-system-prompt",
      req.system,
      "--json-schema",
      JSON.stringify(req.schema),
      "--model",
      req.model ?? this.opts.model ?? process.env.HAREM_MODEL ?? "sonnet",
      "--effort",
      process.env.HAREM_EFFORT ?? "low",
      "--tools",
      tools.join(","),
    ];
    if (tools.length) args.push("--allowedTools", tools.join(","));

    const proc = Bun.spawn([this.opts.bin ?? "claude", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const kill = () => proc.kill();
    req.signal?.addEventListener("abort", kill, { once: true });
    const timer = setTimeout(kill, req.timeoutMs ?? 120_000);

    let result: T | undefined;
    let error: string | undefined;
    try {
      for await (const line of lines(proc.stdout)) {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === "assistant") {
          for (const block of msg.message?.content ?? []) {
            if (block.type === "tool_use") {
              if (block.name === "StructuredOutput") result = block.input as T;
              else req.onEvent?.({ kind: "tool", name: block.name, detail: toolDetail(block.input) });
            } else if (block.type === "text" && block.text?.trim()) {
              req.onEvent?.({ kind: "text", text: block.text.trim() });
            }
          }
        } else if (msg.type === "result") {
          if (msg.structured_output && result === undefined) result = msg.structured_output as T;
          if (msg.is_error) error = String(msg.result ?? msg.subtype ?? "claude error");
        }
      }
      await proc.exited;
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", kill);
    }
    if (result !== undefined) return result;
    const stderr = (await new Response(proc.stderr).text()).trim().slice(-400);
    throw new Error(error ?? (stderr || `claude exited ${proc.exitCode} without structured output`));
  }
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield line;
    }
  }
  if (buf.trim()) yield buf.trim();
}

function toolDetail(input: any): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  return input.query ?? input.url ?? input.command ?? undefined;
}

// ---------------------------------------------------------------------------
// Scripted brain: deterministic, zero-network. The golden demo path runs on it.
// ---------------------------------------------------------------------------

export interface ScriptStep {
  afterMs: number;
  event: BrainEvent;
}

export interface Script {
  steps: ScriptStep[];
  result: unknown;
  /** Total time before the result lands. */
  doneMs: number;
}

export class ScriptedBrain implements Brain {
  name = "scripted";
  constructor(
    private scripts: Record<string, Script>,
    private pace = 1,
  ) {}

  async structured<T>(req: StructuredRequest): Promise<T> {
    const key = Object.keys(this.scripts).find((k) => req.agent === k || req.agent.startsWith(`${k}:`) || req.agent.endsWith(`:${k}`));
    const script = key ? this.scripts[key] : undefined;
    if (!script) throw new Error(`no script for ${req.agent}`);
    let t = 0;
    for (const s of script.steps) {
      await sleep((s.afterMs - t) * this.pace, req.signal);
      t = s.afterMs;
      req.onEvent?.(s.event);
    }
    await sleep((script.doneMs - t) * this.pace, req.signal);
    return structuredClone(script.result) as T;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

/** The "figure out tonight" beat: Miso wants Mensho, Mina says absolutely not, Kari has 7:30. */
export const DEMO_SCRIPTS: Record<string, Script> = {
  planner: {
    steps: [],
    doneMs: 600,
    result: {
      mode: "SPAWN_SWARM",
      confidence: 0.91,
      reason: "open-ended evening plan: food, time and money in parallel",
      workers: [
        { role: "food", goal: "Find 3 dinner options that match what the user likes" },
        { role: "calendar", goal: "Find tonight's free window" },
        { role: "budget", goal: "Keep tonight's spend reasonable" },
      ],
    },
  },
  food: {
    steps: [
      { afterMs: 400, event: { kind: "tool", name: "WebSearch", detail: "spicy ramen near me open tonight" } },
      { afterMs: 1500, event: { kind: "text", text: "searching 14 restaurants..." } },
      { afterMs: 2600, event: { kind: "tool", name: "WebFetch", detail: "mensho menu" } },
      { afterMs: 3800, event: { kind: "text", text: "Mensho. obviously." } },
    ],
    doneMs: 4600,
    result: {
      options: [
        { name: "Mensho", dish: "Garlic Knockout Ramen", cost: 22, distanceMinutes: 14, fit: 0.93, reason: "spiciest bowl in range, you stared at it for 4 seconds" },
        { name: "Menya Kaze", dish: "Red Miso Tantanmen", cost: 18, distanceMinutes: 12, fit: 0.88, reason: "spicy, casual, cheaper" },
        { name: "Noodle Hut", dish: "Chili Oil Udon", cost: 14, distanceMinutes: 24, fit: 0.71, reason: "cheap but far" },
      ],
      confidence: 0.88,
    },
  },
  budget: {
    steps: [
      { afterMs: 300, event: { kind: "text", text: "retrieving budget preferences..." } },
      { afterMs: 1400, event: { kind: "tool", name: "memory", detail: "saving money · complained about $28 ramen" } },
    ],
    doneMs: 2400,
    result: { maxRecommendedSpend: 20, warnings: ["anything over $20 a bowl is a repeat of the $28 incident"], confidence: 0.84 },
  },
  calendar: {
    steps: [
      { afterMs: 300, event: { kind: "text", text: "checking calendar..." } },
      { afterMs: 1200, event: { kind: "tool", name: "calendar.read", detail: "tonight" } },
    ],
    doneMs: 2000,
    result: { availableFrom: "19:10", availableUntil: "23:30", suggestedStart: "19:30", confidence: 0.9 },
  },
};
