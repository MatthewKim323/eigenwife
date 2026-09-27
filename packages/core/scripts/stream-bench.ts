/**
 * Live audio streaming vs whole files, TTS + speech + the audio route only
 * (no talker, so LLM jitter doesn't drown the difference). For each line:
 * say() -> the moment the player could start her first segment, fetched from
 * a real core the way the shell does it:
 *
 *   whole (EVE_TTS_LIVE=0)  speech.segment when the file is ready, then the whole file
 *   live                    speech.segment at the first bytes, then the first body chunk
 *
 * Real network, prewarmed sockets. Every line is new text (no cache hits);
 * ElevenLabs characters are paid, keep rounds small.
 *
 *   bun --env-file=../../.env run scripts/stream-bench.ts [elevenlabs|deepgram] [rounds]
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AnyEnvelope } from "@eigenwife/protocol";
import { percentile } from "../src/talker/latency";

const which = process.argv[2] ?? "elevenlabs";
const rounds = Number(process.argv[3] ?? 4);
process.env.EIGEN_QUIET = process.env.EIGEN_QUIET ?? "1";
process.env.EVE_TTS = which;
process.env.EVE_PRERENDER_CLIPS = "0";

const { startCore } = await import("../src/index");
const { speechModule, buildTts, ttsIO } = await import("../src/speech/module");

const LINES = [
  "okay so here's the thing, it depends on the vibe.",
  "canberra, which still makes sydney a little mad.",
  "ramen tonight, tacos are a lunch food anyway.",
  "they've got three hearts and their blood is blue.",
  "cool the room down, then put your phone away.",
  "honestly a cat named toast is hard to beat.",
];

const tag = Date.now().toString(36).slice(-4);
const results: Record<string, number[]> = { whole: [], live: [] };
const full: Record<string, number[]> = { whole: [], live: [] };

for (let r = 0; r < rounds; r++) {
  for (const mode of ["whole", "live"] as const) {
    process.env.EVE_TTS_LIVE = mode === "live" ? "1" : "0";
    const home = mkdtempSync(join(tmpdir(), "eve-stream-bench-"));
    const tts = buildTts(home, ttsIO({ config: { eveHome: home } }));
    const port = 20000 + Math.floor(Math.random() * 20000);
    const core = await startCore([speechModule({ tts })], { port, eveHome: home });
    tts?.warm();
    await Bun.sleep(1500); // socket open
    const bus = core.ctx.bus;
    for (let i = 0; i < LINES.length; i++) {
      const text = `${LINES[i]!.replace(/\.$/, "")}, ${mode} ${tag}${r}${i}.`;
      const t0 = Date.now();
      const seg = new Promise<AnyEnvelope>((resolve) => {
        const off = bus.on("speech.segment", (e) => {
          off();
          resolve(e);
        });
      });
      const said = core.ctx.use("speech").say(text, { interrupt: true });
      const e = await seg;
      const d = e.data as { audioUrl?: string; stream?: boolean };
      if (!d.audioUrl) {
        console.log(`  ${mode}: no audio`);
        continue;
      }
      const res = await fetch(`http://127.0.0.1:${port}${d.audioUrl}`);
      const rd = res.body!.getReader();
      let first = 0;
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        if (!first && value?.byteLength) first = Date.now();
      }
      const end = Date.now();
      const playable = d.stream ? first : end;
      results[mode]!.push(playable - t0);
      full[mode]!.push(end - t0);
      console.log(`  ${mode}${d.stream ? " (live)" : ""}: playable ${playable - t0}ms, whole segment ${end - t0}ms  "${text}"`);
      await said;
      await Bun.sleep(400);
    }
    await core.stop();
    rmSync(home, { recursive: true, force: true });
  }
}
const f = (xs: number[]) => `p50 ${Math.round(percentile(xs, 50) ?? NaN)}ms p95 ${Math.round(percentile(xs, 95) ?? NaN)}ms`;
console.log(`\n${which}: whole files: first segment playable ${f(results.whole!)} (n=${results.whole!.length})`);
console.log(`${which}: live stream: first segment playable ${f(results.live!)}, whole segment in ${f(full.live!)} (n=${results.live!.length})`);
process.exit(0);
