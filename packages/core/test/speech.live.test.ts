import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AnyEnvelope } from "@eigenwife/protocol";
import { EventBus } from "../src/bus";
import { LiveStreams } from "../src/speech/live";
import { speechModule } from "../src/speech/module";
import { createSpeech } from "../src/speech/service";
import { auraStream, elevenStream, type ChunkSink, type TtsSocket } from "../src/speech/sockets";
import { AudioCache, audioKey, elevenLabsTts, readAudio, Tts, type TtsBackend, type TtsIO } from "../src/speech/tts";
import { startCore, type RunningCore } from "../src/index";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "eve-live-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

async function readAll(body: ReadableStream<Uint8Array>, onChunk?: (s: string) => void): Promise<string> {
  const r = body.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await r.read();
    if (done) return out;
    out += dec(value);
    onChunk?.(dec(value));
  }
}

/** A controllable deferred. */
function gate() {
  let open: () => void = () => {};
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

/**
 * A streaming backend: each segment's audio comes in `parts` chunks, the
 * first after firstMs(text), the rest spaced by stepMs. `hold` keeps the last
 * chunk (and completion) back until released.
 */
function streamingBackend(opts: { firstMs?: (t: string) => number; stepMs?: number; parts?: number; hold?: Promise<void>; failAfterFirst?: boolean } = {}) {
  const log: { text: string; startedAt: number; doneAt: number }[] = [];
  const b: TtsBackend & { log: typeof log } = {
    name: "streamy",
    log,
    voiceKey: () => "streamy:v1",
    configured: () => true,
    async synth(text: string, signal?: AbortSignal, onChunk?: ChunkSink) {
      const entry = { text, startedAt: Date.now(), doneAt: 0 };
      log.push(entry);
      const parts: Uint8Array[] = [];
      const n = opts.parts ?? 3;
      await Bun.sleep(opts.firstMs?.(text) ?? 5);
      for (let i = 0; i < n; i++) {
        if (signal?.aborted) throw new Error("aborted");
        if (i === n - 1 && opts.hold) await opts.hold;
        const c = enc(`[${text}#${i}]`.padEnd(30, "."));
        parts.push(c);
        onChunk?.(c, "mp3");
        if (i === 0 && opts.failAfterFirst) throw new Error("socket died");
        if (i < n - 1) await Bun.sleep(opts.stepMs ?? 5);
      }
      entry.doneAt = Date.now();
      const bytes = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0));
      let o = 0;
      for (const p of parts) {
        bytes.set(p, o);
        o += p.byteLength;
      }
      return { bytes, ext: "mp3" as const };
    },
  };
  return b;
}

function rig(backend: TtsBackend, live = true) {
  const bus = new EventBus();
  const events: AnyEnvelope[] = [];
  const at = new Map<AnyEnvelope, number>();
  bus.on("*", (e) => {
    events.push(e);
    at.set(e, Date.now());
  });
  const tts = new Tts([backend], new AudioCache(tmp()), Date.now, undefined, { live });
  const speech = createSpeech({ bus, tts, fillerMs: 40, estimateMs: () => 20, slackMs: 10 });
  const segs = () => events.filter((e) => e.type === "speech.segment").map((e) => ({ ...(e.data as { utteranceId: string; seq: number; text: string; audioUrl?: string; stream?: boolean }), at: at.get(e)! }));
  return { bus, events, tts, speech, segs };
}

describe("live streams", () => {
  test("a reader gets buffered chunks, then follows new ones in order, then the end", async () => {
    const ls = new LiveStreams();
    const w = ls.open("a".repeat(64), "mp3");
    expect(w.url).toMatch(/^\/api\/audio\/live\/l[a-z0-9_]+\.mp3$/);
    w.push(enc("one,"));
    const got: string[] = [];
    const reading = readAll(ls.body(w.id)!, (s) => got.push(s));
    await Bun.sleep(5);
    expect(got).toEqual(["one,"]);
    w.push(enc("two,"));
    await Bun.sleep(5);
    expect(got).toEqual(["one,", "two,"]);
    w.push(enc("three"));
    w.end();
    expect(await reading).toBe("one,two,three");
    // A late reader still gets the whole thing.
    expect(await readAll(ls.body(w.id)!)).toBe("one,two,three");
    expect(ls.info(w.id)).toMatchObject({ live: true, done: true, bytes: 13 });
  });

  test("finished streams expire into a content-hash pointer; failed ones are forgotten", () => {
    let t = 0;
    const ls = new LiveStreams(() => t, 1000);
    const ok = ls.open("b".repeat(64), "wav");
    ok.push(enc("x"));
    ok.end();
    const bad = ls.open("c".repeat(64), "mp3");
    bad.end(true);
    t = 5000;
    ls.open("d".repeat(64), "mp3"); // opening sweeps
    expect(ls.info(ok.id)).toEqual({ sha: "b".repeat(64), ext: "wav", live: false, done: true, bytes: 0 });
    expect(ls.body(ok.id)).toBeNull();
    expect(ls.info(bad.id)).toBeNull();
  });
});

describe("tts render with onLive", () => {
  test("onLive fires at the first chunk with a live url; the whole segment is still cached by content hash", async () => {
    const hold = gate();
    const b = streamingBackend({ hold: hold.p });
    const tts = new Tts([b], new AudioCache(tmp()));
    let live: { url: string; stream?: boolean; sha: string } | null = null;
    const done = tts.render("hello there.", undefined, { onLive: (r) => (live = r) });
    while (!live) await Bun.sleep(2);
    const l = live as { url: string; stream?: boolean; sha: string };
    expect(l.stream).toBe(true);
    expect(l.url).toMatch(/^\/api\/audio\/live\//);
    expect(l.sha).toBe(audioKey("streamy:v1", "hello there."));
    expect(b.log[0]!.doneAt).toBe(0); // still synthesizing
    const id = l.url.match(/live\/(.+)\.mp3$/)![1]!;
    const reading = readAll(tts.streams!.body(id)!);
    hold.open();
    const r = (await done)!;
    expect(r.stream).toBeUndefined();
    expect(r.url).toBe(`/api/audio/${r.sha}.mp3`);
    const cached = readFileSync(tts.cache.path(r.sha, "mp3"), "utf8");
    expect(await reading).toBe(cached);
    expect(cached).toStartWith("[hello there.#0]");
    expect(cached).toContain("[hello there.#2]");
  });

  test("without onLive (prerender, probe) nothing streams", async () => {
    const tts = new Tts([streamingBackend()], new AudioCache(tmp()));
    const r = (await tts.render("plain."))!;
    expect(r.stream).toBeUndefined();
    expect(tts.streams!.size).toBe(0);
  });

  test("a backend dying after it streamed part of a segment doesn't restart it in another voice", async () => {
    const dying = streamingBackend({ failAfterFirst: true });
    let second = 0;
    const other: TtsBackend = {
      name: "other",
      voiceKey: () => "other:v1",
      configured: () => true,
      async synth() {
        second++;
        return { bytes: enc("x".repeat(80)), ext: "mp3" };
      },
    };
    const tts = new Tts([dying, other], new AudioCache(tmp()));
    let live: { url: string } | null = null;
    const r = await tts.render("oops.", undefined, { onLive: (x) => (live = x) });
    expect(r).toBeNull();
    expect(live).not.toBeNull();
    expect(second).toBe(0);
    const id = live!.url.match(/live\/(.+)\.mp3$/)![1]!;
    expect(await readAll(tts.streams!.body(id)!)).toStartWith("[oops.#0]"); // readers just see the end
  });
});

describe("early emission", () => {
  test("streamed segments go out at their first bytes, before synthesis finishes, flagged stream", async () => {
    const hold = gate();
    const r = rig(streamingBackend({ hold: hold.p }));
    const said = r.speech.say("first bit here. second bit there.");
    while (r.segs().length < 2) await Bun.sleep(2);
    expect(r.segs().map((s) => [s.seq, s.stream])).toEqual([
      [0, true],
      [1, true],
    ]);
    expect(r.segs().every((s) => /^\/api\/audio\/live\//.test(s.audioUrl ?? ""))).toBe(true);
    hold.open();
    await said;
  });

  test("strict order: a later segment that starts streaming first still waits for the one before it", async () => {
    const b = streamingBackend({ firstMs: (t) => (t.startsWith("slow") ? 80 : 2) });
    const r = rig(b);
    await r.speech.say("slow start one. quick two. quick three.");
    expect(r.segs().map((s) => s.text)).toEqual(["slow start one.", "quick two.", "quick three."]);
    expect(r.segs().map((s) => s.seq)).toEqual([0, 1, 2]);
    // seg 0 went out before its own synthesis finished
    const slow = b.log.find((l) => l.text === "slow start one.")!;
    while (!slow.doneAt) await Bun.sleep(2);
    expect(r.segs()[0]!.at).toBeLessThan(b.log.find((l) => l.text === "slow start one.")!.doneAt);
  });

  test("cached lines keep the plain file url; live off (EVE_TTS_LIVE=0) waits for whole files", async () => {
    const b = streamingBackend();
    const r = rig(b);
    await r.speech.say("again and again.");
    while (!b.log[0]?.doneAt) await Bun.sleep(2);
    await Bun.sleep(2);
    await r.speech.say("again and again.");
    const [a, c] = r.segs();
    expect(a!.stream).toBe(true);
    expect(c!.stream).toBeUndefined();
    expect(c!.audioUrl).toMatch(/^\/api\/audio\/[a-f0-9]{64}\.mp3$/);

    const off = rig(streamingBackend(), false);
    await off.speech.say("no live here.");
    expect(off.segs()[0]!.stream).toBeUndefined();
    expect(off.segs()[0]!.audioUrl).toMatch(/^\/api\/audio\/[a-f0-9]{64}\.mp3$/);
  });

  test("stop mid-stream: the live stream ends, nothing after the cut is emitted", async () => {
    const hold = gate();
    const r = rig(streamingBackend({ hold: hold.p, firstMs: (t) => (t.startsWith("later") ? 200 : 2) }));
    const said = r.speech.say("right now. later on.");
    while (r.segs().length < 1) await Bun.sleep(2);
    const url = r.segs()[0]!.audioUrl!;
    const id = url.match(/live\/(.+)\.mp3$/)![1]!;
    const reading = readAll(r.tts.streams!.body(id)!);
    r.speech.stop("barge-in");
    hold.open();
    await said;
    await reading; // ends instead of hanging
    expect(r.tts.streams!.info(id)!.done).toBe(true);
    expect(r.segs().length).toBe(1);
  });
});

describe("live route", () => {
  let core: RunningCore;
  let tts: Tts;
  const hold = gate();
  const port = 17000 + Math.floor(Math.random() * 900);
  beforeAll(async () => {
    process.env.EIGEN_QUIET = "1";
    tts = new Tts([streamingBackend({ hold: hold.p, stepMs: 10 })], new AudioCache(tmp()));
    core = await startCore([speechModule({ tts, estimateMs: () => 10, slackMs: 5 })], { port, eveHome: tmp() });
  });
  afterAll(() => core.stop());

  test("pipes chunks in order while synthesizing, tees to the cache, then serves the cached file after expiry", async () => {
    const said = core.ctx.use("speech").say("stream me.");
    let seg: { audioUrl: string; stream?: boolean } | undefined;
    while (!seg) {
      seg = core.ctx.bus.recent("speech.segment", 1)[0]?.data as typeof seg;
      await Bun.sleep(2);
    }
    expect(seg.stream).toBe(true);
    const res = await fetch(`http://127.0.0.1:${port}${seg.audioUrl}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const chunks: string[] = [];
    const body = readAll(res.body!, (s) => chunks.push(s));
    while (chunks.join("").length < 60) await Bun.sleep(2); // first two chunks arrive before synthesis is done
    expect(chunks.join("")).toStartWith("[stream me.#0]");
    expect(chunks.join("")).not.toContain("#2]");
    hold.open();
    const all = await body;
    await said;
    expect(all.indexOf("#0]")).toBeLessThan(all.indexOf("#1]"));
    expect(all.indexOf("#1]")).toBeLessThan(all.indexOf("#2]"));
    const sha = audioKey("streamy:v1", "stream me.");
    expect(readFileSync(tts.cache.path(sha, "mp3"), "utf8")).toBe(all);
    // the plain cached url serves the same bytes (replays)
    expect(await (await fetch(`http://127.0.0.1:${port}/api/audio/${sha}.mp3`)).text()).toBe(all);
    // wrong ext and unknown ids 404
    expect((await fetch(`http://127.0.0.1:${port}${seg.audioUrl.replace(".mp3", ".wav")}`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/api/audio/live/lnope_zzzzzz.mp3`)).status).toBe(404);
  });
});

/** Fake socket plumbing for the streaming sockets. */
class FakeSock implements TtsSocket {
  readyState = 0;
  sent: any[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(private behave: (s: FakeSock, m: any) => void) {
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
    }, 1);
  }
  send(d: string) {
    const m = JSON.parse(d);
    this.sent.push(m);
    queueMicrotask(() => this.behave(this, m));
  }
  reply(o: unknown) {
    this.onmessage?.({ data: typeof o === "string" || o instanceof ArrayBuffer ? o : JSON.stringify(o) });
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "bye" });
  }
}

describe("streaming sockets hand chunks out as they arrive", () => {
  test("elevenlabs: each audio message is a chunk, in order", async () => {
    const factory = () =>
      new FakeSock((s, m) => {
        if (m.flush) {
          s.reply({ audio: Buffer.from("A".repeat(40)).toString("base64"), contextId: m.context_id });
          s.reply({ audio: Buffer.from("B".repeat(40)).toString("base64"), contextId: m.context_id });
        }
        if (m.close_context) s.reply({ isFinal: true, contextId: m.context_id });
      });
    const el = elevenStream({ key: () => "k", voice: () => "v", model: () => "eleven_flash_v2_5", settings: () => ({}), factory });
    const got: [string, string][] = [];
    const out = await el.synth("hi.", undefined, (c, ext) => got.push([dec(c), ext]));
    expect(got).toEqual([
      ["A".repeat(40), "mp3"],
      ["B".repeat(40), "mp3"],
    ]);
    expect(dec(out.bytes)).toBe("A".repeat(40) + "B".repeat(40));
  });

  test("aura: the first chunk carries a streaming wav header, the cached file a real one", async () => {
    const factory = () =>
      new FakeSock((s, m) => {
        if (m.type === "Flush") {
          s.reply(new Uint8Array(100).fill(1).buffer);
          s.reply(new Uint8Array(60).fill(2).buffer);
          s.reply({ type: "Flushed" });
        }
      });
    const au = auraStream({ key: () => "dg", voice: () => "aura-2-andromeda-en", factory });
    const got: Uint8Array[] = [];
    const out = await au.synth("hey.", undefined, (c, ext) => {
      expect(ext).toBe("wav");
      got.push(c);
    });
    expect(got.map((c) => c.byteLength)).toEqual([144, 60]);
    const h = new DataView(got[0]!.buffer, got[0]!.byteOffset, 44);
    expect(dec(got[0]!.slice(0, 4))).toBe("RIFF");
    expect(h.getUint32(40, true)).toBe(0xffffffff);
    expect(h.getUint32(24, true)).toBe(24000);
    const full = new DataView(out.bytes.buffer, out.bytes.byteOffset, 44);
    expect(full.getUint32(40, true)).toBe(160);
  });

  test("a socket that dies after streaming part of a segment does not fall back to HTTP", async () => {
    const factory = () =>
      new FakeSock((s, m) => {
        if (m.flush) {
          s.reply({ audio: Buffer.from("A".repeat(40)).toString("base64"), contextId: m.context_id });
          s.close();
        }
      });
    let http = 0;
    const io: TtsIO = {
      fetch: async () => {
        http++;
        return new Response(new Uint8Array(500));
      },
      spawn: null as never,
      secret: (n) => (n === "ELEVENLABS_API_KEY" ? "k" : ""),
      which: () => null,
      now: Date.now,
      tmpDir: "/tmp",
      socket: factory,
    };
    const b = elevenLabsTts(io);
    await expect(b.synth("hi.", undefined, () => {})).rejects.toThrow();
    expect(http).toBe(0);
    // without a sink the old fallback still holds
    const out = await b.synth("hi again.");
    expect(out.bytes.byteLength).toBe(500);
  });

  test("http chunked bodies stream through readAudio", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc("aa"));
        c.enqueue(enc("bb"));
        c.close();
      },
    });
    const got: string[] = [];
    const bytes = await readAudio(new Response(body), "mp3", (c) => got.push(dec(c)));
    expect(got).toEqual(["aa", "bb"]);
    expect(dec(bytes)).toBe("aabb");
  });
});
