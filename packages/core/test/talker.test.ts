import { expect, test, describe } from "bun:test";
import type { EventMap, EventType } from "@eigenwife/protocol";
import type { FrontierRequest, TalkerService } from "../src/services";
import { createJev } from "../src/reflex/jev";
import { ACK_LINES, reflexModule } from "../src/reflex/module";
import { emitAt, FakeAgency, FakeBrains, FakeClock, fakeContext, FakeMemory, FakeSpeech, settle, startModules } from "../src/reflex/testing";
import { claudeCliTalker, parseAnthropicTalker, parseInlineTalker, parseOpenAiTalker, type TalkerBackend, type TalkerEvent } from "../src/talker/backends";
import { handle } from "../src/talker/module";
import { isCancel, Narrator, progressPhrase, waitForGap } from "../src/talker/narrate";
import { ACK_CLIPS } from "../src/talker/router";
import { createTalker, Replay } from "../src/talker/run";
import { InlineDelegateParser, lookupIntent, parseDelegateArgs, parseInline, partialStall } from "../src/talker/tools";
import { LatencyBook, percentile } from "../src/talker/latency";
import type { BrainIO } from "../src/brains/io";

async function* feed(xs: string[]) {
  for (const x of xs) yield x;
}
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
const sse = (o: unknown) => JSON.stringify(o);

// ---------------------------------------------------------------------------
// tool-call parsing across backends
// ---------------------------------------------------------------------------

describe("delegate tool parsing", () => {
  test("args: object, JSON string, bad kind defaults to answer, no task falls back to what he said", () => {
    expect(parseDelegateArgs({ stall: " ooh,  lemme look. ", kind: "do", task: "book it" })).toEqual({ kind: "do", task: "book it", stall: "ooh, lemme look." });
    expect(parseDelegateArgs('{"kind":"weird","task":"x"}')).toEqual({ kind: "answer", task: "x" });
    expect(parseDelegateArgs("{not json", "weather?")).toEqual({ kind: "answer", task: "weather?" });
    expect(parseDelegateArgs({ kind: "answer" })).toBeNull();
  });

  test("stall is readable from partial JSON as soon as its string closes", () => {
    expect(partialStall('{"stall": "ooh, lem')).toBeNull();
    expect(partialStall('{"stall": "ooh, lemme \\"look\\".", "ki')).toBe('ooh, lemme "look".');
  });

  test("anthropic: text deltas, then tool_use with input_json_delta: stall early, delegate at block stop", async () => {
    const payloads = [
      sse({ type: "message_start" }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "[mood:thinking 0.5]" } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "delegate", input: {} } }),
      sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"stall": "one sec, ' } }),
      sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'checking.", "kind": "answer", "ta' } }),
      sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'sk": "weather in irvine tonight"}' } }),
      sse({ type: "content_block_stop", index: 1 }),
      sse({ type: "message_stop" }),
    ];
    const ev = await collect(parseAnthropicTalker(feed(payloads)));
    expect(ev).toEqual([
      { type: "text", text: "[mood:thinking 0.5]" },
      { type: "stall", text: "one sec, checking." },
      { type: "delegate", call: { kind: "answer", task: "weather in irvine tonight", stall: "one sec, checking." } },
    ]);
  });

  test("anthropic: error event throws", async () => {
    await expect(collect(parseAnthropicTalker(feed([sse({ type: "error", error: { message: "overloaded" } })])))).rejects.toThrow(/overloaded/);
  });

  test("openai/gateway: tool_calls arguments stream in pieces; one delegate at finish", async () => {
    const payloads = [
      sse({ choices: [{ delta: { role: "assistant", content: "" } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "delegate", arguments: "" } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"stall":"ooh, lemme look.",' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"kind":"do","task":"book ramen at 8"}' } }] } }] }),
      sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      "[DONE]",
    ];
    const ev = await collect(parseOpenAiTalker(feed(payloads)));
    expect(ev).toEqual([
      { type: "stall", text: "ooh, lemme look." },
      { type: "delegate", call: { kind: "do", task: "book ramen at 8", stall: "ooh, lemme look." } },
    ]);
  });

  test("openai: plain answer is just text", async () => {
    const ev = await collect(parseOpenAiTalker(feed([sse({ choices: [{ delta: { content: "canberra." } }] }), sse({ choices: [{ delta: {}, finish_reason: "stop" }] }), "[DONE]"])));
    expect(ev).toEqual([{ type: "text", text: "canberra." }]);
  });

  test("inline protocol: normal replies pass through, a >>delegate line becomes a call", async () => {
    expect(await collect(parseInlineTalker(feed(["can", "berra. obviously."])))).toEqual([
      { type: "text", text: "can" },
      { type: "text", text: "berra. obviously." },
    ]);
    const ev = await collect(parseInlineTalker(feed(["[mood:thinking 0.4] >", ">delegate answer | ooh, lemme look. | weather ", "in irvine tonight"])));
    expect(ev).toEqual([
      { type: "stall", text: "ooh, lemme look." },
      { type: "delegate", call: { kind: "answer", task: "weather in irvine tonight", stall: "ooh, lemme look." } },
    ]);
    expect(parseInline(">>delegate do | on it | open spotify")).toEqual({ kind: "do", task: "open spotify", stall: "on it" });
    expect(parseInline(">>delegate", "fallback task")).toEqual({ kind: "answer", task: "fallback task" });
    const p = new InlineDelegateParser();
    expect(p.push(">")).toBe("");
    expect(p.push(" hi")).toBe("> hi");
  });

  test("claude CLI: obvious lookups are routed by keyword without spawning the CLI", async () => {
    let spawned = false;
    const io = { secret: () => "", which: () => "/bin/claude", spawn: () => ((spawned = true), null as never), workDir: "/tmp", now: Date.now, fetch: fetch } as unknown as BrainIO;
    const ev = await collect(claudeCliTalker(io).stream({ system: "s", user: "u" }, { userText: "what's the weather in irvine?" }));
    expect(spawned).toBe(false);
    expect(ev.at(-1)).toMatchObject({ type: "delegate", call: { kind: "answer", task: "what's the weather in irvine?" } });
    expect(lookupIntent("what's on my calendar tomorrow")).toBe(true);
    expect(lookupIntent("what's the capital of australia")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// talker runs: fallthrough, stall text, replay, abort
// ---------------------------------------------------------------------------

function scripted(name: string, events: TalkerEvent[] | (() => AsyncGenerator<TalkerEvent>), o: { fail?: Error; delayMs?: number; tools?: "native" | "inline" } = {}) {
  const calls: { signal?: AbortSignal; userText?: string }[] = [];
  const b: TalkerBackend & { calls: typeof calls } = {
    name,
    tools: o.tools ?? "native",
    calls,
    configured: () => true,
    model: () => `${name}-model`,
    async *stream(_msg, opts = {}) {
      calls.push({ signal: opts.signal, userText: opts.userText });
      if (o.fail) throw o.fail;
      if (typeof events === "function") return yield* events();
      for (const e of events) {
        if (o.delayMs) await Bun.sleep(o.delayMs);
        if (opts.signal?.aborted) return;
        yield e;
      }
    },
  };
  return b;
}

const ioStub = { now: Date.now } as unknown as BrainIO;
const talkerOf = (backends: TalkerBackend[]) => createTalker({ io: ioStub, backends, prompt: (r) => ({ system: "s", user: r.userText }), maxTokens: () => 200 });

describe("talker run", () => {
  test("falls through to the next backend when one fails before a word", async () => {
    const a = scripted("anthropic", [], { fail: new Error("http 401") });
    const g = scripted("gateway", [{ type: "text", text: "canberra. " }, { type: "text", text: "obviously." }]);
    const run = talkerOf([a, g]).start({ userText: "capital of australia?" });
    await run.finished;
    expect(run.backend).toBe("gateway");
    expect(run.said).toBe("canberra. obviously.");
    expect(run.call).toBeNull();
    expect(run.errors[0]).toContain("anthropic");
  });

  test("a delegation with no words of its own speaks the stall as text", async () => {
    const g = scripted("gateway", [{ type: "text", text: "[mood:thinking 0.6]" }, { type: "stall", text: "one sec, checking" }, { type: "delegate", call: { kind: "answer", task: "weather", stall: "one sec, checking" } }]);
    const run = talkerOf([g]).start({ userText: "weather?" });
    expect(await run.delegation).toEqual({ kind: "answer", task: "weather", stall: "one sec, checking" });
    await run.finished;
    expect(run.said).toContain("one sec, checking.");
  });

  test("no stall when she already said something herself", async () => {
    const g = scripted("gateway", [{ type: "text", text: "oh, let me grab that. " }, { type: "stall", text: "loading the vibes" }, { type: "delegate", call: { kind: "do", task: "play lofi" } }]);
    const run = talkerOf([g]).start({ userText: "play lofi" });
    await run.finished;
    expect(run.said).toBe("oh, let me grab that. ");
  });

  test("late readers replay from the first word; abort stops the backend", async () => {
    const r = new Replay<string>();
    r.push("a");
    r.push("b");
    const reading = collect(r.read());
    r.push("c");
    r.close();
    expect(await reading).toEqual(["a", "b", "c"]);

    const slow = scripted("gateway", [{ type: "text", text: "one. " }, { type: "text", text: "two. " }, { type: "text", text: "three." }], { delayMs: 30 });
    const run = talkerOf([slow]).start({ userText: "count" });
    await Bun.sleep(5);
    run.abort("jev said IGNORE");
    await run.finished;
    expect(slow.calls[0]!.signal!.aborted).toBe(true);
    expect(run.aborted).toBe(true);
    expect(await run.delegation).toBeNull();
  });

  test("error chatter from a backend is never spoken: falls through", async () => {
    const bad = scripted("gateway", [{ type: "text", text: "API Error: insufficient_quota. try again in 20s." }]);
    const good = scripted("claude-cli", [{ type: "text", text: "hm. fine." }], { tools: "inline" });
    const run = talkerOf([bad, good]).start({ userText: "yo" });
    await run.finished;
    expect(run.said).toBe("hm. fine.");
  });
});

// ---------------------------------------------------------------------------
// narration, gaps, cancel, latency (pure)
// ---------------------------------------------------------------------------

describe("narration + gaps", () => {
  test("progress phrases: tools map to plain words, junk is skipped", () => {
    expect(progressPhrase({ kind: "tool", tool: "WebSearch" }, 3)).toBe("searching the web.");
    expect(progressPhrase({ kind: "tool", tool: "mcp:calendar.list_events" }, 0)).toBe("still on it, checking your calendar.");
    expect(progressPhrase({ kind: "swarm", text: "Scout: found three ramen spots, checking hours." }, 1)).toBe("okay, found three ramen spots, checking hours.");
    expect(progressPhrase({ kind: "swarm", text: "Error: ECONNRESET" })).toBeNull();
    expect(progressPhrase({ kind: "swarm", text: "ok" })).toBeNull();
  });

  test("rate limited: nothing in the grace period, then at most one per 6s, no repeats", () => {
    const clock = new FakeClock(1_000_000);
    const n = new Narrator({ now: clock.now });
    const start = clock.now();
    const p = { kind: "tool" as const, tool: "WebSearch" };
    expect(n.offer(p, start)).toBeNull(); // grace
    clock.advance(4000);
    expect(n.offer(p, start)).toBe("still on it, searching the web.");
    clock.advance(2000);
    expect(n.offer({ kind: "tool", tool: "WebFetch" }, start)).toBeNull(); // too soon
    clock.advance(4500);
    expect(n.offer(p, start)).toBeNull(); // same thing again
    expect(n.offer({ kind: "tool", tool: "WebFetch" }, start)).toBe("okay, reading a page.");
    n.spoke();
    clock.advance(3000);
    expect(n.offer({ kind: "tool", tool: "Read" }, start)).toBeNull();
  });

  test("waitForGap holds while either of them talks, and until he's been quiet", async () => {
    let t = 0;
    let speaking = true;
    let user = false;
    let lastUser = 0;
    const probe = { speaking: () => speaking, userSpeaking: () => user, lastUserAt: () => lastUser, now: () => t, sleep: async (ms: number) => {
      await Bun.sleep(0);
      t += ms;
    } };
    const at: number[] = [];
    const p = waitForGap(probe, { quietMs: 1000, maxMs: 60_000, pollMs: 100 }).then((ok) => at.push(t, ok ? 1 : 0));
    // she's talking until t=500, then he talks until 1500
    while (t < 500) await Bun.sleep(0);
    speaking = false;
    user = true;
    while (t < 1500) await Bun.sleep(0);
    user = false;
    lastUser = 1500;
    await p;
    expect(at[0]).toBeGreaterThanOrEqual(2500);
    expect(at[1]).toBe(1);
    // gives up after maxMs
    speaking = true;
    const t0 = t;
    expect(await waitForGap(probe, { maxMs: 3000, pollMs: 500 })).toBe(false);
    expect(t - t0).toBeGreaterThanOrEqual(3000);
  });

  test("cancel phrases", () => {
    for (const s of ["never mind", "nvm", "forget it", "actually never mind", "cancel that", "scratch that", "don't worry about it"]) expect(isCancel(s)).toBe(true);
    for (const s of ["never mind the weather, what about tomorrow", "i forgot my keys", "cancel my 3pm meeting"]) expect(isCancel(s)).toBe(false);
  });

  test("latency book: end of speech -> first reply audio per backend, fillers count as sound only", () => {
    const b = new LatencyBook();
    b.endOfSpeech(1000);
    b.utterance("u1", "talker:r1");
    expect(b.segment(1400, "u1", true, true, () => "gateway")).toBeNull(); // filler
    const s = b.segment(1900, "u1", true, false, () => "gateway")!;
    expect(s).toMatchObject({ backend: "gateway", soundMs: 400, replyMs: 900 });
    expect(b.segment(2500, "u1", true, false, () => "gateway")).toBeNull(); // only the first
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(b.summary().gateway).toMatchObject({ n: 1, replyP50: 900 });
  });
});

// ---------------------------------------------------------------------------
// the reflex with a talker: routing end to end on the bus
// ---------------------------------------------------------------------------

const persona = {
  name: "Eve",
  tagline: "",
  description: "",
  personality: "",
  scenario: "",
  dials: { humor: 0.7, sarcasm: 0.6, warmth: 0.5, initiative: 0.5, verbosity: 0.3, chaos: 0.2 },
  voice: { provider: "x", voiceId: "x", style: "x" },
  palette: { hue: 0 },
  vector: {},
};

class ThinkerBrains extends FakeBrains {
  frontiers: FrontierRequest[] = [];
  answer: () => Promise<{ ok: boolean; text: string }> = async () => ({ ok: true, text: "72 and clear tonight in irvine." });
  constructor() {
    super((r) => (r.behavior === "report" ? "72 and clear. jacket optional." : `(${r.behavior}) sure`));
  }
  override async frontier(req: FrontierRequest) {
    this.frontiers.push(req);
    const r = await this.answer();
    return { ...r, engine: "jabby", ms: 5 };
  }
}

async function talkerRig(backend: TalkerBackend | (() => TalkerBackend), routerOpts: NonNullable<Parameters<typeof reflexModule>[0]>["router"] = {}) {
  const clock = new FakeClock(Date.now());
  const ctx = fakeContext();
  ctx.config.demo = false;
  const speech = new FakeSpeech(ctx, clock);
  const brains = new ThinkerBrains();
  const memory = new FakeMemory(ctx, []);
  const agency = new FakeAgency();
  ctx.provide("speech", speech);
  ctx.provide("brains", brains);
  ctx.provide("memory", memory);
  ctx.provide("agency", agency);
  const runs: ReturnType<ReturnType<typeof talkerOf>["start"]>[] = [];
  const make = typeof backend === "function" ? backend : () => backend;
  const service: TalkerService = {
    available: () => true,
    start(req) {
      const run = talkerOf([make()]).start(req);
      runs.push(run);
      return handle(run);
    },
  };
  ctx.provide("talker", service);
  const stop = await startModules(ctx, [reflexModule({ now: clock.now, jev: createJev({}), router: { sleep: (ms) => Bun.sleep(Math.min(ms, 5)), ...routerOpts } })]);
  const emit = <K extends EventType>(type: K, data: EventMap[K]) => emitAt(ctx, clock, type, data);
  emit("companion.born", { persona });
  await settle(10);
  speech.said.length = 0;
  brains.requests.length = 0;
  runs.length = 0;
  clock.advance(120_000);
  return { ctx, clock, speech, brains, agency, memory, runs, stop, emit };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await Bun.sleep(2);
  }
};

describe("reflex + talker", () => {
  test("a question to her is answered by the talker, not the persona brain", async () => {
    const r = await talkerRig(() => scripted("gateway", [{ type: "text", text: "canberra. " }, { type: "text", text: "sydney's still mad." }]));
    r.emit("voice.final", { text: "eve what's the capital of australia?" });
    await until(() => r.speech.said.length > 0);
    expect(r.speech.said[0]!.text).toBe("canberra. sydney's still mad.");
    expect(r.speech.said[0]!.opts!.brain).toMatch(/^talker:/);
    expect(r.brains.requests.length).toBe(0);
    expect(r.runs.length).toBe(1);
    await r.stop();
  });

  test("parallel Jev: the talker starts before the verdict and IGNORE (not addressed) kills it", async () => {
    const r = await talkerRig(() => scripted("gateway", [{ type: "text", text: "wow. " }, { type: "text", text: "rude." }], { delayMs: 20 }));
    // Mid-conversation window has lapsed, no name, no action: room chatter.
    r.emit("voice.final", { text: "the game last night was crazy" });
    await settle(20);
    await Bun.sleep(60);
    expect(r.runs.length).toBe(1);
    expect(r.runs[0]!.aborted).toBe(true);
    expect(r.runs[0]!.abortReason).toBe("IGNORE");
    expect(r.speech.said.length).toBe(0);
    await r.stop();
  });

  test("delegate answer: stall first, thinker (frontier with tools) in the background, result through her voice", async () => {
    const r = await talkerRig(() => scripted("gateway", [{ type: "stall", text: "ooh, lemme look" }, { type: "delegate", call: { kind: "answer", task: "weather in irvine tonight", stall: "ooh, lemme look" } }]));
    const delegates: unknown[] = [];
    r.ctx.bus.on("talker.delegate", (e) => delegates.push(e.data));
    r.emit("voice.final", { text: "eve what's the weather tonight?" });
    await until(() => r.speech.said.length >= 2);
    expect(r.speech.said[0]!.text.trim()).toBe("ooh, lemme look.");
    expect(r.brains.frontiers[0]!.tools).toBe("read");
    expect(r.brains.frontiers[0]!.goal).toContain("weather in irvine tonight");
    expect(r.brains.requests.at(-1)!.behavior).toBe("report");
    expect(r.brains.requests.at(-1)!.extra).toContain("72 and clear tonight in irvine.");
    expect(r.speech.said[1]!.text).toBe("72 and clear. jacket optional.");
    expect(delegates[0]).toMatchObject({ kind: "answer", task: "weather in irvine tonight", backend: "gateway" });
    await r.stop();
  });

  test("delegate with no stall and no words: a prerendered ack clip covers it", async () => {
    const r = await talkerRig(() => scripted("gateway", [{ type: "delegate", call: { kind: "answer", task: "latest news" } }]));
    r.emit("voice.final", { text: "eve anything big happen today?" });
    await until(() => r.speech.said.length >= 1);
    expect(ACK_CLIPS).toContain(r.speech.said[0]!.text);
    await r.stop();
  });

  test("delegate do: goes through agency with no second ack line", async () => {
    const r = await talkerRig(() => scripted("gateway", [{ type: "stall", text: "on it" }, { type: "delegate", call: { kind: "do", task: "find a quiet cafe near me that's open late and save it" } }]));
    r.agency.result = { ok: true, summary: "saved blue bottle, open till 11." };
    r.emit("voice.final", { text: "eve can you sort me a cafe for later" });
    await until(() => r.speech.said.length >= 2);
    expect(r.agency.tasks[0]!.goal).toBe("Find a quiet cafe near me that's open late and save it");
    expect(r.speech.said.map((s) => s.text.trim())).toEqual(["on it.", "saved blue bottle, open till 11."]);
    expect(r.speech.said.some((s) => ACK_LINES.includes(s.text))).toBe(false);
    await r.stop();
  });

  test("the result waits for a gap: not while she's talking", async () => {
    const r = await talkerRig(() => scripted("gateway", [{ type: "stall", text: "checking" }, { type: "delegate", call: { kind: "answer", task: "weather" } }]), { gapMaxMs: 60_000 });
    r.speech.talking = true; // she's mid-sentence about something else
    r.emit("voice.final", { text: "eve what's the weather?" });
    await until(() => r.speech.said.length >= 1);
    await until(() => r.brains.frontiers.length === 1);
    await Bun.sleep(40);
    expect(r.speech.said.length).toBe(1);
    r.speech.talking = false;
    await until(() => r.speech.said.length >= 2);
    expect(r.speech.said[1]!.text).toBe("72 and clear. jacket optional.");
    await r.stop();
  });

  test("he can keep chatting while the thinker works; 'never mind' cancels it", async () => {
    let release!: () => void;
    let frontierSignal: AbortSignal | undefined;
    let n = 0;
    const r = await talkerRig(() =>
      n++ === 0
        ? scripted("gateway", [{ type: "stall", text: "lemme look" }, { type: "delegate", call: { kind: "answer", task: "flights to tokyo in march" } }])
        : scripted("gateway", [{ type: "text", text: "mm, pad thai. always." }]),
    );
    r.brains.answer = () => new Promise((res) => (release = () => res({ ok: true, text: "cheapest is $640 on zipair." })));
    const orig = r.brains.frontier.bind(r.brains);
    r.brains.frontier = async (req) => {
      frontierSignal = req.signal;
      return orig(req);
    };
    r.emit("voice.final", { text: "eve find me flights to tokyo in march" });
    await until(() => r.brains.frontiers.length === 1);
    r.emit("voice.final", { text: "what should i eat tonight?" });
    await until(() => r.speech.said.length >= 2);
    expect(r.speech.said[1]!.text).toBe("mm, pad thai. always.");
    r.emit("voice.final", { text: "actually never mind" });
    await until(() => r.speech.said.length >= 3);
    expect(frontierSignal!.aborted).toBe(true);
    expect(["okay, dropped it.", "okay. forget it.", "mm, never mind then."]).toContain(r.speech.said[2]!.text);
    release();
    await Bun.sleep(30);
    expect(r.speech.said.length).toBe(3); // the result is never spoken
    await r.stop();
  });

  test("progress narration during a long thinker run is rate limited", async () => {
    let release!: () => void;
    const r = await talkerRig(() => scripted("gateway", [{ type: "stall", text: "lemme look" }, { type: "delegate", call: { kind: "answer", task: "compare ramen spots" } }]));
    r.brains.answer = () => new Promise((res) => (release = () => res({ ok: true, text: "nagi wins." })));
    r.emit("voice.final", { text: "eve which ramen place is best near me" });
    await until(() => r.brains.frontiers.length === 1);
    const onEvent = r.brains.frontiers[0]!.onEvent!;
    r.clock.advance(6500); // the stall counts as her last update
    onEvent({ kind: "tool", name: "WebSearch" });
    onEvent({ kind: "tool", name: "WebFetch" }); // too soon
    r.emit("swarm.progress", { taskId: "t", agentId: "a", text: "found three spots, checking hours" }); // too soon
    r.clock.advance(6500);
    r.emit("swarm.progress", { taskId: "t", agentId: "a", text: "found three spots, checking hours" });
    await settle(5);
    const narr = r.speech.said.filter((s) => s.opts?.brain === "narration").map((s) => s.text);
    expect(narr).toEqual(["still on it, searching the web.", "okay, found three spots, checking hours."]);
    release();
    await until(() => r.speech.said.some((s) => s.opts?.brain === "thinker"));
    await r.stop();
  });

  test("flux: endOfTurn finals skip the merge wait; eager + same final adopts the speculative run", async () => {
    const r = await talkerRig(() => scripted("gateway", [{ type: "text", text: "sure thing." }]));
    r.emit("voice.eager", { text: "eve tell me a joke" });
    await settle(5);
    expect(r.runs.length).toBe(1);
    r.emit("voice.final", { text: "Eve, tell me a joke.", endOfTurn: true });
    await until(() => r.speech.said.length >= 1);
    expect(r.runs.length).toBe(1); // adopted, not restarted
    expect(r.speech.said[0]!.text).toBe("sure thing.");
    await r.stop();
  });

  test("flux: TurnResumed drops the speculation; a different final starts fresh", async () => {
    const r = await talkerRig(() => scripted("gateway", [{ type: "text", text: "okay." }], { delayMs: 10 }));
    r.emit("voice.eager", { text: "eve tell me" });
    await settle(5);
    r.emit("voice.resumed", {});
    await settle(5);
    expect(r.runs[0]!.aborted).toBe(true);
    r.emit("voice.eager", { text: "eve tell me a" });
    await settle(5);
    r.emit("voice.final", { text: "eve tell me a story about space", endOfTurn: true });
    await until(() => r.speech.said.length >= 1);
    expect(r.runs.length).toBe(3);
    expect(r.runs[1]!.aborted).toBe(true);
    expect(r.runs[2]!.req.userText).toBe("eve tell me a story about space");
    await r.stop();
  });
});
