import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { AnyEnvelope } from "@eigenwife/protocol";
import { startCore, type RunningCore } from "../src/index";
import { earsModule } from "../src/ears/module";
import { acceptWhileSpeaking, SpeakingTracker } from "../src/ears/gate";
import { listenUrl, optionsFromQuery, TranscriptAssembler } from "../src/ears/deepgram";
import { EarsSession } from "../src/ears/session";

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await Bun.sleep(5);
  }
};

const results = (text: string, is_final = false, speech_final = false) =>
  JSON.stringify({ type: "Results", is_final, speech_final, channel: { alternatives: [{ transcript: text, confidence: 0.9 }] } });

// ---------------------------------------------------------------------------
// a fake Deepgram: records what it gets, lets the test script replies
// ---------------------------------------------------------------------------

interface FakeConn {
  ws: ServerWebSocket<{ url: string; auth: string }>;
  audio: number;
  text: string[];
}

function fakeDeepgram() {
  const conns: FakeConn[] = [];
  const server = Bun.serve<{ url: string; auth: string }>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req, { data: { url: req.url, auth: req.headers.get("authorization") ?? "" } })) return undefined;
      return new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        conns.push({ ws, audio: 0, text: [] });
      },
      message(ws, m) {
        const c = conns.find((x) => x.ws === ws)!;
        if (typeof m === "string") c.text.push(m);
        else c.audio += m.byteLength;
      },
    },
  });
  return { server, conns, endpoint: `ws://127.0.0.1:${server.port}/v1/listen`, last: () => conns[conns.length - 1]! };
}

// ---------------------------------------------------------------------------
// pure pieces
// ---------------------------------------------------------------------------

describe("deepgram url + assembler", () => {
  test("listen url carries the streaming settings", () => {
    const u = new URL(listenUrl({ encoding: "linear16", sampleRate: 16000 }));
    expect(u.host).toBe("api.deepgram.com");
    const q = u.searchParams;
    expect(q.get("model")).toBe("nova-3");
    expect(q.get("interim_results")).toBe("true");
    expect(q.get("endpointing")).toBe("300");
    expect(q.get("utterance_end_ms")).toBe("1000");
    expect(q.get("smart_format")).toBe("true");
    expect(q.get("encoding")).toBe("linear16");
    expect(q.get("sample_rate")).toBe("16000");
    // webm/opus containers: Deepgram sniffs the format, no encoding param
    const w = new URL(listenUrl(optionsFromQuery(new URLSearchParams("encoding=webm"))));
    expect(w.searchParams.get("encoding")).toBeNull();
  });

  test("interim -> partial, is_final chunks join, speech_final commits once", () => {
    const out: string[] = [];
    const a = new TranscriptAssembler({ partial: (t) => out.push(`p:${t}`), final: (t) => out.push(`f:${t}`) });
    a.push(JSON.parse(results("what should")));
    a.push(JSON.parse(results("what should we")));
    a.push(JSON.parse(results("What should we", true)));
    a.push(JSON.parse(results("eat")));
    a.push(JSON.parse(results("eat tonight?", true, true)));
    expect(out).toEqual(["p:what should", "p:what should we", "p:What should we", "p:What should we eat", "f:What should we eat tonight?"]);
  });

  test("UtteranceEnd commits when endpointing never fired", () => {
    const out: string[] = [];
    const a = new TranscriptAssembler({ partial: () => {}, final: (t) => out.push(t) });
    a.push(JSON.parse(results("hey eve", true)));
    a.push({ type: "UtteranceEnd" });
    a.push({ type: "UtteranceEnd" });
    expect(out).toEqual(["hey eve"]);
  });
});

describe("half-duplex gate matches the shell's", () => {
  test("same vectors as apps/shell/src/voice/turn.ts", () => {
    expect(acceptWhileSpeaking("yeah", false, 5000)).toBe("accept");
    expect(acceptWhileSpeaking("yeah", true, 0)).toBe("ignore");
    expect(acceptWhileSpeaking("wait stop that", true, 0)).toBe("barge-in");
    expect(acceptWhileSpeaking("ok", false, 300)).toBe("ignore");
    expect(acceptWhileSpeaking("ok", false, 700)).toBe("accept");
  });

  test("client reports beat the bus", () => {
    let now = 1000;
    const t = new SpeakingTracker(() => now);
    t.fromBus(true);
    expect(t.speaking).toBe(true);
    t.fromClient(false);
    expect(t.speaking).toBe(false);
    t.fromClient(true);
    now = 2000;
    t.fromClient(false);
    now = 2100;
    expect(t.msSinceStopped).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// the session against a fake Deepgram (real websockets)
// ---------------------------------------------------------------------------

describe("ears session", () => {
  const dg = fakeDeepgram();
  afterAll(() => {
    void dg.server.stop(true);
  });

  function session() {
    const events: string[] = [];
    const client: Record<string, unknown>[] = [];
    const s = new EarsSession({
      url: listenUrl({ encoding: "linear16" }, dg.endpoint),
      apiKey: "k_test",
      minBackoffMs: 20,
      maxBackoffMs: 40,
      keepAliveMs: 60,
      hooks: {
        partial: (t) => events.push(`partial:${t}`),
        final: (t) => events.push(`final:${t}`),
        bargeIn: (t) => events.push(`barge:${t}`),
        toClient: (m) => client.push(m),
        log: () => {},
      },
    });
    return { s, events, client };
  }

  test("forwards audio with the key in a header, sends keepalives in silence", async () => {
    const before = dg.conns.length;
    const { s } = session();
    s.start();
    await until(() => s.state === "open");
    const c = dg.conns[before]!;
    expect(c.ws.data.auth).toBe("Token k_test");
    expect(new URL(c.ws.data.url).searchParams.get("model")).toBe("nova-3");
    s.audio(new Uint8Array(640));
    await until(() => c.audio === 640);
    await until(() => c.text.some((t) => t.includes("KeepAlive")));
    s.close();
    await until(() => c.text.some((t) => t.includes("CloseStream")));
  });

  test("reconnects after the upstream drops and replays held audio", async () => {
    const before = dg.conns.length;
    const { s, client } = session();
    s.start();
    await until(() => s.state === "open");
    dg.conns[before]!.ws.close(1011, "boom");
    await until(() => s.state === "reconnecting");
    s.audio(new Uint8Array(320));
    await until(() => dg.conns.length === before + 2 && s.state === "open");
    await until(() => dg.conns[before + 1]!.audio === 320);
    expect(s.connects).toBe(2);
    expect(client.some((m) => m.upstream === "reconnecting")).toBe(true);
    s.close();
  });

  test("ignores short speech while she talks, barges in on 3+ words", async () => {
    const { s, events } = session();
    s.start();
    await until(() => s.state === "open");
    const up = dg.last().ws;
    s.control({ type: "eve", speaking: true });
    up.send(results("mm"));
    up.send(results("mm", true, true));
    await Bun.sleep(40);
    expect(events).toEqual([]);
    up.send(results("wait hold on"));
    up.send(results("wait hold on eve", true, true));
    await until(() => events.some((e) => e.startsWith("final:")));
    expect(events).toEqual(["barge:wait hold on", "partial:wait hold on", "final:wait hold on eve"]);
    s.close();
  });
});

// ---------------------------------------------------------------------------
// the module on a real hub
// ---------------------------------------------------------------------------

describe("ears module on the hub", () => {
  const dg = fakeDeepgram();
  let core: RunningCore;
  let bare: RunningCore;
  const port = 17791;

  beforeAll(async () => {
    process.env.EIGEN_QUIET = "1";
    core = await startCore([earsModule({ endpoint: dg.endpoint, secret: (n) => (n === "DEEPGRAM_API_KEY" ? "k_live" : ""), minBackoffMs: 20 })], { port });
    bare = await startCore([earsModule({ secret: () => "" })], { port: port + 1 });
  });
  afterAll(async () => {
    await core.stop();
    await bare.stop();
    void dg.server.stop(true);
  });

  test("status says available with a key", async () => {
    const r = await (await fetch(`http://127.0.0.1:${port}/api/ears/status`)).json();
    expect(r).toMatchObject({ ok: true, available: true, provider: "deepgram", model: "nova-3" });
  });

  test("missing key: status unavailable, websocket refused", async () => {
    const r = await (await fetch(`http://127.0.0.1:${port + 1}/api/ears/status`)).json();
    expect(r.available).toBe(false);
    expect(r.reason).toContain("DEEPGRAM_API_KEY");
    const res = await fetch(`http://127.0.0.1:${port + 1}/ears`, { headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } });
    expect(res.status).toBe(503);
  });

  test("audio in over ws /ears, voice.partial + voice.final out on the bus", async () => {
    const seen: AnyEnvelope[] = [];
    const off = core.ctx.bus.on("voice.*", (e) => void seen.push(e));
    const fromServer: any[] = [];
    const before = dg.conns.length;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ears?encoding=linear16&sample_rate=16000&client=test`);
    ws.onmessage = (ev) => fromServer.push(JSON.parse(String(ev.data)));
    await until(() => ws.readyState === 1 && dg.conns.length === before + 1);
    const up = dg.conns[before]!;
    expect(new URL(up.ws.data.url).searchParams.get("sample_rate")).toBe("16000");
    ws.send(new Uint8Array(3200));
    await until(() => up.audio === 3200);
    up.ws.send(results("what should"));
    up.ws.send(results("What should we eat?", true, true));
    await until(() => seen.some((e) => e.type === "voice.final"));
    expect(seen.map((e) => `${e.type}:${(e.data as any).text}:${e.source}`)).toEqual([
      "voice.partial:what should:ears",
      "voice.final:What should we eat?:ears",
    ]);
    await until(() => fromServer.some((m) => m.type === "final"));
    expect(core.ctx.world().user.lastUtterance).toBe("What should we eat?");
    ws.close();
    await until(() => up.text.some((t) => t.includes("CloseStream")));
    off();
  });

  test("bus speech.begin gates short speech for clients that never report", async () => {
    const seen: string[] = [];
    const off = core.ctx.bus.on("voice.final", (e) => void seen.push(e.data.text));
    const stops: string[] = [];
    const off2 = core.ctx.bus.on("speech.stop", (e) => void stops.push(e.data.reason));
    const before = dg.conns.length;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ears`);
    await until(() => ws.readyState === 1 && dg.conns.length === before + 1);
    const up = dg.conns[before]!;
    await until(() => up.ws.readyState === 1);
    core.ctx.bus.emit("speech.begin", { utteranceId: "u1", text: "hi", brain: "t" });
    up.ws.send(results("yeah", true, true));
    up.ws.send(results("no stop talking", true, true));
    await until(() => seen.length === 1);
    expect(seen).toEqual(["no stop talking"]);
    expect(stops).toEqual(["barge-in"]);
    ws.close();
    off();
    off2();
  });
});
