import { expect, test } from "bun:test";
import { auraStream, elevenStream, wav, type TtsSocket } from "../src/speech/sockets";
import { deepgramTts, type TtsIO } from "../src/speech/tts";

/** A scriptable fake websocket: records sends, lets the test answer. */
function fakeFactory(behave: (sock: FakeSock, msg: any) => void, opts: { failOpen?: boolean } = {}) {
  const socks: FakeSock[] = [];
  const factory = (url: string, headers: Record<string, string>) => {
    const s = new FakeSock(url, headers, behave);
    socks.push(s);
    setTimeout(() => {
      if (opts.failOpen) s.onclose?.({ code: 1008, reason: "nope" });
      else {
        s.readyState = 1;
        s.onopen?.({});
      }
    }, 1);
    return s as TtsSocket;
  };
  return { factory, socks };
}

class FakeSock implements TtsSocket {
  readyState = 0;
  binaryType?: string;
  sent: any[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(
    public url: string,
    public headers: Record<string, string>,
    private behave: (s: FakeSock, m: any) => void,
  ) {}
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

test("elevenlabs multi-context: one context per segment, concurrent on one socket, audio joined per context", async () => {
  const { factory, socks } = fakeFactory((s, m) => {
    if (m.flush) {
      const id = m.context_id;
      s.reply({ audio: Buffer.from(`${m.text.trim()}-a`.padEnd(40, "x")).toString("base64"), contextId: id });
      s.reply({ audio: Buffer.from("-b".padEnd(40, "y")).toString("base64"), contextId: id });
    }
    if (m.close_context) s.reply({ isFinal: true, contextId: m.context_id });
  });
  const el = elevenStream({ key: () => "k", voice: () => "v1", model: () => "eleven_flash_v2_5", settings: () => ({ stability: 0.4 }), factory });
  el.warm();
  const [a, b] = await Promise.all([el.synth("hello there."), el.synth("second one.")]);
  expect(socks.length).toBe(1);
  expect(socks[0]!.url).toContain("/v1/text-to-speech/v1/multi-stream-input?model_id=eleven_flash_v2_5");
  expect(socks[0]!.headers["xi-api-key"]).toBe("k");
  expect(new TextDecoder().decode(a.bytes).startsWith("hello there.-a")).toBe(true);
  expect(new TextDecoder().decode(b.bytes).startsWith("second one.-a")).toBe(true);
  expect(a.ext).toBe("mp3");
  const ctxA = socks[0]!.sent[0].context_id;
  expect(socks[0]!.sent.filter((m) => m.context_id === ctxA).map((m) => Object.keys(m).sort().join(","))).toEqual(["context_id,text,voice_settings", "context_id,flush,text", "close_context,context_id"]);
});

test("aura: Speak + Flush, binary pcm until Flushed, wrapped as wav; segments queue on one socket", async () => {
  const pcm = new Uint8Array(200).fill(7).buffer;
  const { factory, socks } = fakeFactory((s, m) => {
    if (m.type === "Flush") {
      s.reply(pcm);
      s.reply({ type: "Flushed", sequence_id: 0 });
    }
  });
  const au = auraStream({ key: () => "dg", voice: () => "aura-2-andromeda-en", factory });
  const [a, b] = await Promise.all([au.synth("one."), au.synth("two.")]);
  expect(socks.length).toBe(1);
  expect(socks[0]!.headers.Authorization).toBe("Token dg");
  expect(socks[0]!.sent.map((m) => m.type)).toEqual(["Speak", "Flush", "Speak", "Flush"]);
  expect(a.ext).toBe("wav");
  expect(new TextDecoder().decode(a.bytes.slice(0, 4))).toBe("RIFF");
  expect(a.bytes.byteLength).toBe(244);
  expect(b.bytes.byteLength).toBe(244);
  expect(wav(new Uint8Array(10), 24000).byteLength).toBe(54);
});

test("a socket that won't open falls back to HTTP", async () => {
  const { factory } = fakeFactory(() => {}, { failOpen: true });
  let httpCalls = 0;
  const io: TtsIO = {
    fetch: async () => {
      httpCalls++;
      return new Response(new Uint8Array(500));
    },
    spawn: null as never,
    secret: (n) => (n === "DEEPGRAM_API_KEY" ? "dg" : ""),
    which: () => null,
    now: Date.now,
    tmpDir: "/tmp",
    socket: factory,
  };
  const b = deepgramTts(io);
  const out = await b.synth("hello.");
  expect(httpCalls).toBe(1);
  expect(out.ext).toBe("mp3");
  expect(b.lastPath?.()).toEqual({ via: "http" });
});
