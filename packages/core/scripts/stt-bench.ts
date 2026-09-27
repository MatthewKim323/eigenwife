/**
 * End-of-turn latency: Deepgram Flux (eager + final) vs nova-3 (300ms
 * endpointing). Renders phrases with macOS `say`, streams them in real time
 * (80ms chunks, then silence) and times end of audio -> each event.
 *
 *   bun run scripts/stt-bench.ts [rounds]
 */
import { tmpdir } from "os";
import { join } from "path";
import { secret } from "../src/config";
import { listenUrl } from "../src/ears/deepgram";
import { fluxUrl } from "../src/ears/flux";
import { percentile } from "../src/talker/latency";

const rounds = Number(process.argv[2] ?? 2);
const key = secret("DEEPGRAM_API_KEY");
if (!key) throw new Error("DEEPGRAM_API_KEY not set");
const phrases = ["hey eve what's the capital of australia", "what should we eat tonight", "tell me a fun fact about octopuses"];

async function pcm(text: string): Promise<Uint8Array> {
  const f = join(tmpdir(), `stt-bench-${Math.random().toString(36).slice(2)}.aiff`);
  await Bun.spawn(["say", "-v", "Samantha", "-o", f, text]).exited;
  const ff = Bun.spawn(["ffmpeg", "-v", "error", "-i", f, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], { stdout: "pipe" });
  return new Uint8Array(await new Response(ff.stdout).arrayBuffer());
}

async function run(url: string, audio: Uint8Array, flux: boolean): Promise<{ eager?: number; final?: number; text?: string }> {
  const ws = new WebSocket(url, { headers: { Authorization: `Token ${key}` } } as never);
  ws.binaryType = "arraybuffer";
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws error"));
  });
  let endAt = 0;
  const out: { eager?: number; final?: number; text?: string } = {};
  const done = new Promise<void>((res) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      const t = performance.now() - endAt;
      if (flux && m.type === "TurnInfo") {
        if (m.event === "EagerEndOfTurn" && out.eager === undefined && endAt) out.eager = t;
        if (m.event === "EndOfTurn") {
          out.final = endAt ? t : 0;
          out.text = m.transcript;
          res();
        }
      } else if (!flux && m.type === "Results" && m.speech_final) {
        out.final = endAt ? t : 0;
        out.text = m.channel?.alternatives?.[0]?.transcript;
        res();
      }
    };
  });
  const chunk = 2560; // 80ms
  for (let i = 0; i < audio.length; i += chunk) {
    ws.send(audio.slice(i, i + chunk));
    await Bun.sleep(80);
  }
  endAt = performance.now();
  const silence = new Uint8Array(chunk);
  const stop = (async () => {
    for (let i = 0; i < 60 && out.final === undefined; i++) {
      ws.send(silence);
      await Bun.sleep(80);
    }
  })();
  await Promise.race([done, Bun.sleep(6000)]);
  await stop;
  try {
    ws.send(JSON.stringify({ type: "CloseStream" }));
    ws.close();
  } catch {}
  return out;
}

const audio = await Promise.all(phrases.map(pcm));
const res: Record<string, { eager: number[]; final: number[] }> = { flux: { eager: [], final: [] }, nova: { eager: [], final: [] } };
for (let r = 0; r < rounds; r++)
  for (const [i, a] of audio.entries()) {
    const f = await run(fluxUrl({ encoding: "linear16", sampleRate: 16000 }), a, true);
    const n = await run(listenUrl({ encoding: "linear16", sampleRate: 16000 }), a, false);
    if (f.eager !== undefined) res.flux!.eager.push(f.eager);
    if (f.final !== undefined) res.flux!.final.push(f.final);
    if (n.final !== undefined) res.nova!.final.push(n.final);
    console.log(`  "${phrases[i]}": flux eager ${Math.round(f.eager ?? NaN)}ms final ${Math.round(f.final ?? NaN)}ms ("${f.text}") | nova speech_final ${Math.round(n.final ?? NaN)}ms`);
  }
const p = (xs: number[]) => `p50 ${Math.round(percentile(xs, 50) ?? NaN)}ms p95 ${Math.round(percentile(xs, 95) ?? NaN)}ms (n=${xs.length})`;
console.log(`\nflux eager: ${p(res.flux!.eager)}\nflux EndOfTurn: ${p(res.flux!.final)}\nnova-3 speech_final: ${p(res.nova!.final)}`);
process.exit(0);
