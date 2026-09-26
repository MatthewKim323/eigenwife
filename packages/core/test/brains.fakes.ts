import type { BrainIO, ProcHandle, SpawnOpts } from "../src/brains/io";
import type { ChatBackend } from "../src/brains/chat";
import type { FrontierEngine } from "../src/brains/frontier";

/** Test doubles for the brains IO seams. No network, no processes. */

export function bytes(chunks: string[], delayMs = 0): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    async pull(c) {
      if (i >= chunks.length) return c.close();
      if (delayMs) await Bun.sleep(delayMs);
      c.enqueue(enc.encode(chunks[i++]!));
    },
  });
}

export function sse(payloads: unknown[], status = 200): Response {
  const chunks = payloads.map((p) => `data: ${typeof p === "string" ? p : JSON.stringify(p)}\n\n`);
  return new Response(bytes(chunks), { status, headers: { "content-type": "text/event-stream" } });
}

export function openAiSse(tokens: string[]): Response {
  return sse([...tokens.map((t) => ({ choices: [{ delta: { content: t } }] })), "[DONE]"]);
}

export interface FakeProc extends ProcHandle {
  argv: string[];
  opts?: SpawnOpts;
  killed: boolean;
}

export function fakeProc(argv: string[], opts: SpawnOpts | undefined, lines: unknown[], code = 0, stderr = "", delayMs = 0): FakeProc {
  let resolveExit!: (n: number) => void;
  const exited = new Promise<number>((r) => (resolveExit = r));
  const out = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l)) + "\n");
  const enc = new TextEncoder();
  let i = 0;
  const p: FakeProc = {
    argv,
    opts,
    killed: false,
    stdout: new ReadableStream({
      async pull(c) {
        if (p.killed || i >= out.length) {
          c.close();
          resolveExit(p.killed ? 143 : code);
          return;
        }
        if (delayMs) await Bun.sleep(delayMs);
        c.enqueue(enc.encode(out[i++]!));
      },
    }),
    stderr: bytes([stderr]),
    exited,
    kill() {
      p.killed = true;
      resolveExit(143);
    },
  };
  return p;
}

export function fakeIO(over: Partial<BrainIO> & { secrets?: Record<string, string>; bins?: string[] } = {}): BrainIO {
  const secrets = over.secrets ?? {};
  const bins = over.bins ?? [];
  return {
    fetch: over.fetch ?? (async () => new Response("no network in tests", { status: 599 })),
    spawn: over.spawn ?? ((argv, opts) => fakeProc(argv, opts, [], 1, "no processes in tests")),
    secret: over.secret ?? ((n) => secrets[n] ?? ""),
    which: over.which ?? ((b) => (bins.includes(b) ? `/fake/bin/${b}` : null)),
    workDir: over.workDir ?? `${process.env.TMPDIR ?? "/tmp"}/eve-brains-test`,
    now: over.now ?? Date.now,
  };
}

/** A persona backend that yields scripted tokens or throws. */
export function scriptedBackend(name: string, behavior: string[] | Error | (() => AsyncGenerator<string>), calls: string[] = []): ChatBackend {
  return {
    name,
    configured: () => true,
    model: () => `${name}-model`,
    async *stream(msg) {
      calls.push(name);
      if (behavior instanceof Error) throw behavior;
      if (typeof behavior === "function") {
        yield* behavior();
        return;
      }
      for (const t of behavior) yield t;
    },
  };
}

export function scriptedEngine(name: string, out: { text: string; json?: unknown } | Error, calls: string[] = [], available = true): FrontierEngine {
  return {
    name,
    available: async () => available,
    async run() {
      calls.push(name);
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

export async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of it) out.push(c);
  return out;
}
