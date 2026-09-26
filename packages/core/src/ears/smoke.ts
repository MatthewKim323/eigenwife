/**
 * End-to-end ears check against a running core: decode an audio file to 16kHz
 * mono PCM with ffmpeg, stream it into ws /ears at real time, and print the
 * voice.partial / voice.final events that come back over the bus.
 *
 *   bun run packages/core/src/ears/smoke.ts [audio file] [--core 127.0.0.1:7777]
 */
import { homedir } from "os";
import { join } from "path";
import { BusClient } from "@eigenwife/protocol/client";

const args = process.argv.slice(2);
const coreIdx = args.indexOf("--core");
const core = coreIdx >= 0 ? args[coreIdx + 1]! : "127.0.0.1:7777";
const file = args.find((a, i) => !a.startsWith("--") && i !== coreIdx + 1) ?? join(homedir(), ".eve", "voice-samples", "luna.mp3");

const status = await fetch(`http://${core}/api/ears/status`).then((r) => r.json()).catch(() => null);
console.log("status:", JSON.stringify(status));
if (!status?.available) process.exit(1);

const ff = Bun.spawn(["ffmpeg", "-v", "error", "-i", file, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], { stdout: "pipe" });
const pcm = new Uint8Array(await new Response(ff.stdout).arrayBuffer());
console.log(`audio: ${file} -> ${(pcm.byteLength / 32000).toFixed(1)}s of 16k pcm`);

const bus = new BusClient({ url: `ws://${core}/bus`, client: "ears-smoke", role: "observer" }).connect();
const finals: string[] = [];
bus.on("voice.partial", (e) => console.log("  partial:", e.data.text));
bus.on("voice.final", (e) => {
  console.log("  FINAL:  ", e.data.text, e.source);
  finals.push(e.data.text);
});

const ws = new WebSocket(`ws://${core}/ears?encoding=linear16&sample_rate=16000&client=smoke`);
ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.type === "status") console.log("  upstream:", m.upstream, m.reason ?? "");
};
await new Promise<void>((res, rej) => {
  ws.onopen = () => res();
  ws.onerror = () => rej(new Error("ws /ears failed"));
});

const chunk = 640; // 20ms
const t0 = performance.now();
for (let i = 0; i < pcm.byteLength; i += chunk) {
  ws.send(pcm.subarray(i, i + chunk));
  const due = ((i + chunk) / 32000) * 1000;
  const wait = due - (performance.now() - t0);
  if (wait > 0) await Bun.sleep(wait);
}
// A second and a half of silence lets endpointing close the utterance.
for (let i = 0; i < 75; i++) {
  ws.send(new Uint8Array(chunk));
  await Bun.sleep(20);
}
const deadline = Date.now() + 4000;
while (!finals.length && Date.now() < deadline) await Bun.sleep(50);
ws.close();
bus.close();
console.log(finals.length ? `ok: ${finals.length} final(s)` : "no voice.final arrived");
process.exit(finals.length ? 0 : 2);
