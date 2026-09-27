/**
 * Eve Live against the REAL gpt-live-1 (bills ~$0.05/min: keep it short).
 * Boots a small core (live + reflex with local Jev; fake speech, memory,
 * agency so nothing real happens on the Mac), plays the headless page, speaks
 * two recorded questions (macOS `say` -> 24kHz PCM16), and prints latency:
 *
 *   turn   end of his audio -> her first transcript / first audio byte
 *   deleg  end of his audio -> session.delegation.created -> commentary -> her voicing it
 *
 *   bun run packages/core/src/live/smoke.ts [--voice gleam] [--dump out.pcm]
 *
 * Needs AI_GATEWAY_API_KEY with credits (or OPENAI_API_KEY: WebRTC can't run
 * headless, so the smoke uses the gateway only).
 */
import { readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AnyEnvelope } from "@eigenwife/protocol";
import { startCore, type Module } from "../index";
import { parseDotEnv, secret } from "../config";
import { createJev } from "../reflex/jev";
import { reflexModule } from "../reflex/module";
import { FakeAgency, FakeBrains, FakeHome, FakeMemory, FakeSpeech } from "../reflex/testing";
import { HeadlessPage } from "./headless";
import { liveModule } from "./module";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const voice = arg("--voice") ?? "gleam";
const dump = arg("--dump");
// --env <file>: take the gateway key from another checkout's .env (never printed).
const envFile = arg("--env");
if (envFile && !process.env.AI_GATEWAY_API_KEY) {
  const k = parseDotEnv(readFileSync(envFile, "utf8")).AI_GATEWAY_API_KEY;
  if (k) process.env.AI_GATEWAY_API_KEY = k;
}
if (!secret("AI_GATEWAY_API_KEY")) {
  console.log("no AI_GATEWAY_API_KEY: nothing to smoke");
  process.exit(1);
}

async function speech(text: string): Promise<Uint8Array> {
  const dir = tmpdir();
  const aiff = join(dir, `eve-live-${Date.now()}.aiff`);
  await Bun.spawn(["say", "-v", "Samantha", "-o", aiff, text]).exited;
  const ff = Bun.spawn(["ffmpeg", "-v", "error", "-i", aiff, "-ac", "1", "-ar", "24000", "-f", "s16le", "-"], { stdout: "pipe" });
  return new Uint8Array(await new Response(ff.stdout).arrayBuffer());
}

const events: AnyEnvelope[] = [];
const agency = new FakeAgency({ ok: true, summary: "playing your song." }, 50);
const fixtures: Module = {
  name: "smoke-fixtures",
  start(ctx) {
    ctx.bus.on("*", (e: AnyEnvelope) => void events.push(e));
    ctx.provide("home", new FakeHome());
    ctx.provide("speech", new FakeSpeech(ctx));
    ctx.provide("brains", new FakeBrains((r) => `(${r.behavior}) persona line`));
    ctx.provide("memory", new FakeMemory(ctx, ["his song with her is 'Pink + White' by Frank Ocean"]));
    ctx.provide("agency", agency);
  },
};
process.env.EIGEN_QUIET = process.env.EIGEN_QUIET ?? "1";
const core = await startCore([fixtures, liveModule({ config: { envEngine: "live", voice, idleMin: 0, provider: "gateway" }, tickMs: 0 }), reflexModule({ jev: createJev({}) })], { port: 0, demo: false });
core.ctx.bus.emit("companion.born", { persona: { name: "Eve", tagline: "", description: "Eve lives on his desktop.", personality: "Dry, teasing, warm underneath.", scenario: "Evening.", dials: { humor: 0.8, sarcasm: 0.6, warmth: 0.7, initiative: 0.6, verbosity: 0.3, chaos: 0.4 }, voice: { provider: "openai", voiceId: voice, style: "soft" }, palette: { hue: 330 }, vector: {} } }, "smoke");

const audioOut: Uint8Array[] = [];
let firstAudioAt = 0;
let firstTextAt = 0;
let delegationAt = 0;
let commentaryAt = 0;
/** The Live socket streams audio continuously (silence too): count only voiced chunks. */
const voiced = (b: Buffer) => {
  let s = 0;
  const n = b.length >> 1;
  for (let i = 0; i < n; i++) {
    const v = b.readInt16LE(i * 2) / 32768;
    s += v * v;
  }
  return n > 0 && Math.sqrt(s / n) > 0.01;
};
const page = new HeadlessPage({
  core: `ws://127.0.0.1:${core.port}`,
  onAudio: (b64) => {
    const b = Buffer.from(b64, "base64");
    if (!firstAudioAt && voiced(b)) firstAudioAt = performance.now();
    audioOut.push(b);
  },
  onDown: (m) => {
    if (m.type === "send" && m.event.type === "session.commentary.append" && !commentaryAt) commentaryAt = performance.now();
  },
  onEvent: (e) => {
    if (e.type === "session.output_transcript.delta" && !firstTextAt) firstTextAt = performance.now();
    if (e.type === "session.output_transcript.delta") process.stdout.write(String(e.delta));
    if (e.type === "session.delegation.created" && !delegationAt) delegationAt = performance.now();
    if (e.type === "session.delegation.created") console.log(`\n  [delegation ${(e.delegation as { id: string }).id}]`);
    if (e.type === "error") console.log("\n  [error]", JSON.stringify(e.error));
  },
});
const t0 = performance.now();
await page.connect();
const until = async (pred: () => boolean, ms: number) => {
  const s = performance.now();
  while (!pred() && performance.now() - s < ms) await Bun.sleep(10);
  return pred();
};
if (!(await until(() => page.started, 15_000))) {
  const st = events.filter((e) => e.type === "live.state").at(-1);
  console.log("no session:", JSON.stringify(st?.data));
  page.close();
  await core.stop();
  process.exit(1);
}
console.log(`session up in ${Math.round(performance.now() - t0)}ms (mint + ws + session.started)`);

async function ask(text: string, waitMs: number) {
  const pcm = await speech(text);
  firstAudioAt = 0;
  firstTextAt = 0;
  console.log(`\nhim: "${text}" (${(pcm.byteLength / 48000).toFixed(1)}s)`);
  page.feed(pcm);
  const endAt = performance.now() + (pcm.byteLength / 48000) * 1000;
  // Ignore anything she was still saying before he finished.
  await Bun.sleep((pcm.byteLength / 48000) * 1000);
  firstAudioAt = 0;
  firstTextAt = 0;
  await Bun.sleep(waitMs);
  const turnText = firstTextAt ? Math.round(firstTextAt - endAt) : null;
  const turnAudio = firstAudioAt ? Math.round(firstAudioAt - endAt) : null;
  const deleg = delegationAt > endAt - 2000 ? Math.round(delegationAt - endAt) : null;
  const comm = commentaryAt > endAt - 2000 ? Math.round(commentaryAt - endAt) : null;
  console.log(`\n  turn latency: first voiced audio ${turnAudio}ms, first transcript ${turnText}ms after his audio ended${deleg !== null ? `; delegation at ${deleg}ms, first commentary sent at ${comm}ms` : ""}`);
  return { turnAudio, turnText, delegationMs: deleg, commentaryMs: comm };
}

const a = await ask("hey eve, how's your night going?", 7000);
const b = await ask("can you play our song for me?", 11000);
const acts = agency.acts.map((x) => x.kind);
const finals = events.filter((e) => e.type === "voice.final" && e.source === "live").map((e) => (e.data as { text: string }).text);
const eveLines = events.filter((e) => e.type === "conversation.turn" && (e.data as { role: string }).role === "eve").map((e) => (e.data as { text: string }).text);
const commentary = page.sent.filter((e) => e.type === "session.commentary.append" || e.type === "session.thinking.append").map((e) => `${e.type} ${e.delegation_id ?? "null"}: ${String(e.content).slice(0, 80)}`);

const closeAt = performance.now();
await core.ctx.use("speech"); // keep the core warm until close
const live = events.filter((e) => e.type === "live.state").at(-1);
await fetch(`http://127.0.0.1:${core.port}/api/live/engine`, { method: "POST", body: JSON.stringify({ engine: "classic" }) });
await until(() => !page.started, 8000);
const usage = events.filter((e) => e.type === "live.state").at(-1);
console.log(`\nclosed in ${Math.round(performance.now() - closeAt)}ms`);
console.log(JSON.stringify({ voice, turn1: a, turn2: b, heard: finals, her: eveLines, delegationUpdates: commentary, actions: acts, liveState: live?.data, after: usage?.data }, null, 2));
if (dump) {
  const all = Buffer.concat(audioOut);
  writeFileSync(dump, all);
  console.log(`her audio -> ${dump} (${(all.byteLength / 48000).toFixed(1)}s; ffplay -f s16le -ar 24000 -ac 1 ${dump})`);
}
page.close();
await core.stop();
process.exit(0);
