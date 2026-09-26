/**
 * Headless golden-path run. Boots the real core (every module, real brains)
 * in a throwaway EVE_HOME and plays the shell's part over the bus:
 *
 *   act I attention -> convergence -> birth -> "thoughts?" on a gazed item ->
 *   memory recall -> "figure out tonight" swarm + approval -> dating relapse
 *
 *   bun run scripts/e2e.ts              deny the calendar write (no side effects)
 *   bun run scripts/e2e.ts --approve    approve it for real (event is deleted after)
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BusClient } from "../packages/protocol/src/client";
import { CANDIDATES, regionKey, type AnyEnvelope, type EventType } from "../packages/protocol/src/index";

const approve = process.argv.includes("--approve");
const port = Number(process.env.E2E_PORT) || 20000 + Math.floor(Math.random() * 20000);
const home = mkdtempSync(join(tmpdir(), "eve-e2e-"));
process.env.EVE_HOME = home;
// Test runs never spend ElevenLabs characters (pay-as-you-go): Deepgram voices the e2e.
process.env.EVE_TTS = process.env.E2E_TTS ?? "deepgram";
process.env.EIGEN_PORT = String(port);
process.env.EIGEN_QUIET = process.env.EIGEN_QUIET ?? "1";

const { startCore } = await import("../packages/core/src/index");
const { allModules } = await import("../packages/core/src/modules/registry");
const core = await startCore(allModules(), { port, eveHome: home });

const shell = new BusClient({ url: `ws://127.0.0.1:${port}/bus`, client: "shell", role: "shell" }).connect();
const log: AnyEnvelope[] = [];
shell.on("*", (e) => log.push(e));
const t0 = Date.now();
const results: { step: string; ok: boolean; detail: string; ms: number }[] = [];

function waitFor<K extends EventType>(type: K, pred: (e: AnyEnvelope & { type: K }) => boolean = () => true, ms = 30_000, since = log.length) {
  return new Promise<(AnyEnvelope & { type: K }) | null>((resolve) => {
    const hit = log.slice(since).find((e) => e.type === type && pred(e as never));
    if (hit) return resolve(hit as never);
    const timer = setTimeout(() => {
      off();
      resolve(null);
    }, ms);
    const off = shell.on(type, (e) => {
      if (!pred(e as never)) return;
      clearTimeout(timer);
      off();
      resolve(e as never);
    });
  });
}

/** Everything Eve said after `since`, joined per utterance. */
function spoken(since: number): string[] {
  const byUtt = new Map<string, string[]>();
  for (const e of log.slice(since)) if (e.type === "speech.segment") (byUtt.get(e.data.utteranceId) ?? byUtt.set(e.data.utteranceId, []).get(e.data.utteranceId)!).push(e.data.text);
  return [...byUtt.values()].map((s) => s.join(" "));
}

async function step(name: string, fn: () => Promise<string>) {
  const s = Date.now();
  try {
    const detail = await fn();
    results.push({ step: name, ok: true, detail, ms: Date.now() - s });
    console.log(`  \x1b[32mok\x1b[0m  ${name}  (${Date.now() - s}ms)  ${detail}`);
  } catch (err) {
    results.push({ step: name, ok: false, detail: String(err), ms: Date.now() - s });
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}  (${Date.now() - s}ms)  ${err}`);
  }
}

async function speechAfter(since: number, ms = 45_000): Promise<string> {
  const end = await waitFor("speech.end", () => true, ms, since);
  if (!end) throw new Error("she never finished speaking");
  await Bun.sleep(200);
  return spoken(since).join(" / ");
}

while (!shell.connected) await Bun.sleep(20);
console.log(`\n  eigenwife e2e  (core :${port}, home ${home})\n  brains: ${JSON.stringify(core.ctx.tryUse("brains")?.status() ?? {})}\n`);

await step("act I: attention on sarcastic prompts converges", async () => {
  if (CANDIDATES.length === 0) throw new Error("no candidates");
  shell.emit("shell.scene", { scene: "dating" });
  CANDIDATES.forEach((c, i) => {
    shell.emit("dating.view", { candidateId: c.id, index: i, total: CANDIDATES.length });
    const regions: Record<string, { dwellMs: number; visits: number; revisits: number; longestMs: number }> = {};
    for (const r of c.regions) {
      const sarcasm = r.emphasis.sarcasm ?? 0;
      const dwell = 300 + sarcasm * 4000 * c.traits.sarcasm;
      regions[regionKey(c.id, r.id)] = { dwellMs: dwell, visits: 1 + (sarcasm > 0.5 ? 1 : 0), revisits: sarcasm > 0.5 ? 1 : 0, longestMs: dwell * 0.7 };
    }
    shell.emit("dating.leave", { candidateId: c.id, regions, totalMs: 6000, skipLatencyMs: 2000 + c.traits.sarcasm * 4000 });
  });
  const conv = await waitFor("preference.converged", () => true, 30_000, 0);
  if (!conv) throw new Error("never converged");
  const top = Object.entries(conv.data.vector).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (!top.some(([k]) => k === "sarcasm")) throw new Error(`sarcasm not in top 3: ${JSON.stringify(top)}`);
  return `top traits ${top.map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ")}; persona "${conv.data.persona.tagline}"`;
});

await step("emergence: born once, first words", async () => {
  const since = log.length;
  shell.emit("shell.scene", { scene: "emergence" });
  const born = await waitFor("companion.born", () => true, 10_000, since);
  if (!born) throw new Error("companion.born never fired");
  return `"${await speechAfter(since)}"`;
});

await step("deixis: 'thoughts?' while looking at the $21 ramen", async () => {
  shell.emit("shell.scene", { scene: "desktop" });
  const targets = [
    { key: "menu_garlic", label: "Garlic Knockout Ramen, $21", kind: "menu-item" as const, meta: { price: 21, spice: 3, restaurant: "Menya Kōbō" } },
    { key: "menu_premium", label: "A5 Wagyu Tonkotsu, $28", kind: "menu-item" as const, meta: { price: 28, spice: 1 } },
  ];
  shell.emit("page.context", { url: "http://127.0.0.1:5173/menu", title: "Menya Kōbō menu", targets });
  shell.emit("gaze.target", { target: targets[0]!, dwellMs: 1400, confidence: 0.9 });
  await Bun.sleep(300);
  const since = log.length;
  shell.emit("voice.final", { text: "thoughts?" });
  const said = await speechAfter(since);
  const grounded = /21|twenty|garlic|ramen|price|pricey|expensive|bowl/i.test(said);
  if (!grounded) throw new Error(`not grounded in the gaze target: "${said}"`);
  return `"${said}"`;
});

await step("memory: 'what should we eat then?' recalls preferences", async () => {
  const since = log.length;
  shell.emit("voice.final", { text: "okay what should we eat then?" });
  const recall = await waitFor("memory.recall", (e) => e.data.hits.length > 0, 30_000, since);
  if (!recall) throw new Error("no memory.recall with hits");
  const said = await speechAfter(since);
  return `recalled [${recall.data.hits.map((h) => h.record.content).slice(0, 3).join("; ")}] in ${recall.data.ms}ms, said "${said}"`;
});

await step(`agency: 'just figure out tonight' (${approve ? "approve" : "deny"})`, async () => {
  const since = log.length;
  shell.emit("voice.final", { text: "actually just figure out tonight" });
  const start = await waitFor("task.start", () => true, 30_000, since);
  if (!start) throw new Error("no task.start");
  const req = await waitFor("action.request", (e) => e.data.needsApproval, 120_000, since);
  if (!req) throw new Error("no approval request");
  const spawns = log.slice(since).filter((e) => e.type === "swarm.spawn").length;
  await Bun.sleep(1500);
  shell.emit("voice.final", { text: approve ? "yeah lock it in" : "nah not tonight" });
  const done = await waitFor("task.done", () => true, 120_000, since);
  if (!done) throw new Error("no task.done");
  const result = await waitFor("action.result", (e) => e.data.actionId === req.data.actionId, approve ? 30_000 : 3000, since);
  return `${spawns} agents, asked "${req.data.description}", ${approve ? "approved" : "denied"}, done: "${done.data.summary}"${result ? `, result: ${result.data.observation}` : ""}`;
});

await step("relapse: reopening the dating app", async () => {
  await Bun.sleep(2500);
  const since = log.length;
  shell.emit("app.opened", { app: "Eigen" });
  shell.emit("shell.scene", { scene: "dating" });
  const decision = await waitFor("reflex.decision", (e) => e.data.trigger.includes("relapse"), 10_000, since);
  const line = await waitFor("speech.segment", (e) => /seriously/i.test(e.data.text), 15_000, since);
  if (!line) throw new Error("no '...seriously?'");
  const said = line.data.text;
  const closed = await waitFor("shell.scene", (e) => e.data.scene === "desktop", 15_000, since);
  if (!decision) throw new Error("no relapse decision");
  if (!closed) throw new Error("she never closed it");
  return `${decision.data.decision} (${decision.data.by}), said "${said}", closed it`;
});

const reflex = log.filter((e) => e.type === "reflex.decision");
const ignored = reflex.filter((e) => e.data.decision === "IGNORE").length;
console.log(`\n  ${results.filter((r) => r.ok).length}/${results.length} steps ok in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${log.length} events, reflex ${reflex.length} decisions (${ignored} ignored)\n`);

if (approve) {
  const res = [...log].reverse().find((e) => e.type === "action.result" && e.data.ok);
  const agency = core.ctx.tryUse("agency");
  if (res && agency) {
    const cleanup = await agency.act("calendar.delete_event", { title: "*", calendar: "Eigenwife", createdByE2E: true }).catch((e) => ({ ok: false, observation: String(e) }));
    console.log(`  cleanup: ${cleanup.observation}`);
  }
}

shell.close();
await core.stop();
rmSync(home, { recursive: true, force: true });
process.exit(results.every((r) => r.ok) ? 0 : 1);
