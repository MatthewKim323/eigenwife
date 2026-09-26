import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AnyEnvelope } from "@eigenwife/protocol";
import { EventBus } from "../src/bus";
import { HttpError } from "../src/brains/io";
import { createSpeech, type Speech, type SpeechDeps } from "../src/speech/service";
import { AudioCache, audioKey, openAiTts, deepgramTts, elevenLabsTts, sayTts, Tts, type TtsBackend } from "../src/speech/tts";
import { buildTts, speechModule } from "../src/speech/module";
import { FILLERS, LINES } from "../src/speech/lines";
import { startCore, type RunningCore } from "../src/index";
import { fakeProc } from "./brains.fakes";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "eve-speech-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface FakeTts extends TtsBackend {
  calls: string[];
  maxActive: number;
}

function fakeBackend(name = "fake", delay: (text: string) => number = () => 5, fail?: (text: string) => Error | null): FakeTts {
  let active = 0;
  const b: FakeTts = {
    name,
    calls: [],
    maxActive: 0,
    voiceKey: () => `${name}:v1`,
    configured: () => true,
    async synth(text) {
      b.calls.push(text);
      active++;
      b.maxActive = Math.max(b.maxActive, active);
      try {
        await Bun.sleep(delay(text));
        const err = fail?.(text);
        if (err) throw err;
        return { bytes: new TextEncoder().encode(`AUDIO:${text}`.padEnd(80, ".")), ext: "mp3" };
      } finally {
        active--;
      }
    },
  };
  return b;
}

function rig(opts: Partial<SpeechDeps> & { backends?: TtsBackend[]; noTts?: boolean } = {}) {
  const bus = new EventBus();
  const events: AnyEnvelope[] = [];
  bus.on("*", (e) => void events.push(e));
  const backends = opts.backends ?? [fakeBackend()];
  const tts = opts.noTts ? null : new Tts(backends, new AudioCache(tmp()));
  const speech = createSpeech({ bus, tts, fillerMs: 40, estimateMs: () => 20, slackMs: 10, ...opts });
  const types = () => events.map((e) => (e.type === "avatar.state" ? `avatar:${(e.data as { state: string }).state}` : e.type));
  const segs = () => events.filter((e) => e.type === "speech.segment").map((e) => e.data as { utteranceId: string; seq: number; text: string; audioUrl?: string; marks: unknown[] });
  return { bus, events, tts, speech, types, segs, backends };
}

async function until(cond: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await Bun.sleep(5);
  }
}

async function* slowStream(parts: [number, string][]) {
  for (const [ms, t] of parts) {
    await Bun.sleep(ms);
    yield t;
  }
}

describe("speech pipeline", () => {
  test("event order: begin, speaking, ordered segments with audio, end, then idle", async () => {
    const r = rig();
    const out = await r.speech.say(LINES.done);
    expect(out.text).toBe("seven thirty. cheap ramen. you're free. done.");
    expect(r.types()).toEqual(["speech.begin", "speech.segment", "avatar:speaking", "speech.segment", "speech.segment", "speech.segment", "speech.end"]);
    const begin = r.events[0]!.data as { text: string; brain: string };
    expect(begin.text).toBe("seven thirty. cheap ramen. you're free. done.");
    expect(begin.brain).toBe("scripted");
    expect(r.segs().map((s) => s.seq)).toEqual([0, 1, 2, 3]);
    expect(r.segs().every((s) => /^\/api\/audio\/[a-f0-9]{64}\.mp3$/.test(s.audioUrl ?? ""))).toBe(true);
    expect(r.segs()[3]!.marks).toEqual([{ at: 0, mood: "happy", intensity: 0.7 }]);
    expect(r.speech.speaking()).toBe(true);
    await until(() => !r.speech.speaking());
    expect(r.types().at(-1)).toBe("avatar:idle");
  });

  test("parallel synth (max 4) but strictly ordered emission", async () => {
    // first segment is the slowest to synthesize; later ones finish first
    const b = fakeBackend("fake", (t) => (t.startsWith("one") ? 120 : t.startsWith("two") ? 60 : 5));
    const r = rig({ backends: [b] });
    await r.speech.say("one a. two b. three c. four d. five e. six f.");
    expect(r.segs().map((s) => s.text)).toEqual(["one a.", "two b.", "three c.", "four d.", "five e.", "six f."]);
    expect(r.segs().map((s) => s.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(b.maxActive).toBe(4);
  });

  test("cache hits skip synthesis, across restarts of the Tts", async () => {
    const dir = tmp();
    const b = fakeBackend();
    const t1 = new Tts([b], new AudioCache(dir));
    const first = await t1.render("twenty-one dollars.");
    expect(first?.cached).toBe(false);
    const again = await t1.render("twenty-one  dollars. ");
    expect(again?.cached).toBe(true);
    expect(b.calls.length).toBe(1);
    // a fresh process sees the files on disk
    const t2 = new Tts([fakeBackend()], new AudioCache(dir));
    expect(t2.lookup("twenty-one dollars.")?.sha).toBe(first!.sha);
  });

  test("a live better voice beats an old cached render from a worse backend", async () => {
    const dir = tmp();
    const say = fakeBackend("say");
    await new Tts([say], new AudioCache(dir)).render("so. apparently this is your type.");
    const deepgram = fakeBackend("deepgram");
    const t = new Tts([deepgram, fakeBackend("say")], new AudioCache(dir));
    const r = await t.render("so. apparently this is your type.");
    expect(r?.backend).toBe("deepgram");
    expect(r?.cached).toBe(false);
    expect(deepgram.calls.length).toBe(1);
    // and when the better backend is down, the worse cached copy still plays instantly
    const down = fakeBackend("deepgram", () => 5, () => new Error("401"));
    const t2 = new Tts([down, fakeBackend("say")], new AudioCache(dir));
    t2.health.fail("deepgram", new Error("401"));
    expect((await t2.render("okay."))?.backend).toBe("say");
  });

  test("lookup prefers a cached better voice even when that backend is down", async () => {
    const dir = tmp();
    const good = fakeBackend("openai");
    await new Tts([good], new AudioCache(dir)).render("hm.");
    const down = { ...fakeBackend("openai"), configured: () => false };
    const local = fakeBackend("say");
    const t = new Tts([down, local], new AudioCache(dir));
    const hit = await t.render("hm.");
    expect(hit?.backend).toBe("openai");
    expect(local.calls).toEqual([]);
  });

  test("tts failure: falls to the next backend, parks the broken one", async () => {
    const broken = fakeBackend("openai", () => 1, () => new HttpError(429, "insufficient_quota", "openai tts"));
    const local = fakeBackend("say");
    const t = new Tts([broken, local], new AudioCache(tmp()));
    expect((await t.render("a."))?.backend).toBe("say");
    expect((await t.render("b."))?.backend).toBe("say");
    expect(broken.calls).toEqual(["a."]);
    expect(t.live().map((x) => x.name)).toEqual(["say"]);
  });

  test("tts probe parks a dead network backend at boot and skips local say", async () => {
    const broken = fakeBackend("openai", () => 1, () => new HttpError(429, "insufficient_quota", "openai tts"));
    const local = fakeBackend("say");
    const t = new Tts([broken, local], new AudioCache(tmp()));
    expect(await t.probe()).toEqual({ openai: false });
    expect(local.calls).toEqual([]);
    expect(t.live().map((x) => x.name)).toEqual(["say"]);
    const ok = new Tts([fakeBackend("openai")], new AudioCache(tmp()));
    expect(await ok.probe()).toEqual({ openai: true });
    expect(ok.lookup("hm.")?.backend).toBe("openai");
  });

  test("no TTS at all: segments still go out, without audioUrl", async () => {
    const r = rig({ noTts: true });
    await r.speech.say(LINES.price);
    expect(r.segs().map((s) => s.text)).toEqual(["twenty-one dollars.", "for ramen?"]);
    expect(r.segs().every((s) => s.audioUrl === undefined)).toBe(true);
  });

  test("every backend failing: segments without audioUrl", async () => {
    const r = rig({ backends: [fakeBackend("x", () => 1, () => new Error("boom"))] });
    await r.speech.say("okay.");
    expect(r.segs()[0]!.audioUrl).toBeUndefined();
  });

  test("streams: marks split across chunks never spoken, segments as they complete", async () => {
    const r = rig();
    const out = await r.speech.say(slowStream([[0, "[mood:sm"], [0, "ug 0.6] so."], [0, " apparently this"], [0, " is your type."]]), { brain: "persona" });
    expect(out.text).toBe("so. apparently this is your type.");
    expect(r.segs().map((s) => s.text)).toEqual(["so.", "apparently this is your type."]);
    expect(r.segs()[0]!.marks).toEqual([{ at: 0, mood: "smug", intensity: 0.6 }]);
    expect((r.events[0]!.data as { brain: string }).brain).toBe("persona");
  });

  test("filler: slow first chunk plays a cached hm and sets thinking", async () => {
    const r = rig();
    await r.tts!.render("hm.");
    const out = await r.speech.say(slowStream([[120, "twenty-one dollars."]]));
    expect(out.text).toBe("twenty-one dollars.");
    const segs = r.segs();
    expect(FILLERS).toContain(segs[0]!.text as (typeof FILLERS)[number]);
    expect(segs[0]!.marks).toEqual([{ at: 0, mood: "thinking", intensity: 0.5 }]);
    expect(segs.map((s) => s.seq)).toEqual([0, 1]);
    const t = r.types();
    expect(t.indexOf("avatar:thinking")).toBeGreaterThan(t.indexOf("speech.segment"));
    expect(t.indexOf("avatar:speaking")).toBeGreaterThan(t.indexOf("avatar:thinking"));
    expect(r.speech.info().fillers).toBe(1);
  });

  test("no filler when the first chunk is quick", async () => {
    const r = rig();
    await r.speech.say(slowStream([[5, "hi."]]));
    expect(r.segs().map((s) => s.text)).toEqual(["hi."]);
  });

  test("mood option marks the first word when the text has no mood", async () => {
    const r = rig({ noTts: true });
    await r.speech.say("hey.", { mood: "sad" });
    expect(r.segs()[0]!.marks).toEqual([{ at: 0, mood: "sad", intensity: 0.6 }]);
  });
});

describe("interruptions", () => {
  test("barge-in: 3+ words of user speech while she talks stops her", async () => {
    const r = rig({ estimateMs: () => 5000 });
    await r.speech.say("okay so this is a long one. it keeps going.");
    expect(r.speech.speaking()).toBe(true);
    r.bus.emit("voice.partial", { text: "wait no" }, "shell");
    expect(r.speech.speaking()).toBe(true);
    r.bus.emit("voice.partial", { text: "wait no stop" }, "shell");
    expect(r.speech.speaking()).toBe(false);
    const stop = r.events.find((e) => e.type === "speech.stop");
    expect(stop?.data).toEqual({ reason: "barge-in" });
    expect(r.types().at(-1)).toBe("avatar:idle");
  });

  test("stop() mid-stream: speech.stop, then speech.end interrupted, rest never emitted", async () => {
    const r = rig();
    const p = r.speech.say(slowStream([[0, "first part. "], [80, "second part. "], [80, "third part."]]));
    await until(() => r.segs().length === 1);
    r.speech.stop("user said stop");
    const out = await p;
    expect(out.text).toBe("first part.");
    expect(r.types().slice(-3)).toEqual(["speech.stop", "speech.end", "avatar:idle"]);
    const end = r.events.find((e) => e.type === "speech.end")!.data as { interrupted: boolean };
    expect(end.interrupted).toBe(true);
    await Bun.sleep(200);
    expect(r.segs().length).toBe(1);
  });

  test("an external speech.stop (shell barge-in) cuts without echoing another stop", async () => {
    const r = rig({ estimateMs: () => 5000 });
    await r.speech.say("hello there.");
    r.bus.emit("speech.stop", { reason: "barge-in" }, "shell");
    expect(r.speech.speaking()).toBe(false);
    expect(r.events.filter((e) => e.type === "speech.stop").length).toBe(1);
  });

  test("high priority interrupts normal", async () => {
    const r = rig();
    const a = r.speech.say(slowStream([[0, "normal line. "], [150, "more of it."]]));
    await until(() => r.segs().length === 1);
    const b = await r.speech.say(LINES.relapse, { priority: "high" });
    expect((await a).text).toBe("normal line.");
    expect(b.text).toBe("...seriously?");
    const stop = r.events.find((e) => e.type === "speech.stop")!.data as { reason: string };
    expect(stop.reason).toBe("preempted");
    expect(r.segs().at(-1)!.text).toBe("...seriously?");
  });

  test("low priority is dropped while busy, normal waits its turn", async () => {
    const r = rig({ estimateMs: () => 5000 });
    await r.speech.say("first.");
    const low = await r.speech.say("ambient comment.", { priority: "low" });
    expect(low.text).toBe("");
    const second = r.speech.say("second.");
    const out = await second;
    expect(out.text).toBe("second.");
    expect(r.segs().map((s) => s.text)).toEqual(["first.", "second."]);
    expect(r.events.some((e) => e.type === "speech.stop")).toBe(false);
  });

  test("interrupt:true cuts even an equal-priority line", async () => {
    const r = rig({ estimateMs: () => 5000 });
    await r.speech.say("first.");
    await r.speech.say("now.", { interrupt: true });
    expect(r.events.filter((e) => e.type === "speech.stop").length).toBe(1);
  });

  test("speech.played for the last segment ends playback before the estimate", async () => {
    const r = rig({ estimateMs: () => 60_000 });
    const { utteranceId } = await r.speech.say("one. two.");
    expect(r.speech.speaking()).toBe(true);
    r.bus.emit("speech.played", { utteranceId, seq: 0 }, "shell");
    expect(r.speech.speaking()).toBe(true);
    r.bus.emit("speech.played", { utteranceId, seq: 1 }, "shell");
    expect(r.speech.speaking()).toBe(false);
    expect(r.types().at(-1)).toBe("avatar:idle");
  });
});

describe("tts backends", () => {
  const io = (over: Record<string, unknown> = {}) => ({
    fetch: async () => new Response("x", { status: 599 }),
    spawn: (a: string[]) => fakeProc(a, undefined, [], 0),
    secret: (n: string) => (({ OPENAI_API_KEY: "sk", ELEVENLABS_API_KEY: "el" }) as Record<string, string>)[n] ?? "",
    which: (b: string) => `/bin/${b}`,
    now: Date.now,
    tmpDir: tmp(),
    ...over,
  });

  test("openai: gpt-4o-mini-tts, voice, instructions, mp3", async () => {
    let body: any;
    const b = openAiTts(
      io({
        fetch: async (url: string, init: RequestInit) => {
          expect(url).toBe("https://api.openai.com/v1/audio/speech");
          body = JSON.parse(String(init.body));
          return new Response(new Uint8Array(200));
        },
      }) as never,
    );
    const out = await b.synth("hm.");
    expect(out.ext).toBe("mp3");
    expect(body).toMatchObject({ model: "gpt-4o-mini-tts", voice: "marin", input: "hm.", response_format: "mp3" });
    expect(body.instructions).toContain("teasing");
    expect(b.voiceKey()).toBe("openai:gpt-4o-mini-tts:marin:v1");
  });

  test("openai quota error surfaces as HttpError 429", async () => {
    const b = openAiTts(io({ fetch: async () => new Response('{"error":{"code":"insufficient_quota"}}', { status: 429 }) }) as never);
    await expect(b.synth("x")).rejects.toBeInstanceOf(HttpError);
  });

  test("elevenlabs: flash v2.5 with the configured voice", async () => {
    let url = "";
    let body: any;
    const b = elevenLabsTts(
      io({
        fetch: async (u: string, init: RequestInit) => {
          url = u;
          body = JSON.parse(String(init.body));
          return new Response(new Uint8Array(200));
        },
      }) as never,
    );
    await b.synth("hi.");
    expect(url).toContain("/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM");
    expect(body.model_id).toBe("eleven_flash_v2_5");
  });

  test("deepgram: aura-2 with a token header, voice override, errors surface", async () => {
    let url = "";
    let auth = "";
    let body: any;
    const b = deepgramTts(
      io({
        fetch: async (u: string, init: RequestInit) => {
          url = u;
          auth = String((init.headers as Record<string, string>).Authorization);
          body = JSON.parse(String(init.body));
          return new Response(new Uint8Array(200));
        },
      }) as never,
    );
    expect((await b.synth("so. apparently this is your type.")).ext).toBe("mp3");
    expect(url).toBe("https://api.deepgram.com/v1/speak?model=aura-2-andromeda-en&encoding=mp3");
    expect(auth.startsWith("Token ")).toBe(true);
    expect(body).toEqual({ text: "so. apparently this is your type." });
    const bad = deepgramTts(io({ fetch: async () => new Response("unauthorized", { status: 401 }) }) as never);
    await expect(bad.synth("x")).rejects.toThrow();
  });

  test("say: say to aiff, ffmpeg to mp3", async () => {
    const argvs: string[][] = [];
    const b = sayTts(
      io({
        spawn: (a: string[]) => {
          argvs.push(a);
          if (a[0]!.endsWith("ffmpeg")) Bun.write(a.at(-1)!, new Uint8Array(100));
          return fakeProc(a, undefined, [], 0);
        },
      }) as never,
    );
    const out = await b.synth("okay.");
    expect(out.ext).toBe("mp3");
    expect(out.bytes.length).toBe(100);
    expect(argvs[0]!.slice(0, 5)).toEqual(["/bin/say", "-v", "Samantha", "-r", "182"]);
    expect(argvs[0]!.at(-1)).toBe("okay.");
    expect(argvs[1]![0]).toBe("/bin/ffmpeg");
  });

  test("buildTts honors EVE_TTS", () => {
    const home = tmp();
    const mk = (pin: string) => buildTts(home, io() as never, pin);
    expect(mk("none")).toBeNull();
    expect(mk("say")!.backends.map((b) => b.name)).toEqual(["say", "deepgram", "openai", "elevenlabs"]);
    expect(mk("")!.backends.map((b) => b.name)).toEqual(["deepgram", "openai", "elevenlabs", "say"]);
  });

  test("audio keys depend on voice and normalized text", () => {
    expect(audioKey("a", "hi  there ")).toBe(audioKey("a", "hi there"));
    expect(audioKey("a", "hi")).not.toBe(audioKey("b", "hi"));
  });
});

describe("speech module", () => {
  let core: RunningCore;
  let tts: Tts;
  const port = 17792;
  beforeAll(async () => {
    process.env.EIGEN_QUIET = "1";
    tts = new Tts([fakeBackend()], new AudioCache(tmp()));
    core = await startCore([speechModule({ tts, estimateMs: () => 10, slackMs: 5 })], { port, eveHome: tmp() });
  });
  afterAll(() => core.stop());
  beforeEach(() => core.ctx.use("speech").stop("reset"));

  test("provides speech and serves cached audio with content-type and CORS", async () => {
    const r = await core.ctx.use("speech").say("hello there.");
    expect(r.text).toBe("hello there.");
    const seg = core.ctx.bus.recent("speech.segment", 1)[0]!.data as { audioUrl: string };
    const res = await fetch(`http://127.0.0.1:${port}${seg.audioUrl}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.text()).toStartWith("AUDIO:hello there.");
  });

  test("rejects unknown and malformed audio names", async () => {
    expect((await fetch(`http://127.0.0.1:${port}/api/audio/${"0".repeat(64)}.mp3`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/api/audio/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
  });

  test("status, say and stop routes", async () => {
    const s = (await (await fetch(`http://127.0.0.1:${port}/api/speech/status`)).json()) as any;
    expect(s.tts.live).toEqual(["fake"]);
    const said = (await (await fetch(`http://127.0.0.1:${port}/api/speech/say`, { method: "POST", body: JSON.stringify({ text: LINES.locked }) })).json()) as any;
    expect(said.text).toBe("locked in.");
    expect((await (await fetch(`http://127.0.0.1:${port}/api/speech/stop`, { method: "POST", body: "{}" })).json()) as any).toEqual({ ok: true });
  });
});
