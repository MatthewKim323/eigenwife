/**
 * TTS latency: HTTP vs the prewarmed websocket, per backend. Time until the
 * whole segment is ready (what the shell waits for) and, over ws, the first
 * audio byte. Real network, a few short lines (ElevenLabs characters are paid).
 *
 *   bun --env-file=../../.env run scripts/tts-bench.ts [deepgram|elevenlabs] [rounds]
 */
import { tmpdir } from "os";
import { join } from "path";
import { secret } from "../src/config";
import { bunSpawn, whichBin } from "../src/brains/io";
import { bunSocket } from "../src/speech/sockets";
import { deepgramTts, elevenLabsTts, type TtsBackend, type TtsIO } from "../src/speech/tts";
import { percentile } from "../src/talker/latency";

const which = process.argv[2] ?? "deepgram";
const rounds = Number(process.argv[3] ?? 3);
const lines = ["okay, so here's the thing.", "one sec, checking.", "canberra. sydney's still mad about it."];

const base: TtsIO = { fetch: (i, init) => fetch(i, init), spawn: bunSpawn, secret, which: whichBin, now: Date.now, tmpDir: join(tmpdir(), "eve-tts-bench") };
const make = (ws: boolean): TtsBackend => {
  const io = ws ? { ...base, socket: bunSocket } : base;
  return which === "elevenlabs" ? elevenLabsTts(io) : deepgramTts(io);
};

for (const mode of ["http", "ws"] as const) {
  const b = make(mode === "ws");
  if (!b.configured()) {
    console.log(`${which}: not configured`);
    process.exit(1);
  }
  if (mode === "ws") {
    b.warm?.();
    await Bun.sleep(1200);
  } else await b.synth("hm.").catch(() => null); // warm the HTTP connection too: fair fight
  const full: number[] = [];
  const first: number[] = [];
  for (let r = 0; r < rounds; r++)
    for (const text of lines) {
      const t0 = performance.now();
      try {
        const out = await b.synth(`${text}${r ? "" : " "}`.trim());
        full.push(performance.now() - t0);
        const p = b.lastPath?.();
        if (p?.via === "ws" && p.firstChunkMs !== undefined) first.push(p.firstChunkMs);
        if (p && p.via !== mode) console.log(`  (fell back to ${p.via})`);
        void out;
      } catch (err) {
        console.log(`  ${mode} failed: ${err}`);
      }
      await Bun.sleep(300);
    }
  const f = (xs: number[]) => `p50 ${Math.round(percentile(xs, 50) ?? NaN)}ms p95 ${Math.round(percentile(xs, 95) ?? NaN)}ms (n=${xs.length})`;
  console.log(`${which} ${mode}: segment ready ${f(full)}${first.length ? `, first byte ${f(first)}` : ""}`);
}
process.exit(0);
