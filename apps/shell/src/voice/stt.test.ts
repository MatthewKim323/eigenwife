import { describe, expect, test } from "bun:test";
import { Resampler, rms16, workletSource } from "./pcm";
import { chooseStt, earsAvailable, earsUrl, sttPref } from "./stt";

describe("stt source", () => {
  test("url preference, overlay forces deepgram", () => {
    expect(sttPref("", false)).toBe("browser");
    expect(sttPref("?stt=auto", false)).toBe("auto");
    expect(sttPref("?stt=deepgram", false)).toBe("deepgram");
    expect(sttPref("?stt=nonsense", false)).toBe("browser");
    expect(sttPref("?stt=browser&mode=overlay", true)).toBe("deepgram");
  });

  test("auto resolves against the core's ears status", () => {
    expect(chooseStt("auto", true, true)).toBe("deepgram");
    expect(chooseStt("auto", false, true)).toBe("browser");
    expect(chooseStt("auto", null, true)).toBe("browser");
    // nothing else can hear: try the core anyway (it reconnects when it comes up)
    expect(chooseStt("auto", null, false)).toBe("deepgram");
    expect(chooseStt("browser", true, true)).toBe("browser");
    expect(chooseStt("deepgram", false, true)).toBe("deepgram");
  });

  test("earsAvailable: available, missing key, core down", async () => {
    const ok = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
    expect(await earsAvailable("http://x", 100, ok({ available: true }))).toBe(true);
    expect(await earsAvailable("http://x", 100, ok({ available: false }))).toBe(false);
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await earsAvailable("http://x", 100, down)).toBeNull();
  });

  test("ears url", () => {
    const u = new URL(earsUrl("http://127.0.0.1:7777", "overlay"));
    expect(u.protocol).toBe("ws:");
    expect(u.pathname).toBe("/ears");
    expect(u.searchParams.get("encoding")).toBe("linear16");
    expect(u.searchParams.get("sample_rate")).toBe("16000");
    expect(u.searchParams.get("client")).toBe("overlay");
  });
});

describe("pcm resampler", () => {
  test("48k -> 16k in 20ms frames", () => {
    const r = new Resampler(48000, 16000, 320);
    const frames = r.push(new Float32Array(48000 / 10).fill(0.5)); // 100ms
    expect(frames.length).toBe(5);
    expect(frames[0]!.length).toBe(320);
    expect(frames[0]![10]).toBe(Math.round(0.5 * 0x7fff));
  });

  test("44.1k keeps the right rate over time and clips", () => {
    const r = new Resampler(44100, 16000, 320);
    let n = 0;
    for (let i = 0; i < 10; i++) n += r.push(new Float32Array(4410).fill(-2)).length; // 1s
    expect(n).toBeGreaterThanOrEqual(49); // 16000 samples, give or take float drift on the last one
    expect(n).toBeLessThanOrEqual(50);
    const f = new Resampler(16000, 16000, 2).push(new Float32Array([-2, 2]))[0]!;
    expect([...f]).toEqual([-32768, 32767]);
  });

  test("worklet source is self-contained", () => {
    const src = workletSource();
    expect(src).toContain("registerProcessor(\"eve-pcm16\"");
    // Evaluate it with a stub AudioWorklet scope: it must not reference outer symbols.
    let registered: any = null;
    new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", src)(
      class {
        port = { onmessage: null, postMessage: () => {} };
      },
      (_: string, cls: any) => (registered = cls),
      48000,
    );
    const posted: ArrayBuffer[] = [];
    const p = new registered();
    p.port.postMessage = (b: ArrayBuffer) => posted.push(b);
    p.process([[new Float32Array(960)]]);
    expect(posted.length).toBe(1);
    expect(posted[0]!.byteLength).toBe(640);
  });

  test("rms", () => {
    expect(rms16(new Int16Array(10))).toBe(0);
    expect(rms16(new Int16Array(10).fill(-32768))).toBe(1);
  });
});
