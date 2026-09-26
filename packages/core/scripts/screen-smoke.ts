/**
 * Real-machine check of the screen sense against ONE window you name (docs/SCREEN.md).
 *
 *   bun run packages/core/scripts/screen-smoke.ts --pid <pid> --title <exact window title> [--look]
 *
 * Level 2: accessibility read of that app's focused window, redaction, local
 * summary, Jev scores (AI Gateway / TypeSafe when a key is set, local otherwise).
 * --look: level 3, one screencapture -l of that window into ~/.eve/tmp, a vision
 * description, and a check that the image was deleted.
 * Refuses to go on if the focused window's title isn't exactly --title.
 */
import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { bunSpawn, whichBin } from "../src/brains/io";
import { jevEndpoint, secret } from "../src/config";
import { createCapture } from "../src/screen/capture";
import { createScreenJev } from "../src/screen/jev";
import { PRIVATE_DOMAINS, privateReason } from "../src/screen/privacy";
import { redactScreenText } from "../src/screen/redact";
import { summarize } from "../src/screen/summarize";
import { defaultVisionEngines, describeImage } from "../src/screen/vision";
import { realExec } from "../src/work/exec";

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const pid = Number(arg("pid"));
const title = arg("title");
if (!pid || !title) {
  console.error("usage: screen-smoke.ts --pid <pid> --title <exact window title> [--look]");
  process.exit(2);
}
const eveHome = process.env.EVE_HOME || join(homedir(), ".eve");
const cap = createCapture({ exec: realExec, eveHome, log: (...a) => console.log("[capture]", ...a) });

console.log("permissions:", JSON.stringify(await cap.permissions()));
const d = await cap.dump({ pid, denyHosts: PRIVATE_DOMAINS });
if (!d.ok) throw new Error(`read failed: ${d.error}`);
if (d.title !== title) {
  console.error(`focused window is "${d.title}", not "${title}": stopping, nothing else read or sent.`);
  process.exit(1);
}
if (d.private || privateReason(d, { denyApps: [], denyDomains: [] })) throw new Error("private window: stopping");
let redactions = 0;
const texts = d.texts.map((x) => {
  const r = redactScreenText(x.t);
  redactions += r.count;
  return { r: x.r, t: r.text };
});
const digest = summarize({ app: d.app, title: d.title, url: d.url, texts, focusedRole: d.focusedRole }, redactions);
console.log(`level 2: ${d.app} "${d.title}" window ${d.windowId}, ${d.texts.length} text nodes, ${redactions} redactions`);
console.log("summary:", digest.summary);
console.log("error:", digest.error ?? "(none)");
const ep = jevEndpoint();
const jev = createScreenJev(ep ? { apiKey: ep.apiKey, url: ep.url, model: ep.model, timeoutMs: 4000 } : {});
for (const stuckMin of [0, 6]) {
  const j = await jev.judge({ digest, stuckMs: stuckMin * 60_000, idleSeconds: 20 });
  console.log(`jev (error up ${stuckMin} min): by=${j.by} ${j.latencyMs}ms ${JSON.stringify(j.scores)}${j.reason ? ` (${j.reason})` : ""}`);
}

if (process.argv.includes("--look")) {
  const io = { fetch: (u: string, i?: RequestInit) => fetch(u, i), spawn: bunSpawn, secret, which: (b: string) => whichBin(b), workDir: eveHome, now: Date.now };
  let path = "";
  const r = await cap.withWindowImage(d.windowId!, async (p) => {
    path = p;
    return describeImage(defaultVisionEngines(io), { imagePath: p, question: "what do you think of this", hint: digest.summary, timeoutMs: 60_000 });
  });
  if (!r.ok) throw new Error(`look failed: ${r.error}`);
  console.log(`level 3: by=${r.value.by} ${r.value.ms}ms ok=${r.value.ok}`);
  console.log("description:", r.value.description || r.value.error);
  const left = existsSync(cap.tmpDir) ? readdirSync(cap.tmpDir).filter((f) => f.startsWith("screen-")) : [];
  console.log(`temp image deleted: ${!existsSync(path)} (leftovers in ~/.eve/tmp: ${left.length})`);
}
