import { describe, expect, test } from "bun:test";
import type { LiveDown, LiveUp } from "@eigenwife/protocol";
import { LiveClient, type LiveHooks } from "./client";
import { base64ToBytes, bytesToBase64, liveWorkletSource, pcm16ToFloat, PlayClock, rmsFloat, WakeDetector } from "./pcm24";
import { liveLabel } from "./wire";

describe("live pcm plumbing", () => {
  test("base64 round trip and PCM16 decode", () => {
    const pcm = new Int16Array([0, 16384, -32768, 32767]);
    const bytes = new Uint8Array(pcm.buffer);
    const back = base64ToBytes(bytesToBase64(bytes));
    expect([...back]).toEqual([...bytes]);
    const f = pcm16ToFloat(back);
    expect(f[0]).toBe(0);
    expect(f[1]).toBeCloseTo(0.5);
    expect(f[2]).toBe(-1);
    expect(f[3]).toBeCloseTo(1, 3);
    expect(pcm16ToFloat(new Uint8Array(3)).length).toBe(1);
    expect(rmsFloat(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
  });

  test("worklet resamples to 24kHz in 20ms (480 sample) frames", () => {
    const src = liveWorkletSource();
    expect(src).toContain("new R(sampleRate, 24000, 480)");
    expect(src).toContain('registerProcessor("eve-live-pcm24"');
  });

  test("play clock: gapless while queued, small cushion after a dry spell", () => {
    const c = new PlayClock(0.04);
    expect(c.schedule(10, 0.02)).toBeCloseTo(10.04);
    expect(c.schedule(10.01, 0.02)).toBeCloseTo(10.06);
    expect(c.ahead(10.05)).toBeCloseTo(0.03);
    expect(c.schedule(20, 0.02)).toBeCloseTo(20.04);
  });

  test("wake detector: fires once when he starts talking, keeps his first words", () => {
    const w = new WakeDetector(0.02, 60, 200);
    const quiet = new Int16Array(480);
    const loud = new Int16Array(480).fill(3000);
    expect(w.push(quiet)).toBe(false);
    expect(w.push(loud)).toBe(false);
    expect(w.push(loud)).toBe(false);
    expect(w.push(loud)).toBe(true);
    expect(w.push(loud)).toBe(false);
    expect(w.take().length).toBe(5);
    expect(w.take().length).toBe(0);
  });

  test("labels for the mic lamp", () => {
    expect(liveLabel({ engine: "classic", status: "off" })).toBeNull();
    expect(liveLabel({ engine: "classic", status: "no_access", reason: "Eve Live needs OpenAI or gateway credits" })).toBe("Eve Live needs OpenAI or gateway credits");
    expect(liveLabel({ engine: "live", status: "live", usedMin: 12.4, capMin: 60 })).toBe("eve live (12/60 min today)");
    expect(liveLabel({ engine: "live", status: "idle" })).toContain("asleep");
  });
});

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    public url: string,
    public protocols?: string[],
  ) {
    FakeWS.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "" });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  recv(x: unknown) {
    this.onmessage?.({ data: JSON.stringify(x) });
  }
  json(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

function client() {
  FakeWS.all = [];
  const calls: string[] = [];
  const hooks: LiveHooks = {
    mouth: () => {},
    engine: (e, owner) => calls.push(`engine ${e} ${owner}`),
    mic: (s) => calls.push(`mic ${s.listening}${s.idle ? " idle" : ""}`),
  };
  const c = new LiveClient("http://127.0.0.1:7777", "overlay", hooks, { WebSocket: FakeWS as unknown as typeof WebSocket });
  c.start();
  const relay = FakeWS.all[0]!;
  relay.open();
  const down = (m: LiveDown) => c.onDown(m);
  const ups = () => relay.json() as LiveUp[];
  return { c, relay, down, ups, calls };
}

describe("live client relay (page half)", () => {
  test("says hello, opens the gateway socket with the minted subprotocols, sends session.start, forwards events but not audio", async () => {
    const { relay, down, ups, calls } = client();
    expect(relay.url).toBe("ws://127.0.0.1:7777/live");
    expect(ups()[0]).toEqual({ type: "hello", role: "overlay", audio: false });
    await down({ type: "engine", engine: "live", owner: true });
    expect(calls).toContain("engine live true");
    const start = { type: "session.start", session: { model: "openai/gpt-live-1" } };
    await down({ type: "connect", key: "k1", plan: { kind: "websocket", provider: "gateway", url: "wss://gw/v1/live/sessions", protocols: ["ai-gateway-realtime.v1", "ai-gateway-auth.tok"], start } });
    const live = FakeWS.all[1]!;
    expect(live.url).toBe("wss://gw/v1/live/sessions");
    expect(live.protocols).toEqual(["ai-gateway-realtime.v1", "ai-gateway-auth.tok"]);
    live.open();
    expect(live.json()[0]).toEqual(start);
    expect(ups().at(-1)).toEqual({ type: "opened", key: "k1" });
    live.recv({ type: "session.started", session: { id: "live_1" } });
    live.recv({ type: "session.output_audio.delta", delta: "AAAA" });
    live.recv({ type: "session.input_transcript.delta", delta: "hey", start_ms: 0, end_ms: 200 });
    const events = ups().filter((m) => m.type === "event");
    expect(events.map((m) => String((m as { event: Record<string, unknown> }).event.type))).toEqual(["session.started", "session.input_transcript.delta"]);
    expect(calls.at(-1)).toBe("mic true");
  });

  test("core commands reach the provider: send, graceful close, teardown; stale keys are ignored", async () => {
    const { down, ups } = client();
    await down({ type: "engine", engine: "live", owner: true });
    await down({ type: "connect", key: "k1", plan: { kind: "websocket", provider: "gateway", url: "wss://gw", protocols: [], start: { type: "session.start" } } });
    const live = FakeWS.all[1]!;
    live.open();
    await down({ type: "send", key: "k1", event: { type: "session.commentary.append", delegation_id: "d1", content: "done" } });
    await down({ type: "send", key: "old", event: { type: "nope" } });
    await down({ type: "close", key: "k1", reason: "classic" });
    expect(live.json().map((e) => e.type)).toEqual(["session.start", "session.commentary.append", "session.close"]);
    live.recv({ type: "session.closed", reason: "close_requested", usage: { seconds: 9 } });
    await down({ type: "teardown", key: "k1" });
    expect(live.readyState).toBe(3);
    // A teardown the page asked for isn't reported back as a surprise close.
    expect(ups().filter((m) => m.type === "closed")).toEqual([]);
  });

  test("a refused socket (no credits) is reported as a failure, not a session", async () => {
    const { down, ups } = client();
    await down({ type: "engine", engine: "live", owner: true });
    await down({ type: "connect", key: "k2", plan: { kind: "websocket", provider: "gateway", url: "wss://gw", protocols: [], start: {} } });
    FakeWS.all[1]!.onclose?.({ code: 1008, reason: "insufficient credits" });
    expect(ups().at(-1)).toEqual({ type: "fail", key: "k2", message: "live socket refused (1008 insufficient credits)" });
  });

  test("switching back to classic drops the transport and hands the mic back", async () => {
    const { down, calls } = client();
    await down({ type: "engine", engine: "live", owner: true });
    await down({ type: "connect", key: "k3", plan: { kind: "websocket", provider: "gateway", url: "wss://gw", protocols: [], start: {} } });
    const live = FakeWS.all[1]!;
    live.open();
    await down({ type: "engine", engine: "classic", owner: true });
    expect(live.readyState).toBe(3);
    expect(calls).toContain("engine classic true");
  });

  test("idle: mic activity wakes the core; frames stream only once the session started", async () => {
    const { c, down, ups } = client();
    await down({ type: "engine", engine: "live", owner: true });
    await down({ type: "idle", idle: true });
    const loud = new Int16Array(480).fill(3000);
    for (let i = 0; i < 10; i++) c.onMicFrame(loud);
    expect(ups().filter((m) => m.type === "activity").length).toBe(1);
    await down({ type: "connect", key: "k4", plan: { kind: "websocket", provider: "gateway", url: "wss://gw", protocols: [], start: {} } });
    const live = FakeWS.all[1]!;
    live.open();
    live.recv({ type: "session.started", session: { id: "s" } });
    // His opening words, buffered while she woke up, go out first.
    const appends = live.json().filter((e) => e.type === "session.input_audio.append");
    expect(appends.length).toBeGreaterThan(0);
    c.onMicFrame(loud);
    expect(live.json().filter((e) => e.type === "session.input_audio.append").length).toBe(appends.length + 1);
  });
});
