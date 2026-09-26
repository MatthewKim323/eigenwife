/**
 * Live end-to-end smoke: persona brain -> speech pipeline -> real TTS, timing
 * every event. Not part of bun test.
 *   bun run --cwd packages/core smoke:speech ["what the user says"]
 */
import { brainsModule } from "../src/brains/module";
import { speechModule } from "../src/speech/module";
import { startCore } from "../src/index";

process.env.EIGEN_QUIET ??= "1";
const core = await startCore([brainsModule(), speechModule()], { port: Number(process.env.SMOKE_PORT ?? 17799) });
const brains = core.ctx.use("brains");
const speech = core.ctx.use("speech");
core.ctx.bus.emit("gaze.target", { target: { key: "menu_3", label: "Garlic Knockout Ramen, $21, 4.6 stars", kind: "menu-item", meta: { price: 21, restaurant: "Mensho Tokyo" } }, dwellMs: 1800, confidence: 0.9 }, "shell");

const said = process.argv[2] ?? "thoughts?";
for (let run = 1; run <= 2; run++) {
  const t0 = performance.now();
  const at = (label: string) => console.log(`  +${String(Math.round(performance.now() - t0)).padStart(5)}ms ${label}`);
  const offs = [
    core.ctx.bus.on("speech.segment", (e) => at(`segment ${e.data.seq} "${e.data.text}" ${e.data.audioUrl ? "audio" : "no audio"} marks=${JSON.stringify(e.data.marks)}`)),
    core.ctx.bus.on("avatar.state", (e) => at(`avatar ${e.data.state}`)),
    core.ctx.bus.on("speech.end", (e) => at(`end interrupted=${e.data.interrupted}`)),
  ];
  console.log(`run ${run}: user says "${said}"`);
  let first = -1;
  const stream = (async function* () {
    for await (const c of brains.persona({ event: "the user asked about what they're looking at", behavior: "react", userText: said, maxWords: 14 })) {
      if (first < 0) {
        first = performance.now() - t0;
        at("first token");
      }
      yield c;
    }
  })();
  const r = await speech.say(stream, { brain: "persona", priority: "high" });
  at(`queued: "${r.text}" via ${brains.lastPersona()?.backend}`);
  offs.forEach((o) => o());
  speech.stop("next run");
}
await core.stop();
process.exit(0);
