import { describe, expect, test } from "bun:test";
import type { SpeechMark } from "@eigenwife/protocol";
import type { AudioEngine, Playback } from "./engine";
import { SpeechPlayer, type PlayerHooks } from "./player";
import type { Segment } from "./queue";
import { ChunkBuffer, parseWav, PcmDecoder, SpeechRate, TimedMarks } from "./stream";

const enc = (s: string) => new TextEncoder().encode(s);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A fetch whose body the test feeds chunk by chunk. */
function feedFetch() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
  return {
    fetch: async () => new Response(body),
    push: (s: string) => ctl.enqueue(enc(s)),
    end: () => ctl.close(),
    fail: () => ctl.error(new Error("net")),
  };
}

describe("chunk buffer", () => {
  test("downloads ahead; a reader gets everything from the start, following the stream", async () => {
    const f = feedFetch();
    const cb = new ChunkBuffer("/a.mp3", new AbortController().signal, f.fetch);
    f.push("aa");
    f.push("bb");
    await cb.atLeast(4);
    const got: string[] = [];
    const reading = (async () => {
      for await (const c of cb.read()) got.push(new TextDecoder().decode(c));
    })();
    await tick(5);
    expect(got).toEqual(["aa", "bb"]);
    f.push("cc");
    f.end();
    await reading;
    expect(got).toEqual(["aa", "bb", "cc"]);
    expect(new TextDecoder().decode(await cb.all())).toBe("aabbcc");
  });

  test("a failed download throws for readers; all() keeps what arrived", async () => {
    const f = feedFetch();
    const cb = new ChunkBuffer("/a.mp3", new AbortController().signal, f.fetch);
    f.push("xy");
    await cb.atLeast(2);
    f.fail();
    let err: unknown = null;
    try {
      for await (const _ of cb.read());
    } catch (e) {
      err = e;
    }
    expect(String(err)).toContain("net");
    expect(new TextDecoder().decode(await cb.all())).toBe("xy");
    const dead = new ChunkBuffer("/b.mp3", new AbortController().signal, async () => new Response("", { status: 404 }));
    await expect(dead.all()).rejects.toThrow("audio 404");
  });
});

describe("streaming wav", () => {
  test("parses the streaming header Aura's live route sends", () => {
    const h = new DataView(new ArrayBuffer(44));
    const w = (o: number, s: string) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
    w(0, "RIFF");
    h.setUint32(4, 0xffffffff, true);
    w(8, "WAVE");
    w(12, "fmt ");
    h.setUint32(16, 16, true);
    h.setUint16(20, 1, true);
    h.setUint16(22, 1, true);
    h.setUint32(24, 24000, true);
    h.setUint32(28, 48000, true);
    h.setUint16(32, 2, true);
    h.setUint16(34, 16, true);
    w(36, "data");
    h.setUint32(40, 0xffffffff, true);
    expect(parseWav(new Uint8Array(h.buffer))).toEqual({ sampleRate: 24000, channels: 1, bits: 16, dataOffset: 44 });
    expect(parseWav(new Uint8Array(h.buffer).slice(0, 30))).toBeNull();
    expect(parseWav(enc("ID3 not a wav at all"))).toBeNull();
  });

  test("pcm decoder carries a split sample over to the next chunk", () => {
    const d = new PcmDecoder(1);
    const bytes = new Uint8Array(new Int16Array([16384, -32768, 32767]).buffer);
    const a = d.push(bytes.slice(0, 3));
    expect(Array.from(a[0]!)).toEqual([0.5]);
    const b = d.push(bytes.slice(3));
    expect(Array.from(b[0]!)).toEqual([-1, 32767 / 32768]);
  });
});

describe("streamed mark timing", () => {
  const marks: SpeechMark[] = [
    { at: 0, mood: "smug" },
    { at: 5, mood: "happy" },
    { at: 10, mood: "sad" },
  ];

  test("marks fire by playback position against the estimate until the real length is known", () => {
    const m = new TimedMarks("0123456789", marks, 1000);
    expect(m.due(0, null).map((x) => x.mood)).toEqual(["smug"]);
    expect(m.due(400, null)).toEqual([]);
    expect(m.due(500, null).map((x) => x.mood)).toEqual(["happy"]);
    // the stream finished downloading: real length 2000ms, so "sad" waits for 2000
    expect(m.due(1500, 2000)).toEqual([]);
    expect(m.due(2000, 2000).map((x) => x.mood)).toEqual(["sad"]);
    expect(m.rest()).toEqual([]);
  });

  test("a stalled stream holds its marks back; the end flushes the rest", () => {
    const m = new TimedMarks("0123456789", marks, 1000);
    m.due(0, null);
    expect(m.due(100, null)).toEqual([]); // playback stuck at 100ms
    expect(m.due(100, null)).toEqual([]);
    expect(m.rest().map((x) => x.mood)).toEqual(["happy", "sad"]);
  });

  test("speaking rate learns from played segments, clamped", () => {
    const r = new SpeechRate(65);
    expect(r.estimate("x".repeat(20))).toBe(1300);
    r.learn("x".repeat(20), 2000); // 100ms/char
    expect(r.msPerChar).toBeCloseTo(65 * 0.7 + 100 * 0.3);
    r.learn("short", 5000); // too short to trust
    expect(r.msPerChar).toBeCloseTo(65 * 0.7 + 100 * 0.3);
    r.learn("x".repeat(20), 100_000);
    expect(r.msPerChar).toBeLessThanOrEqual(140);
  });
});

// ---------------------------------------------------------------------------
// The player with a fake engine: queue order, abort, fallback, marks
// ---------------------------------------------------------------------------

class FakePlayback implements Playback {
  t = 0;
  dur: number | null = null;
  started = false;
  stopped = false;
  refuse = false;
  private ended: (() => void) | null = null;
  constructor(
    public url: string,
    public streamed: boolean,
  ) {}
  async start(onEnded: () => void) {
    if (this.refuse) throw new Error("NotAllowedError");
    this.started = true;
    this.ended = onEnded;
  }
  time() {
    return this.t;
  }
  duration() {
    return this.dur;
  }
  stop() {
    this.stopped = true;
  }
  finish(durMs = 1000) {
    this.dur = durMs;
    this.t = durMs;
    this.ended?.();
  }
}

function rig(opts: { delay?: (url: string, stream: boolean) => number; fail?: (url: string) => boolean; refuse?: (url: string) => boolean } = {}) {
  const made: FakePlayback[] = [];
  const prepared: string[] = [];
  const engine: AudioEngine = {
    running: () => true,
    level: () => null,
    async prepare(url, stream, signal) {
      prepared.push(url);
      await tick(opts.delay?.(url, stream) ?? 1);
      if (signal.aborted || opts.fail?.(url)) return null;
      const p = new FakePlayback(url, stream);
      p.refuse = opts.refuse?.(url) ?? false;
      made.push(p);
      return p;
    },
  };
  const log: string[] = [];
  const hooks: PlayerHooks = {
    played: (u, seq) => log.push(`played ${u}#${seq}`),
    mark: (m) => log.push(`mark ${m.mood}`),
    utteranceDone: (u, interrupted) => log.push(`done ${u}${interrupted ? " interrupted" : ""}`),
    subtitle: () => {},
    mouth: () => {},
  };
  const player = new SpeechPlayer(hooks, (u) => `http://core${u}`, engine);
  const playing = () => made.find((p) => p.started && !p.stopped && !(p.dur !== null && p.t >= p.dur));
  return { player, made, prepared, log, playing };
}

const seg = (utteranceId: string, seq: number, over: Partial<Segment> = {}): Segment => ({ utteranceId, seq, text: `segment ${seq} text`, marks: [], ...over });

async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await tick(2);
  }
}

describe("player with streamed segments", () => {
  test("mixed streamed and cached segments play in strict order; the next is prepared while one plays", async () => {
    // cached files are slow to prepare (whole download + decode), streams are quick
    const r = rig({ delay: (_u, stream) => (stream ? 1 : 40) });
    r.player.begin("u");
    r.player.segment(seg("u", 0, { audioUrl: "/api/audio/aaa.mp3" }));
    r.player.segment(seg("u", 1, { audioUrl: "/api/audio/live/l1.mp3", stream: true }));
    r.player.segment(seg("u", 2, { audioUrl: "/api/audio/live/l2.wav", stream: true }));
    r.player.end("u");
    // all three start preparing immediately (pre-connect)
    expect(r.prepared).toEqual(["http://core/api/audio/aaa.mp3", "http://core/api/audio/live/l1.mp3", "http://core/api/audio/live/l2.wav"]);
    await until(() => !!r.playing());
    expect(r.playing()!.url).toEndWith("aaa.mp3");
    r.playing()!.finish();
    await until(() => r.playing()?.url.endsWith("l1.mp3") ?? false);
    expect(r.playing()!.streamed).toBe(true);
    r.playing()!.finish();
    await until(() => r.playing()?.url.endsWith("l2.wav") ?? false);
    r.playing()!.finish();
    await until(() => r.log.includes("done u"));
    expect(r.log.filter((l) => l.startsWith("played"))).toEqual(["played u#0", "played u#1", "played u#2"]);
  });

  test("abort mid-stream: the playing stream and the prepared next one are stopped, nothing more is reported played", async () => {
    const r = rig();
    r.player.begin("u");
    r.player.segment(seg("u", 0, { audioUrl: "/api/audio/live/a.mp3", stream: true }));
    r.player.segment(seg("u", 1, { audioUrl: "/api/audio/live/b.mp3", stream: true }));
    await until(() => !!r.playing() && r.made.length === 2);
    r.playing()!.t = 300;
    r.player.stop("barge-in");
    await tick(5);
    expect(r.made.every((p) => p.stopped)).toBe(true);
    expect(r.log).toEqual(["done u interrupted"]);
    expect(r.player.speaking).toBe(false);
  });

  test("fallback: audio that can't be prepared, or refuses to play, still gets said (speechSynthesis path)", async () => {
    const r = rig({ fail: (u) => u.includes("bad"), refuse: (u) => u.includes("shy") });
    r.player.begin("u");
    r.player.segment(seg("u", 0, { text: "hi.", audioUrl: "/api/audio/live/bad.mp3", stream: true }));
    r.player.segment(seg("u", 1, { text: "yo.", audioUrl: "/api/audio/live/shy.mp3", stream: true }));
    r.player.end("u");
    // no speechSynthesis in bun: the silent synth path times itself out
    await until(() => r.log.includes("done u"), 5000);
    expect(r.log.filter((l) => l.startsWith("played"))).toEqual(["played u#0", "played u#1"]);
    expect(r.made.find((p) => p.url.includes("shy"))!.stopped).toBe(true);
  });

  test("marks on a streamed segment follow its playback time, the rest fire at the end", async () => {
    const r = rig();
    r.player.begin("u");
    const text = "0123456789".repeat(2); // 20 chars, ~1300ms estimated at 65ms/char
    r.player.segment(
      seg("u", 0, {
        text,
        audioUrl: "/api/audio/live/m.mp3",
        stream: true,
        marks: [
          { at: 0, mood: "smug" },
          { at: 10, mood: "happy" },
          { at: 19, mood: "sad" },
        ],
      }),
    );
    r.player.end("u");
    await until(() => !!r.playing());
    const p = r.playing()!;
    await until(() => r.log.includes("mark smug"));
    await tick(60);
    expect(r.log.filter((l) => l.startsWith("mark"))).toEqual(["mark smug"]); // stream hasn't played that far
    p.t = 700; // past half of the 1300ms estimate
    await until(() => r.log.includes("mark happy"));
    expect(r.log.includes("mark sad")).toBe(false);
    p.finish(1800);
    await until(() => r.log.includes("done u"));
    expect(r.log.filter((l) => l.startsWith("mark"))).toEqual(["mark smug", "mark happy", "mark sad"]);
    // the real length taught the rate: 1800ms / 20 chars
    expect(r.player.rate.msPerChar).toBeCloseTo(65 * 0.7 + 90 * 0.3);
  });
});
