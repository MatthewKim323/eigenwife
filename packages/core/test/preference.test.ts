import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TRAIT_KEYS, type Candidate, type CandidateRegion, type Persona, type RegionStats, type TraitKey } from "@eigenwife/protocol";
import type { Module } from "../src/context";
import { startCore, type RunningCore } from "../src/index";
import { homeModule } from "../src/home/module";
import { parseJevAnswer } from "../src/preference/jev";
import {
  deltas,
  direction,
  estimate,
  focus,
  initialConvergence,
  interestFromScore,
  localReward,
  normalizeRegions,
  population,
  stepConvergence,
  type LeaveObservation,
  type Observation,
} from "../src/preference/math";
import { preferenceModule, type PreferenceServiceImpl } from "../src/preference/module";
import { dials, paletteHue, synthesizePersona } from "../src/preference/persona";
import type { BrainService } from "../src/services";

process.env.EIGEN_QUIET = "1";

// --- fixtures: 12 deterministic synthetic candidates ------------------------------

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function makeCandidates(n = 12, seed = 7): Candidate[] {
  const rand = rng(seed);
  const out: Candidate[] = [];
  for (let i = 0; i < n; i++) {
    const traits = Object.fromEntries(TRAIT_KEYS.map((t) => [t, Math.round(rand() * 100) / 100])) as Record<TraitKey, number>;
    const top = [...TRAIT_KEYS].sort((a, b) => traits[b] - traits[a]);
    const region = (id: string, kind: CandidateRegion["kind"], keys: TraitKey[]): CandidateRegion => ({
      id,
      kind,
      emphasis: Object.fromEntries(keys.map((k) => [k, Math.max(0.3, traits[k])])),
    });
    out.push({
      id: `c${i}`,
      name: `Cand ${i}`,
      age: 25,
      tagline: "",
      job: "",
      location: "",
      photos: [],
      prompts: [],
      traits,
      regions: [
        region("photo1", "profile-photo", ["style", "sporty", top[0]!]),
        region("photo2", "profile-photo", ["polished", "outdoors"]),
        region("prompt1", "profile-prompt", ["sarcasm"]),
        region("prompt2", "profile-prompt", ["humor"]),
        region("prompt3", "profile-prompt", ["warmth", "nerdiness"]),
        region("meta", "profile-meta", ["career_focus", "nightlife"]),
      ],
    });
  }
  return out;
}

const CANDS = makeCandidates();

const stat = (dwellMs: number, revisits = 0): RegionStats => ({ dwellMs, visits: dwellMs > 0 ? 1 + revisits : 0, revisits, longestMs: dwellMs * 0.7 });

/** A user whose eyes follow one trait: long reads of the region that expresses it, scaled by how strong it is. */
function attention(c: Candidate, trait: TraitKey, regionId: string): LeaveObservation {
  const x = c.traits[trait];
  const regions: Record<string, RegionStats> = {};
  for (const r of c.regions) regions[`cand_${c.id}_${r.id}`] = stat(r.id === regionId ? 300 + 5200 * x * x : 350, r.id === regionId && x > 0.6 ? 2 : 0);
  const total = Object.values(regions).reduce((s, r) => s + r.dwellMs, 0);
  return { candidateId: c.id, regions, totalMs: total + 300, skipLatencyMs: x > 0.5 ? total + 300 : Math.min(total, 1400) };
}

// --- math ---------------------------------------------------------------------------

test("reward model: snap skip < glance < long revisited read", () => {
  const c = CANDS[0]!;
  const skip = localReward(c, { candidateId: c.id, regions: { photo1: stat(400) }, totalMs: 700, skipLatencyMs: 700 });
  const glance = localReward(c, { candidateId: c.id, regions: { photo1: stat(900), prompt1: stat(800) }, totalMs: 2500, skipLatencyMs: 2500 });
  const stare = localReward(c, { candidateId: c.id, regions: { prompt1: stat(4500, 2), photo1: stat(1500, 1) }, totalMs: 7000, skipLatencyMs: 7000 });
  expect(skip.reward).toBeLessThan(glance.reward);
  expect(glance.reward).toBeLessThan(stare.reward);
  expect(skip.interest.skip).toBeGreaterThan(0.5);
  expect(stare.interest.positive).toBeGreaterThan(0.4);
  expect(stare.strength).toBeGreaterThan(glance.strength);
  for (const r of [skip, glance, stare]) {
    const sum = r.interest.skip + r.interest.neutral + r.interest.inspect + r.interest.positive;
    expect(sum).toBeCloseTo(1, 2);
    expect(r.by).toBe("local");
  }
  const d = interestFromScore(0.33);
  expect(d.neutral).toBeGreaterThan(d.skip);
});

test("regions: prefixed and bare keys agree; focus follows the stared-at region and kappa", () => {
  const c = CANDS[1]!;
  expect(normalizeRegions(c.id, { [`cand_${c.id}_prompt1`]: stat(100), prompt1: stat(50) }).prompt1!.dwellMs).toBe(150);
  const f = focus(c, { candidateId: c.id, regions: { prompt1: stat(5000), photo1: stat(200) }, totalMs: 5200, skipLatencyMs: 5200 });
  expect(f.sarcasm).toBeGreaterThan(0.2);
  expect(f.sarcasm).toBeGreaterThan(f.humor!);
  expect(f.humor).toBe(0);
  expect(Math.max(...Object.values(f))).toBeLessThanOrEqual(1);
});

test("estimator: uniform rewards and no focus give the population mean; weights pull toward rewarded traits", () => {
  const pop = population(CANDS);
  const flat: Observation[] = CANDS.map((c) => ({ candidateId: c.id, traits: c.traits, reward: 0.5, focus: {} }));
  const P = estimate(flat);
  for (const t of TRAIT_KEYS) expect(P[t]).toBeCloseTo(pop.mean[t]!, 6);
  expect(Object.values(deltas(P, pop)).every((d) => Math.abs(d) < 1e-6)).toBe(true);
  const hot: Observation[] = CANDS.map((c) => ({ candidateId: c.id, traits: c.traits, reward: c.traits.outdoors, focus: {} }));
  expect(estimate(hot).outdoors).toBeGreaterThan(pop.mean.outdoors!);
});

test("region-aware evidence: same rewards, staring at the sarcasm prompt vs the humor prompt moves those traits specifically", () => {
  const withFocus = (regionId: string): Observation[] =>
    CANDS.map((c) => ({
      candidateId: c.id,
      traits: c.traits,
      reward: 0.5,
      focus: focus(c, { candidateId: c.id, regions: { [regionId]: stat(5000) }, totalMs: 5000, skipLatencyMs: 5000 }),
    }));
  // Focus alone (equal rewards) is emphasis-weighted: prompts emphasize their trait more on candidates strong in it.
  const s = estimate(withFocus("prompt1"));
  const h = estimate(withFocus("prompt2"));
  expect(s.sarcasm!).toBeGreaterThan(h.sarcasm!);
  expect(h.humor!).toBeGreaterThan(s.humor!);
});

test("convergence: progress rises monotonic-ish with a consistent user and stays in 0..1", () => {
  const pop = population(CANDS);
  let st = initialConvergence();
  const obs: Observation[] = [];
  const seq: number[] = [];
  for (const c of CANDS) {
    const o = attention(c, "sarcasm", "prompt1");
    obs.push({ candidateId: c.id, traits: c.traits, reward: localReward(c, o).reward, focus: focus(c, o) });
    st = stepConvergence(st, direction(estimate(obs), pop));
    seq.push(st.progress);
  }
  expect(seq[0]).toBe(0);
  expect(seq.at(-1)!).toBeGreaterThan(0.75);
  for (let i = 1; i < seq.length; i++) expect(seq[i]!).toBeGreaterThanOrEqual(seq[i - 1]! - 0.05);
  expect(seq.every((p) => p >= 0 && p <= 1)).toBe(true);
});

// --- persona ---------------------------------------------------------------------------

test("persona: dials follow the vector, template fallback, brain text when it answers", async () => {
  const P = Object.fromEntries(TRAIT_KEYS.map((t) => [t, 0.4])) as Record<string, number>;
  P.sarcasm = 0.9;
  P.humor = 0.85;
  const d = Object.fromEntries(TRAIT_KEYS.map((t) => [t, 0])) as Record<string, number>;
  d.sarcasm = 0.9;
  d.humor = 0.7;
  const k = dials(P, d);
  expect(k.sarcasm).toBeGreaterThan(0.8);
  expect(k.verbosity).toBeLessThan(0.4);
  expect(paletteHue(d)).toBeGreaterThan(0);
  expect(paletteHue({})).toBe(320);

  const t = await synthesizePersona(P, d, 12, null);
  expect(t.by).toBe("template");
  expect(t.persona.name).toBe("Eve");
  expect(t.persona.personality).toContain("sarcasm 9");
  expect(t.persona.tagline).toContain("sarcastic");
  expect(t.persona.voice.style).toContain("dry");
  expect(JSON.stringify(t.persona)).not.toMatch(/[–—]/);

  const brain = { quickJson: async () => ({ tagline: "hi", description: "She is sharp.", personality: "Dry — very dry.", scenario: "Out of the app." }) } as unknown as BrainService;
  const b = await synthesizePersona(P, d, 12, brain);
  expect(b.by).toBe("brain");
  expect(b.persona.description).toBe("She is sharp.");
  expect(b.persona.personality).not.toContain("—");
  const junk = { quickJson: async () => null } as unknown as BrainService;
  expect((await synthesizePersona(P, d, 12, junk)).by).toBe("template");
});

test("jev answers parse into a normalized distribution", () => {
  const r = parseJevAnswer({ answers: { interest: { probabilities: { skip: 0, neutral: 1, inspect: 1, positive: 2 } }, signal: { score: 2.4 } } });
  expect(r.interest.positive).toBe(0.5);
  expect(r.strength).toBeCloseTo(0.8);
  expect(() => parseJevAnswer({})).toThrow();
});

// --- module ---------------------------------------------------------------------------

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "eve-pref-"));
  dirs.push(d);
  return d;
};
let cores: RunningCore[] = [];
let port = 17950;
afterEach(async () => {
  for (const c of cores) await c.stop();
  cores = [];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(home: string, extra: Module[] = [], opts: Parameters<typeof preferenceModule>[0] = {}) {
  const core = await startCore([homeModule({ zoKey: "" }), ...extra, preferenceModule({ candidates: CANDS, jevKey: "", ...opts })], {
    port: ++port,
    eveHome: home,
    demo: false,
  });
  cores.push(core);
  return core;
}

function record(core: RunningCore) {
  const ev: Record<string, any[]> = {};
  core.ctx.bus.on("*", (e) => (ev[e.type] ??= []).push(e.data));
  return ev;
}

async function runDeck(core: RunningCore, trait: TraitKey, regionId: string, n = CANDS.length) {
  for (const [i, c] of CANDS.slice(0, n).entries()) {
    core.ctx.bus.emit("dating.view", { candidateId: c.id, index: i, total: CANDS.length }, "shell");
    core.ctx.bus.emit("dating.leave", attention(c, trait, regionId), "shell");
  }
  await (core.ctx.use("preference") as PreferenceServiceImpl).idle();
}

test("act I end to end: a user who stares at sarcastic prompts compiles a sarcastic Eve", async () => {
  const home = tmp();
  const core = await boot(home);
  const ev = record(core);
  await runDeck(core, "sarcasm", "prompt1");
  const pref = core.ctx.use("preference") as PreferenceServiceImpl;

  expect(ev["dating.signal"]!.length).toBe(12);
  expect(ev["dating.signal"]!.every((s) => s.by === "local")).toBe(true);
  const updates = ev["preference.update"]!;
  expect(updates.length).toBeGreaterThanOrEqual(12);
  expect(updates.at(-1).progress).toBe(1);
  expect(updates.at(-1).observations).toBe(12);

  // Direction: sarcasm is the most preferred trait and clearly above the population.
  const d = pref.deltas();
  const ranked = [...TRAIT_KEYS].sort((a, b) => d[b]! - d[a]!);
  expect(ranked[0]).toBe("sarcasm");
  expect(d.sarcasm!).toBeGreaterThan(0.4);

  expect(ev["preference.converged"]!.length).toBe(1);
  const persona: Persona = ev["preference.converged"]![0].persona;
  expect(persona.name).toBe("Eve");
  expect(persona.dials.sarcasm).toBeGreaterThan(0.6);
  expect(pref.persona()).toEqual(persona);
  expect(core.ctx.world().preference.progress).toBe(1);

  // Nothing is born until the shell reaches emergence, then exactly once.
  expect(ev["companion.born"]).toBeUndefined();
  core.ctx.bus.emit("shell.scene", { scene: "emergence" }, "shell");
  core.ctx.bus.emit("shell.scene", { scene: "emergence" }, "shell");
  expect(ev["companion.born"]!.length).toBe(1);
  expect(core.ctx.world().companion.born).toBe(true);

  await Bun.sleep(20);
  const profile = JSON.parse(readFileSync(join(home, "profile.json"), "utf8"));
  expect(profile.persona.name).toBe("Eve");
  expect(profile.bornAt).toBeGreaterThan(0);
  const prefs = JSON.parse(readFileSync(join(home, "preferences.json"), "utf8"));
  expect(prefs.converged).toBe(true);
  expect(prefs.history.length).toBe(12);
});

test("a user who stares at outdoorsy photos compiles the opposite direction", async () => {
  const core = await boot(tmp());
  await runDeck(core, "outdoors", "photo2");
  const d = (core.ctx.use("preference") as PreferenceServiceImpl).deltas();
  expect(d.outdoors!).toBeGreaterThan(0.3);
  expect(d.outdoors!).toBeGreaterThan(d.sarcasm!);
});

test("emergence before convergence is remembered; unknown candidates are ignored", async () => {
  const core = await boot(tmp());
  const ev = record(core);
  core.ctx.bus.emit("dating.leave", { candidateId: "nobody", regions: {}, totalMs: 1, skipLatencyMs: 1 }, "shell");
  core.ctx.bus.emit("shell.scene", { scene: "emergence" }, "shell");
  await runDeck(core, "humor", "prompt2");
  expect(ev["dating.signal"]!.length).toBe(12);
  expect(ev["companion.born"]!.length).toBe(1);
});

test("restart: a born Eve is restored silently (restored flag, world knows), reset reruns act I", async () => {
  const home = tmp();
  let core = await boot(home);
  await runDeck(core, "sarcasm", "prompt1");
  core.ctx.bus.emit("shell.scene", { scene: "emergence" }, "shell");
  const persona = (core.ctx.use("preference") as PreferenceServiceImpl).persona();
  await Bun.sleep(20);
  await core.stop();
  cores = [];

  core = await boot(home);
  const pref = core.ctx.use("preference") as PreferenceServiceImpl;
  expect(pref.persona()).toEqual(persona);
  expect(pref.born()).toBe(true);
  expect(core.ctx.world().companion.born).toBe(true);
  const restored = core.ctx.bus.recent("companion.born");
  expect(restored.length).toBe(1);
  expect((restored[0]!.data as { restored?: boolean }).restored).toBe(true);
  const ev = record(core);
  core.ctx.bus.emit("shell.scene", { scene: "emergence" }, "shell");
  expect(ev["companion.born"]).toBeUndefined();

  const base = `http://127.0.0.1:${core.port}`;
  const state = await (await fetch(`${base}/api/preference`)).json();
  expect(state.born).toBe(true);
  expect(state.persona.name).toBe("Eve");

  expect((await fetch(`${base}/api/preference/reset`, { method: "POST" })).status).toBe(200);
  expect(pref.persona()).toBeNull();
  expect(pref.progress()).toBe(0);
  expect(JSON.parse(readFileSync(join(home, "profile.json"), "utf8")).persona).toBeNull();
  expect(JSON.parse(readFileSync(join(home, "profile.prev.json"), "utf8")).persona.name).toBe("Eve");
  await runDeck(core, "warmth", "prompt3");
  core.ctx.bus.emit("shell.scene", { scene: "emergence" }, "shell");
  expect(ev["companion.born"]!.length).toBe(1);
});

test("operator can force convergence early; after birth only clear positives adapt the vector", async () => {
  const core = await boot(tmp());
  await runDeck(core, "sarcasm", "prompt1", 5);
  const pref = core.ctx.use("preference") as PreferenceServiceImpl;
  expect(pref.converged()).toBe(false);
  const res = await (await fetch(`http://127.0.0.1:${core.port}/api/preference/converge`, { method: "POST" })).json();
  expect(res.ok).toBe(true);
  expect(pref.converged()).toBe(true);
  const before = pref.vector();
  const c = CANDS.find((x) => x.traits.outdoors > 0.7)!;
  core.ctx.bus.emit("dating.leave", { candidateId: c.id, regions: { photo1: stat(300) }, totalMs: 500, skipLatencyMs: 500 }, "shell");
  await pref.idle();
  expect(pref.vector()).toEqual(before);
  core.ctx.bus.emit("dating.leave", { candidateId: c.id, regions: { photo2: stat(6000, 3), prompt3: stat(3000, 2) }, totalMs: 9000, skipLatencyMs: 9000 }, "shell");
  await pref.idle();
  expect(pref.vector().outdoors!).toBeGreaterThan(before.outdoors!);
});

test("jev path: typed choice + score is used, and a slow or broken jev falls back to local", async () => {
  const calls: any[] = [];
  const good = async (_u: string, init?: RequestInit) => {
    calls.push(JSON.parse(String(init!.body)));
    return Response.json({ model: "jev-1.13.0", answers: { interest: { probabilities: { skip: 0.02, neutral: 0.11, inspect: 0.29, positive: 0.58 } }, signal: { score: 2.3 } } });
  };
  const core = await boot(tmp(), [], { jevKey: "k", fetch: good });
  const ev = record(core);
  core.ctx.bus.emit("dating.leave", attention(CANDS[0]!, "sarcasm", "prompt1"), "shell");
  await (core.ctx.use("preference") as PreferenceServiceImpl).idle();
  expect(ev["dating.signal"]![0].by).toBe("jev:jev-1.13.0");
  expect(ev["dating.signal"]![0].interest.positive).toBe(0.58);
  expect(calls[0].questions.interest.type).toBe("choice");
  expect(calls[0].questions.signal.type).toBe("score");
  expect(calls[0].state.regions.length).toBeGreaterThan(0);

  const slow = async (_u: string, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  const core2 = await boot(tmp(), [], { jevKey: "k", fetch: slow, jevTimeoutMs: 30 });
  const ev2 = record(core2);
  core2.ctx.bus.emit("dating.leave", attention(CANDS[0]!, "sarcasm", "prompt1"), "shell");
  await (core2.ctx.use("preference") as PreferenceServiceImpl).idle();
  expect(ev2["dating.signal"]![0].by).toBe("local");
});

test("real act I deck: each single-trait gazer recovers their trait as the top delta", async () => {
  const { CANDIDATES } = await import("@eigenwife/protocol");
  if (CANDIDATES.length < 6) return;
  const pop = population(CANDIDATES);
  for (const trait of ["sarcasm", "outdoors", "warmth", "nerdiness"] as TraitKey[]) {
    const obs: Observation[] = CANDIDATES.map((c) => {
      const x = c.traits[trait];
      const best = [...c.regions].sort((a, b) => (b.emphasis[trait] ?? 0) - (a.emphasis[trait] ?? 0))[0]!;
      const regions: Record<string, RegionStats> = {};
      for (const r of c.regions) regions[r.id] = stat(r.id === best.id ? 300 + 5000 * x * x : 350, r.id === best.id && x > 0.6 ? 2 : 0);
      const o = { candidateId: c.id, regions, totalMs: 6000, skipLatencyMs: x > 0.5 ? 6000 : 1300 };
      return { candidateId: c.id, traits: c.traits, reward: localReward(c, o).reward, focus: focus(c, o) };
    });
    const d = deltas(estimate(obs), pop);
    const top = [...TRAIT_KEYS].sort((a, b) => d[b]! - d[a]!)[0];
    expect(top).toBe(trait);
  }
});
