/**
 * Live smoke test for the brains (real network, real CLIs). Not part of
 * bun test. Usage:
 *   bun run --cwd packages/core smoke:brains [persona|json|frontier|all] [engine]
 */
import { join } from "path";
import { homedir } from "os";
import { secret } from "../src/config";
import { bunSpawn, whichBin } from "../src/brains/io";
import { createBrains } from "../src/brains/service";

const mode = process.argv[2] ?? "persona";
const engine = (process.argv[3] ?? "auto") as "auto";

const brains = createBrains({
  io: { fetch: (i, init) => fetch(i, init), spawn: bunSpawn, secret, which: whichBin, workDir: join(homedir(), ".eve", "work"), now: Date.now },
  jabbyUrl: secret("JABBY_URL") || "http://127.0.0.1:4632",
  persona: () => null,
  relationship: () => null,
  world: () =>
    '- scene: desktop\n- user is looking at: Garlic Knockout Ramen, $21, 4.6 stars {"price":21,"restaurant":"Mensho Tokyo"} (1s ago, confidence 0.91)\n- user last said: "thoughts?" (0s ago)',
  log: (...a) => console.log("[brains]", ...a),
});

await brains.refresh();
console.log("status", brains.status());

if (mode === "persona" || mode === "all") {
  for (let i = 0; i < 2; i++) {
    const t0 = performance.now();
    let first = -1;
    let out = "";
    for await (const c of brains.persona({ event: "user asked for your opinion on what they're looking at", behavior: "react", userText: "thoughts?", maxWords: 14 })) {
      if (first < 0) first = performance.now() - t0;
      out += c;
    }
    console.log(`persona #${i + 1}: first ${Math.round(first)}ms total ${Math.round(performance.now() - t0)}ms ->`, JSON.stringify(out), brains.lastPersona()?.backend, brains.lastPersona()?.errors);
  }
}
if (mode === "json" || mode === "all") {
  const t0 = performance.now();
  const j = await brains.quickJson('Classify the user utterance. Return {"intent": "approve"|"deny"|"other"}.', "yeah lock it in", { timeoutMs: 20_000 });
  console.log(`quickJson ${Math.round(performance.now() - t0)}ms ->`, j);
}
if (mode === "frontier" || mode === "all") {
  const r = await brains.frontier({ goal: 'Plan tonight in 3 short steps for someone who wants cheap spicy ramen. Return {"steps": string[]}.', json: true, engine, timeoutMs: 120_000 });
  console.log("frontier", r.engine, r.ms, "ms", r.ok ? JSON.stringify(r.json) : r.error);
}
console.log("detail", JSON.stringify(brains.detail(), null, 1));
