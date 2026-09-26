/**
 * Render every scripted line (src/speech/lines.ts) and every filler into the
 * audio cache, so the golden demo path never waits on live TTS.
 *
 *   bun run --cwd packages/core prerender              best available backend, skip cached
 *   bun run --cwd packages/core prerender --backend openai   (re)render with one backend
 *   bun run --cwd packages/core prerender --dry        just report what's cached
 *
 * Re-run after adding a key: lines cached with a lesser voice than the best
 * live backend are upgraded automatically (or force one with --backend <name>).
 */
import { homedir } from "os";
import { join } from "path";
import { secret } from "../src/config";
import { segmentText } from "../src/speech/chunker";
import { LINES, FILLERS, TOUCH_LINES } from "../src/speech/lines";
import { buildTts, ttsIO } from "../src/speech/module";

const args = process.argv.slice(2);
// Scripted lines are cached once, so they can afford ElevenLabs' most expressive model.
process.env.EVE_ELEVEN_MODEL ||= "eleven_v3";
const only = args.includes("--backend") ? args[args.indexOf("--backend") + 1] : undefined;
const dry = args.includes("--dry");
const eveHome = secret("EVE_HOME") || join(homedir(), ".eve");
const tts = buildTts(eveHome, ttsIO({ config: { eveHome } }), only ?? secret("EVE_TTS"));
if (!tts) {
  console.log("EVE_TTS=none: nothing to render. Segments will go out without audio (the shell uses speechSynthesis).");
  process.exit(0);
}

console.log(`audio cache: ${tts.cache.dir} (${tts.cache.size} files)`);
console.log(`backends: ${tts.backends.map((b) => `${b.name}${b.configured() ? "" : " (not configured)"}`).join(" > ")}`);

const entries: [string, string][] = [
  ...Object.entries(LINES),
  ...Object.entries(TOUCH_LINES).flatMap(([k, lines]) => lines.map((l, i) => [`touch.${k}${i}`, l] as [string, string])),
  ...FILLERS.map((f, i) => [`filler${i}`, f] as [string, string]),
];
let rendered = 0;
let cached = 0;
let failed = 0;
const t0 = performance.now();

// A cached copy only counts if its voice is at least as good as the best live backend.
const rank = (name: string) => tts.backends.findIndex((b) => b.name === name);
const bestLive = tts.live()[0]?.name;

for (const [name, line] of entries) {
  const parts: string[] = [];
  for (const seg of segmentText(line)) {
    const hit = tts.lookup(seg.text);
    const upgrade = !!hit && (only ? hit.backend !== only : bestLive !== undefined && rank(hit.backend) > rank(bestLive));
    if (hit && !upgrade) {
      cached++;
      parts.push(`${hit.backend}:cached`);
      continue;
    }
    if (dry) {
      parts.push("MISSING");
      failed++;
      continue;
    }
    const r = await tts.render(seg.text, undefined, only ? { only } : upgrade && bestLive ? { only: bestLive } : {});
    if (r) {
      rendered++;
      parts.push(`${r.backend}:${Math.round(r.ms)}ms`);
    } else {
      failed++;
      parts.push(hit ? `${hit.backend}:cached (upgrade failed)` : "FAILED");
    }
  }
  console.log(`${name.padEnd(14)} ${parts.join("  ").padEnd(48)} ${line}`);
}

console.log(`\n${rendered} rendered, ${cached} already cached, ${failed} ${dry ? "missing" : "failed"} in ${Math.round(performance.now() - t0)}ms`);
for (const [b, h] of Object.entries(tts.health.snapshot())) if (!h.ok) console.log(`  ${b} is down (auto-retried in 10 min): ${h.lastError?.replace(/\s+/g, " ")}`);
if (failed) console.log("failed lines still play: their segments go out without audioUrl and the shell falls back to speechSynthesis.");
