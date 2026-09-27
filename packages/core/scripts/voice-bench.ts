/**
 * End of speech -> first audio, measured on a real core (brains, speech,
 * talker, reflex; real network). Plays his side over the bus: voice.final
 * with endOfTurn (what Flux sends), then waits for her reply's first audio
 * segment. Reports p50/p95 of:
 *   sound  first audio of any kind (filler "hm." included)
 *   reply  first audio of her actual reply
 *
 *   bun --env-file=../../.env run scripts/voice-bench.ts [talker backends, e.g. gateway | claude-cli | off] [turns]
 *
 * "off" measures the old path (no talker; persona brain). Keep traffic small:
 * the gateway key has a monthly cap.
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { envelope, type AnyEnvelope } from "@eigenwife/protocol";
import { percentile } from "../src/talker/latency";

const which = process.argv[2] ?? "gateway";
const turns = Number(process.argv[3] ?? 6);
const home = mkdtempSync(join(tmpdir(), "eve-bench-"));
process.env.EVE_HOME = home;
process.env.EIGEN_QUIET = process.env.EIGEN_QUIET ?? "1";
process.env.EIGEN_DEMO = "0";
process.env.EVE_TTS = process.env.EVE_TTS || "deepgram";
if (which === "off") process.env.EVE_TALKER = "off";
else process.env.EVE_TALKER_BACKENDS = which;

const { startCore } = await import("../src/index");
const { clock } = await import("../src/modules/clock");
const { homeModule } = await import("../src/home/module");
const { memoryModule } = await import("../src/memory/module");
const { relationshipModule } = await import("../src/mind/module");
const { brainsModule } = await import("../src/brains/module");
const { speechModule } = await import("../src/speech/module");
const { talkerModule } = await import("../src/talker/module");
const { reflexModule } = await import("../src/reflex/module");
const { DEFAULT_EVE } = await import("../src/brains/prompt");
const { FILLERS } = await import("../src/speech/lines");

const port = 20000 + Math.floor(Math.random() * 20000);
const core = await startCore([clock(), homeModule(), memoryModule(), relationshipModule(), brainsModule(), speechModule(), talkerModule(), reflexModule()], { port, eveHome: home });
const bus = core.ctx.bus;
const events: AnyEnvelope[] = [];
bus.on("*", (e) => void events.push(e));

const PHRASES = [
  "eve, what's the capital of australia?",
  "eve, give me one fun fact about octopuses.",
  "eve, should i get ramen or tacos tonight?",
  "eve, how do airplanes stay up, quick version?",
  "eve, what's a good name for a cat?",
  "eve, what do you think about pineapple on pizza?",
  "eve, explain black holes in one breath.",
  "eve, what's the best way to fall asleep fast?",
];

const waitFor = (pred: (e: AnyEnvelope) => boolean, ms: number, since: number) =>
  new Promise<AnyEnvelope | null>((resolve) => {
    const hit = events.slice(since).find(pred);
    if (hit) return resolve(hit);
    const timer = setTimeout(() => {
      off();
      resolve(null);
    }, ms);
    const off = bus.on("*", (e) => {
      if (!pred(e)) return;
      clearTimeout(timer);
      off();
      resolve(e);
    });
  });

bus.publish(envelope("companion.born", { persona: DEFAULT_EVE }, "bench") as AnyEnvelope);
await waitFor((e) => e.type === "speech.end", 30_000, 0);
await Bun.sleep(3000); // boot probes, clip prerender, socket prewarm
const sound: number[] = [];
const reply: number[] = [];
const fillers = new Set<string>(FILLERS);
for (let i = 0; i < turns; i++) {
  const text = PHRASES[i % PHRASES.length]!;
  const since = events.length;
  bus.publish(envelope("voice.partial", { text: text.slice(0, 10) }, "bench") as AnyEnvelope); // he started talking: sockets warm
  await Bun.sleep(600);
  const fin = envelope("voice.final", { text, endOfTurn: true }, "bench") as AnyEnvelope;
  bus.publish(fin);
  const first = await waitFor((e) => e.type === "speech.segment" && !!(e.data as { audioUrl?: string }).audioUrl, 20_000, since);
  const real = await waitFor((e) => e.type === "speech.segment" && !!(e.data as { audioUrl?: string }).audioUrl && !fillers.has((e.data as { text: string }).text), 20_000, since);
  if (first) sound.push(first.ts - fin.ts);
  if (real) reply.push(real.ts - fin.ts);
  const said = events
    .slice(since)
    .filter((e) => e.type === "speech.segment")
    .map((e) => (e.data as { text: string }).text)
    .join(" ");
  console.log(`  ${real ? real.ts - fin.ts : "--"}ms reply (${first ? first.ts - fin.ts : "--"}ms first sound)  "${text}" -> ${said.slice(0, 110)}`);
  await waitFor((e) => e.type === "speech.end", 20_000, since);
  await Bun.sleep(1500);
}
// --delegate: one lookup through the thinker (jabby first): stall latency, result latency, what she said.
if (process.argv.includes("--delegate")) {
  const since = events.length;
  const fin = envelope("voice.final", { text: "eve, what's the weather in irvine tonight?", endOfTurn: true }, "bench") as AnyEnvelope;
  bus.publish(fin);
  const del = await waitFor((e) => e.type === "talker.delegate", 20_000, since);
  const stall = await waitFor((e) => e.type === "speech.segment" && !!(e.data as { audioUrl?: string }).audioUrl && !fillers.has((e.data as { text: string }).text), 20_000, since);
  const begin = await waitFor((e) => e.type === "speech.begin" && (e.data as { brain: string }).brain === "thinker", 180_000, since);
  const result = begin ? await waitFor((e) => e.type === "speech.segment" && (e.data as { utteranceId: string }).utteranceId === (begin.data as { utteranceId: string }).utteranceId, 30_000, since) : null;
  await waitFor((e) => e.type === "speech.end" && !!begin && (e.data as { utteranceId: string }).utteranceId === (begin.data as { utteranceId: string }).utteranceId, 30_000, since);
  const said = events.slice(since).filter((e) => e.type === "speech.segment").map((e) => (e.data as { text: string }).text);
  console.log(`\ndelegate: ${JSON.stringify(del?.data ?? null)}`);
  console.log(`stall audio ${stall ? stall.ts - fin.ts : "--"}ms, result audio ${result ? result.ts - fin.ts : "--"}ms`);
  console.log(`said: ${said.join(" / ")}`);
}
const f = (xs: number[]) => `p50 ${Math.round(percentile(xs, 50) ?? NaN)}ms p95 ${Math.round(percentile(xs, 95) ?? NaN)}ms`;
const status = (await (await fetch(`http://127.0.0.1:${port}/api/talker/status`)).json().catch(() => ({}))) as { latency?: unknown };
console.log(`\n${which} (tts ${process.env.EVE_TTS}): reply ${f(reply)}, first sound ${f(sound)}  (n=${reply.length})`);
console.log(`talker status latency: ${JSON.stringify(status.latency ?? {})}`);
await core.stop();
rmSync(home, { recursive: true, force: true });
process.exit(0);
