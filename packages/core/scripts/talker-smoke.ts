/**
 * Live talker check (real network, small traffic). One turn per phrase per
 * backend: first word ms, what she said, and whether she delegated.
 *
 *   bun --env-file=../../.env run scripts/talker-smoke.ts [backend] ["phrase" ...]
 */
import { homedir } from "os";
import { join } from "path";
import { secret } from "../src/config";
import { bunSpawn, whichBin, type BrainIO } from "../src/brains/io";
import { DEFAULT_EVE } from "../src/brains/prompt";
import { defaultTalkerBackends } from "../src/talker/backends";
import { buildTalkerPrompt, talkerMaxTokens } from "../src/talker/prompt";
import { createTalker } from "../src/talker/run";

const args = process.argv.slice(2);
const only = args[0] && !args[0].includes(" ") ? args.shift() : undefined;
const phrases = args.length ? args : ["what's the capital of australia?", "what's the weather in irvine tonight?", "tell me a fun fact about octopuses"];

const io: BrainIO = { fetch: (i, init) => fetch(i, init), spawn: bunSpawn, secret, which: whichBin, workDir: join(homedir(), ".eve", "work"), now: Date.now };
const all = defaultTalkerBackends(io).filter((b) => b.configured() && (!only || b.name === only));
console.log(`backends: ${all.map((b) => `${b.name}(${b.model()})`).join(", ") || "none"}`);

for (const b of all) {
  const talker = createTalker({
    io,
    backends: [b],
    prompt: (req) => buildTalkerPrompt({ persona: DEFAULT_EVE, world: "- scene: desktop", userText: req.userText, maxWords: req.maxWords ?? 45 }),
    maxTokens: (req) => talkerMaxTokens(req.maxWords ?? 45),
  });
  for (const p of phrases) {
    const run = talker.start({ userText: p, maxWords: 45 });
    await run.finished;
    const first = run.firstTextAt !== null ? run.firstTextAt - run.startedAt : null;
    console.log(`\n[${b.name}] "${p}"\n  first word ${first}ms, total ${Date.now() - run.startedAt}ms\n  said: ${run.said.trim() || "(nothing)"}${run.call ? `\n  delegate: ${JSON.stringify(run.call)}` : ""}${run.errors.length ? `\n  errors: ${run.errors.join("; ")}` : ""}`);
  }
}
