/**
 * Know-me smoke (docs/KNOW_ME.md), against matt's REAL gbrain, READ-ONLY:
 * the runner refuses anything but query/search/list/get, and write-back is off.
 * Runs in a throwaway EVE_HOME (never touches ~/.eve).
 *
 *   bun run --cwd packages/core scripts/know-me-smoke.ts            # everything
 *   bun run --cwd packages/core scripts/know-me-smoke.ts --no-digest  # skip the slow brain summary
 *   ... --json   machine-readable summary
 *
 * Measures: gbrain query / search p50, world preload size + time, recall
 * latency for preloaded facts (local), prefetch hit rate on simulated turns,
 * and the digest's profile fields.
 */
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventBus } from "../src/bus";
import { loadConfig } from "../src/config";
import { createContext, type Module } from "../src/context";
import { brainsModule } from "../src/brains/module";
import { homeModule } from "../src/home/module";
import { bunRunner, GbrainClient, type GbrainRunner } from "../src/memory/gbrain";
import { memoryModule, type MemoryServiceImpl } from "../src/memory/module";
import type { WorldCache } from "../src/memory/gbrain-world";
import type { Digest } from "../src/memory/gbrain-digest";
import { onboardingModule } from "../src/onboarding/module";

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const say = (...a: unknown[]) => !asJson && console.log(...a);
process.env.EIGEN_QUIET = asJson ? "1" : (process.env.EIGEN_QUIET ?? "1");

const real = bunRunner();
const readOnly: GbrainRunner = (a, o) => (["query", "search", "list", "get"].includes(a[0]!) ? real(a, o) : Promise.resolve({ ok: false, stdout: "", ms: 0 }));
const p50 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const out: Record<string, unknown> = {};

// 1. raw CLI latency
const client = new GbrainClient(readOnly);
const qms: number[] = [];
for (const q of ["matt's close friends", "what is matt building", "matt school", "remember the beach trip", "matt's music taste"]) {
  const t = performance.now();
  await client.query(q, { timeoutMs: 30_000 });
  qms.push(Math.round(performance.now() - t));
}
const sms: number[] = [];
for (const q of ["Eyan", "jabby", "UCSB", "Katie", "beach", "hackathon", "Sean Byun", "music", "Nathan", "Japan"]) {
  const t = performance.now();
  await client.search(q, { timeoutMs: 5000 });
  sms.push(Math.round(performance.now() - t));
}
out.cli = { queryP50: p50(qms), query: qms, searchP50: p50(sms), search: sms };
say(`gbrain query p50 ${p50(qms)}ms ${JSON.stringify(qms)}; search p50 ${p50(sms)}ms`);

// 2. a throwaway core: home + profile + brains + memory with gbrain (read-only)
const home = mkdtempSync(join(tmpdir(), "eve-knowme-"));
const ctx = createContext(new EventBus(5000), loadConfig({ port: 0, eveHome: home, demo: false }));
const mods: Module[] = [
  homeModule({ zoKey: "" }),
  onboardingModule({ spoken: false }),
  brainsModule(),
  memoryModule({ moss: null, gbrain: { runner: readOnly, write: false, enabled: true, digestDelayMs: 0, digest: false, world: false } }),
];
for (const m of mods) await m.start(ctx);
const mem = ctx.use("memory") as MemoryServiceImpl;
const status = () => mem.gbrain!() as Record<string, any>;
const post = async (body: unknown) => {
  const url = new URL("http://x/api/memory/status");
  return (await (ctx as unknown as { routes: Map<string, (r: Request, u: URL) => Promise<Response>> }).routes.get("/api/memory/status")!(new Request(url, { method: "POST", body: JSON.stringify(body) }), url)).json();
};

// 3. world preload
let t = performance.now();
await post({ world: true });
while (status().building || (!status().world && performance.now() - t < 120_000)) await Bun.sleep(100);
const w = status().world;
const worldFile = (await Bun.file(join(home, "gbrain-world.json")).json()) as WorldCache;
out.world = { ...w, bytes: Bun.file(join(home, "gbrain-world.json")).size, kinds: worldFile.entries.reduce<Record<string, number>>((m, e) => ((m[e.kind] = (m[e.kind] ?? 0) + 1), m), {}) };
say(`world: ${w?.records} records (${JSON.stringify((out.world as any).kinds)}) from ${w?.pages} pages in ${(w?.ms / 1000).toFixed(1)}s, ${w?.names} names indexed, ${Math.round((out.world as any).bytes / 1024)}KB`);

// 4. recall latency for preloaded facts (named: local only; unnamed: may embed the query)
const people = worldFile.entries.filter((e) => e.kind === "person");
const named: number[] = [];
let entityHits = 0;
for (const e of people.slice(0, 30)) {
  const first = e.title.split(/\s+/)[0]!;
  const t0 = performance.now();
  const hits = await mem.recall(`have you heard from ${first} lately`, { emit: false });
  named.push(performance.now() - t0);
  if (hits[0]?.via === "entity" && hits[0].record.provenance?.slug === e.slug) entityHits += 1;
}
const topical: number[] = [];
for (const q of ["what hackathons have i won", "what am i building right now", "what music have i been on", "what did i do this week"]) {
  const t0 = performance.now();
  await mem.recall(q, { emit: false });
  topical.push(performance.now() - t0);
}
const r1 = (x: number) => Math.round(x * 100) / 100;
out.recall = { namedP50Ms: r1(p50(named)), namedMaxMs: r1(Math.max(...named)), entityHitRate: `${entityHits}/${Math.min(30, people.length)}`, topicalP50Ms: r1(p50(topical)), embeddings: mem.backend().embeddings };
say(`recall: named p50 ${r1(p50(named))}ms (max ${r1(Math.max(...named))}ms), exact entity hit ${entityHits}/${Math.min(30, people.length)}; topical p50 ${r1(p50(topical))}ms (${mem.backend().embeddings} query embedding)`);

// 5. prefetch simulation: names he'd mention that have no page of their own (from the world text),
// partial at t0, final ~700ms later (typical end of speech), then how long until it's local.
const STOP = /^(The|This|That|They|Matt|Matthew|Eve|Discord|Instagram|Spotify|Canvas|IG|iMessage|Claude|Codex|Current|App|No|On|In|Project|Daily)$/;
const firsts = new Set(people.map((e) => e.title.split(/\s+/)[0]!));
const fresh = [...new Set(worldFile.entries.flatMap((e) => [...e.content.matchAll(/(?<=[a-z,] )([A-Z][a-z]{2,})(?= )/g)].map((m) => m[1]!)))].filter((n) => !STOP.test(n) && !firsts.has(n));
const sim = { turns: 0, knownLocal: 0, readyAtFinal: 0, within600: 0, missed: 0, noCue: 0 };
const knownNames = people.slice(30, 40).map((e) => e.title.split(/\s+/)[0]!);
for (const name of [...knownNames, ...fresh.slice(0, 10)]) {
  sim.turns += 1;
  const partial = `wait so ${name}`;
  const final = `wait so ${name} said we should hang out this weekend`;
  ctx.bus.emit("voice.partial", { text: partial }, "sim");
  await Bun.sleep(700);
  ctx.bus.emit("voice.final", { text: final }, "sim");
  const pend = mem.pending!(final);
  if (!pend) {
    const hits = await mem.recall(final, { emit: false });
    if (hits.some((h) => h.via === "entity")) sim.knownLocal += 1;
    else sim.noCue += 1;
    continue;
  }
  const t0 = performance.now();
  const landed = await pend.settle(0);
  if (landed !== null) sim.readyAtFinal += 1;
  else if ((await pend.settle(600)) !== null && performance.now() - t0 < 650) sim.within600 += 1;
  else sim.missed += 1;
}
out.prefetch = { ...sim, lookups: status().lookups };
say(`prefetch sim (${sim.turns} turns, partial 700ms before final): known locally ${sim.knownLocal}, fetched before final ${sim.readyAtFinal}, landed within 600ms ${sim.within600}, missed ${sim.missed}, nothing to look up ${sim.noCue}`);

// 6. digest (slow: 6 hybrid queries + a brain)
if (!args.has("--no-digest")) {
  t = performance.now();
  await post({ digest: true });
  while (status().digesting || (!status().digest && performance.now() - t < 300_000)) await Bun.sleep(200);
  const d = (await Bun.file(join(home, "gbrain.json")).json().catch(() => null)) as Digest | null;
  const u = ctx.use("user").profile();
  out.digest = { status: status().digest, profileFields: Object.keys(d?.profile ?? {}), people: u.people.length, interests: u.interests, work: u.work, facts: d?.facts.length };
  say(`digest: by ${d?.by} in ${Math.round((d?.ms ?? 0) / 1000)}s, ${d?.facts.length} facts, profile fields ${Object.keys(d?.profile ?? {}).join(", ")}`);
  say(`  work: ${u.work}\n  interests: ${u.interests.join(", ")}\n  people: ${u.people.length}`);
}

for (const m of mods.reverse()) await m.stop?.();
out.home = home;
if (asJson) console.log(JSON.stringify(out, null, 2));
process.exit(0);
