import { envelope, type AnyEnvelope, type EventMap, type EventType, type MemoryHit } from "@eigenwife/protocol";
import { EventBus } from "../bus";
import { loadConfig } from "../config";
import { createContext, type CoreContext, type Module } from "../context";
import type { AgencyService, BrainService, FrontierRequest, HomeService, MemoryService, PersonaRequest, SayOptions, SpeechService } from "../services";

/**
 * In-process fakes for every service the mind touches. No network, no audio,
 * a controllable clock. Used by the reflex/mind tests and handy for anyone
 * who wants to drive the reflex loop from a script.
 */

export class FakeClock {
  constructor(public t = 1_750_000_000_000) {}
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

export function fakeContext(): CoreContext {
  process.env.EIGEN_QUIET = "1";
  const bus = new EventBus(5000);
  return createContext(bus, loadConfig({ port: 0 }));
}

/** Publish an event stamped with the fake clock's time. */
export function emitAt<K extends EventType>(ctx: CoreContext, clock: FakeClock, type: K, data: EventMap[K], source = "test"): AnyEnvelope {
  const e = { ...envelope(type, data, source), ts: clock.now() } as AnyEnvelope;
  ctx.bus.publish(e);
  return e;
}

export class FakeSpeech implements SpeechService {
  said: { text: string; opts?: SayOptions }[] = [];
  stops: string[] = [];
  talking = false;
  constructor(
    private ctx: CoreContext,
    private clock?: FakeClock,
  ) {}
  async say(text: string | AsyncIterable<string>, opts?: SayOptions) {
    let full = "";
    if (typeof text === "string") full = text;
    else for await (const c of text) full += c;
    this.said.push({ text: full, opts });
    const id = `utt_${this.said.length}`;
    const e = { ...envelope("speech.begin", { utteranceId: id, text: full, brain: opts?.brain ?? "test" }, "core", opts?.parent), ts: this.clock?.now() ?? Date.now() };
    this.ctx.bus.publish(e as AnyEnvelope);
    return { utteranceId: id, text: full };
  }
  stop(reason: string) {
    this.stops.push(reason);
    this.talking = false;
  }
  speaking() {
    return this.talking;
  }
}

export class FakeBrains implements BrainService {
  requests: PersonaRequest[] = [];
  constructor(public reply: (r: PersonaRequest) => string = (r) => `[${r.behavior}] ok`) {}
  async *persona(req: PersonaRequest): AsyncIterable<string> {
    this.requests.push(req);
    const text = this.reply(req);
    for (const w of text.split(/(?<= )/)) yield w;
  }
  async frontier(_req?: FrontierRequest) {
    return { ok: true, text: "", engine: "fake", ms: 0 };
  }
  async quickJson() {
    return null;
  }
  status() {
    return { fake: true };
  }
}

export class FakeMemory implements MemoryService {
  recalls: string[] = [];
  observed: { user?: string; eve?: string; event?: string }[] = [];
  /** Simulate a slow (network) recall. */
  delayMs = 0;
  constructor(
    private ctx: CoreContext,
    public memories: string[] = [],
  ) {}
  async recall(query: string, opts?: { k?: number; emit?: boolean; parent?: string }): Promise<MemoryHit[]> {
    this.recalls.push(query);
    if (this.delayMs) await Bun.sleep(this.delayMs);
    const hits: MemoryHit[] = this.memories.slice(0, opts?.k ?? 3).map((content, i) => ({
      record: { id: `m${i}`, kind: "episodic", content, importance: 0.5, confidence: 0.8, source: "test", createdAt: 0 },
      score: 0.9 - i * 0.1,
    }));
    if (opts?.emit) this.ctx.bus.emit("memory.recall", { query, hits, ms: 1, by: "fake" }, "core", opts.parent);
    return hits;
  }
  async write() {
    return null;
  }
  async observe(x: { user?: string; eve?: string; event?: string }) {
    this.observed.push(x);
    return [];
  }
  count() {
    return this.memories.length;
  }
  all() {
    return [];
  }
}

export class FakeAgency implements AgencyService {
  tasks: { goal: string; parent?: string }[] = [];
  acts: { kind: string; args: Record<string, unknown> }[] = [];
  constructor(
    public result: { ok: boolean; summary: string } = { ok: true, summary: "booked Ramen Nagi for 8pm, $18 bowls, 10 min walk" },
    public delayMs = 5,
  ) {}
  async runTask(goal: string, opts?: { parent?: string }) {
    this.tasks.push({ goal, parent: opts?.parent });
    await Bun.sleep(this.delayMs);
    return this.result;
  }
  async act(kind: string, args: Record<string, unknown>) {
    this.acts.push({ kind, args });
    return { ok: true, observation: `${kind} done` };
  }
}

export class FakeHome implements HomeService {
  constructor(public files = new Map<string, unknown>()) {}
  async read<T>(name: string, fallback: T): Promise<T> {
    return this.files.has(name) ? (structuredClone(this.files.get(name)) as T) : fallback;
  }
  async write(name: string, data: unknown) {
    this.files.set(name, structuredClone(data));
  }
  status() {
    return { online: true, host: "test", uptimeMs: 0 };
  }
}

export async function startModules(ctx: CoreContext, modules: Module[]) {
  for (const m of modules) await m.start(ctx);
  return () => Promise.all(modules.map((m) => m.stop?.()));
}

/** Let queued microtasks and 0ms timers run. */
export async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i++) await Bun.sleep(0);
}
