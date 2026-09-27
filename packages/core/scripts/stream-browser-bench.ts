/**
 * First audible sample, in a real Chromium: say() on a real core -> the
 * shell's own audio engine (apps/shell/src/voice/engine.ts, bundled for the
 * page) prepares the segment and starts it -> playback time moves past 0.
 * Whole files (EVE_TTS_LIVE=0: fetch, decodeAudioData, buffer source) vs live
 * streams (MediaSource mp3 / scheduled PCM wav). Headless Chromium from
 * playwright-core (PLAYWRIGHT_CORE=<path to playwright-core>), autoplay allowed.
 *
 *   PLAYWRIGHT_CORE=... bun --env-file=../../.env run scripts/stream-browser-bench.ts [elevenlabs|deepgram] [rounds]
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import type { AnyEnvelope } from "@eigenwife/protocol";
import { percentile } from "../src/talker/latency";

const which = process.argv[2] ?? "elevenlabs";
const rounds = Number(process.argv[3] ?? 3);
process.env.EIGEN_QUIET = process.env.EIGEN_QUIET ?? "1";
process.env.EVE_TTS = which;
process.env.EVE_PRERENDER_CLIPS = "0";

const pw = (await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core")) as typeof import("playwright-core");
const { startCore } = await import("../src/index");
const { speechModule, buildTts, ttsIO } = await import("../src/speech/module");

// The shell's engine, bundled for the page.
const built = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../apps/shell/src/voice/engine.ts")], target: "browser", format: "esm" });
if (!built.success) throw new Error(built.logs.join("\n"));
const engineJs = await built.outputs[0]!.text();

const LINES = [
  "okay so here's the thing, it depends on the vibe.",
  "canberra, which still makes sydney a little mad.",
  "ramen tonight, tacos are a lunch food anyway.",
  "they've got three hearts and their blood is blue.",
  "cool the room down, then put your phone away.",
  "honestly a cat named toast is hard to beat.",
];

const browser = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
const tag = Date.now().toString(36).slice(-4);
const audible: Record<string, number[]> = { whole: [], live: [] };

for (let r = 0; r < rounds; r++) {
  for (const mode of ["whole", "live"] as const) {
    process.env.EVE_TTS_LIVE = mode === "live" ? "1" : "0";
    const home = mkdtempSync(join(tmpdir(), "eve-browser-bench-"));
    const tts = buildTts(home, ttsIO({ config: { eveHome: home } }));
    const port = 20000 + Math.floor(Math.random() * 20000);
    const core = await startCore([speechModule({ tts })], { port, eveHome: home });
    // Page on the core's origin (like the shell talking to its core); the engine attached to window.
    await page.goto(`http://127.0.0.1:${port}/health`);
    await page.addScriptTag({ content: `${engineJs.replace(/export\s*\{[^}]*\};?\s*$/, "")}\nwindow.__engine = new WebAudioEngine();`, type: "module" });
    await page.waitForFunction(() => !!(window as any).__engine);
    await page.evaluate(async () => {
      const Ctor = (window as any).AudioContext;
      const ctx = ((globalThis as any).__eveAudioCtx ??= new Ctor({ latencyHint: "interactive" }));
      await ctx.resume();
    });
    tts?.warm();
    await Bun.sleep(1500);
    const bus = core.ctx.bus;
    for (let i = 0; i < LINES.length; i++) {
      const text = `${LINES[i]!.replace(/\.$/, "")}, ${mode} ${tag}${r}${i}.`;
      const seg = new Promise<AnyEnvelope>((res) => {
        const off = bus.on("speech.segment", (e) => {
          off();
          res(e);
        });
      });
      const t0 = Date.now();
      const said = core.ctx.use("speech").say(text, { interrupt: true });
      const d = (await seg).data as { audioUrl?: string; stream?: boolean };
      if (!d.audioUrl) continue;
      const out = await page.evaluate(
        async ({ url, stream }) => {
          const eng = (window as any).__engine;
          const pb = await eng.prepare(url, stream, new AbortController().signal);
          if (!pb) return { at: 0, streamed: false, err: "no playback" };
          let ended = false;
          await pb.start(() => (ended = true));
          while (pb.time() <= 0 && !ended) await new Promise((r) => setTimeout(r, 2));
          const at = Date.now();
          const streamed = pb.streamed;
          await new Promise<void>((r) => {
            const t = setInterval(() => {
              if (ended) {
                clearInterval(t);
                r();
              }
            }, 20);
          });
          return { at, streamed, err: "" };
        },
        { url: `http://127.0.0.1:${port}${d.audioUrl}`, stream: !!d.stream },
      );
      if (out.err) console.log(`  ${mode}: ${out.err}`);
      else {
        audible[mode]!.push(out.at - t0);
        console.log(`  ${mode}${out.streamed ? " (streamed)" : ""}: first audible ${out.at - t0}ms  "${text}"`);
      }
      await said;
      await Bun.sleep(300);
    }
    await core.stop();
    rmSync(home, { recursive: true, force: true });
  }
}
await browser.close();
const f = (xs: number[]) => `p50 ${Math.round(percentile(xs, 50) ?? NaN)}ms p95 ${Math.round(percentile(xs, 95) ?? NaN)}ms (n=${xs.length})`;
console.log(`\n${which}: say -> first audible sample in chromium: whole files ${f(audible.whole!)}, live stream ${f(audible.live!)}`);
process.exit(0);
