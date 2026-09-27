import { describe, expect, test } from "bun:test";
import type { EventMap, EventType, MemoryRecord, Persona } from "@eigenwife/protocol";
import { DEFAULT_EVE } from "../src/brains/prompt";
import { filterHits, GbrainClient, parseHits, type GbrainRunner, type RunResult } from "../src/memory/gbrain";
import { buildDigest, digestFromSlugs, parseDigest, type Digest } from "../src/memory/gbrain-digest";
import { liveCue } from "../src/memory/gbrain-live";
import { eligible, factsOnPage, GbrainWriteback, pageSlug } from "../src/memory/gbrain-writeback";
import { memoryModule, type MemoryServiceImpl } from "../src/memory/module";
import { onboardingModule } from "../src/onboarding/module";
import { createJev } from "../src/reflex/jev";
import { reflexModule } from "../src/reflex/module";
import { emitAt, FakeBrains, FakeClock, fakeContext, FakeHome, FakeSpeech, settle, startModules } from "../src/reflex/testing";
import type { BrainService } from "../src/services";

const persona: Persona = { ...DEFAULT_EVE };

const STDOUT = `[ai.gateway] recipe "google" declares an embedding touchpoint without max_batch_tokens
[1.1984] people/eyan-koko -- # Eyan Koko

Eyan is a close friend of matt's with a goofy, weeb-coded dynamic.
[1.1529] people/conna-kwon -- # Conna Kwon

Conna is a close SoCal friend from matt's high-school days.
[0.9945] dms/dm-50308357 -- lol we went to the beach at 2am
[0.4000] days/2026-01-01 -- nothing much`;

async function waitFor(cond: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await Bun.sleep(2);
  }
}

/** Fake gbrain CLI: canned answers per subcommand, every call recorded, optionally held open. */
class FakeGbrain {
  calls: { args: string[]; stdin?: string }[] = [];
  pages = new Map<string, string>();
  hold: Promise<void> | null = null;
  constructor(public answer: (args: string[]) => string = () => STDOUT) {}
  runner: GbrainRunner = async (args, o) => {
    this.calls.push({ args, stdin: o.stdin });
    if (this.hold) await this.hold;
    const [cmd, slug] = args;
    if (cmd === "get") return { ok: this.pages.has(slug!), stdout: this.pages.get(slug!) ?? "", ms: 1 };
    if (cmd === "put") {
      this.pages.set(slug!, o.stdin ?? "");
      return { ok: true, stdout: "", ms: 1 };
    }
    return { ok: true, stdout: this.answer(args), ms: 5 } satisfies RunResult;
  };
  of(cmd: string) {
    return this.calls.filter((c) => c.args[0] === cmd);
  }
}

describe("parsing", () => {
  test("hits: warning lines skipped, headings stripped, text unwrapped", () => {
    const hits = parseHits(STDOUT);
    expect(hits.map((h) => h.slug)).toEqual(["people/eyan-koko", "people/conna-kwon", "dms/dm-50308357", "days/2026-01-01"]);
    expect(hits[0]!.text).toBe("Eyan Koko Eyan is a close friend of matt's with a goofy, weeb-coded dynamic.");
    expect(hits[0]!.score).toBeCloseTo(1.1984);
  });
  test("filter: relative to the top score, capped per collection", () => {
    const hits = parseHits(STDOUT);
    expect(filterHits(hits).map((h) => h.slug)).toEqual(["people/eyan-koko", "people/conna-kwon", "dms/dm-50308357"]);
    expect(filterHits(hits, { perPrefix: 1 }).map((h) => h.slug)).toEqual(["people/eyan-koko", "dms/dm-50308357"]);
  });
  test("digest answers are validated: private stuff and secrets dropped, importance clamped", () => {
    const d = parseDigest({
      profile: { name: "Matthew Kim", callMe: "Matt", birthday: "sometime in march", work: "building eigenwife \u2014 a desktop companion", interests: ["anime", "", 4], people: [{ name: "Katie Shuai", relation: "girlfriend" }, { relation: "x" }] },
      facts: [
        { content: "Runs jabby, a discord-native always-on agent", importance: 0.95 },
        { content: "Was diagnosed with something last year", importance: 0.9 },
        { content: "His password is hunter2", importance: 0.9 },
        "Close with Eyan Koko",
      ],
    })!;
    expect(d.profile).toEqual({ name: "Matthew Kim", callMe: "matt", work: "building eigenwife, a desktop companion", interests: ["anime"], people: [{ name: "Katie Shuai", relation: "girlfriend" }] });
    expect(d.facts).toEqual([
      { content: "Runs jabby, a discord-native always-on agent", importance: 0.8 },
      { content: "Close with Eyan Koko", importance: 0.6 },
    ]);
    expect(parseDigest({})).toBeNull();
    expect(parseDigest("nope")).toBeNull();
  });
  test("no brain: people pages still become people and facts", () => {
    const d = digestFromSlugs(parseHits(STDOUT));
    expect(d.profile.people).toEqual([
      { name: "Eyan Koko", relation: "close friend" },
      { name: "Conna Kwon", relation: "friend" },
    ]);
    expect(d.facts.length).toBe(4);
  });
});

describe("digest", () => {
  test("queries run with generous timeouts, a brain summarizes", async () => {
    const g = new FakeGbrain();
    const seen: string[] = [];
    const brains = { quickJson: async (_s: string, u: string) => (seen.push(u), { profile: { work: "cs at ucsb" }, facts: [{ content: "Close with Eyan", importance: 0.7 }] }) } as unknown as BrainService;
    const d = await buildDigest({ client: new GbrainClient(g.runner), brains, who: "matt", queryTimeoutMs: 25_000 });
    expect(g.of("query").length).toBe(6);
    expect(g.of("query")[0]!.args).toEqual(["query", "matt's closest friends and the important people in his life", "--limit", "8", "--detail", "low"]);
    expect(seen[0]).toContain("(people/eyan-koko)");
    expect(d.by).toBe("brain");
    expect(d.profile).toEqual({ work: "cs at ucsb" });
    expect(d.queries).toBe(6);
  });
  test("gbrain down: nothing, with a reason", async () => {
    const client = new GbrainClient(async () => ({ ok: false, stdout: "", ms: 1, timedOut: true }));
    const d = await buildDigest({ client, brains: null, who: "matt" });
    expect(d.by).toBe("none");
    expect(d.error).toBe("gbrain unreachable");
    expect(client.stats.timeouts).toBe(6);
  });

  test("module: digest folds into the profile (onboarding wins) and memories, cached in ~/.eve", async () => {
    const ctx = fakeContext();
    ctx.config.eveHome = "/tmp/eve-throwaway-home";
    const home = new FakeHome(new Map<string, unknown>([["user", { callMe: "matt", work: "building eigenwife", sources: { callMe: "onboarding", work: "onboarding" } }]]));
    ctx.provide("home", home);
    const brains = new FakeBrains();
    (brains as unknown as BrainService).quickJson = (async () => ({
      profile: { name: "Matthew Kim", callMe: "matthew", work: "cs student", interests: ["anime", "climbing"], people: [{ name: "Katie Shuai", relation: "girlfriend" }] },
      facts: [{ content: "Close with Eyan Koko since high school", importance: 0.7 }, { content: "Builds jabby, a discord agent", importance: 0.6 }],
    })) as BrainService["quickJson"];
    ctx.provide("brains", brains);
    const g = new FakeGbrain();
    const stop = await startModules(ctx, [onboardingModule(), memoryModule({ openaiKey: "", moss: null, gbrain: { runner: g.runner, digestDelayMs: 0 } })]);
    const mem = ctx.use("memory") as MemoryServiceImpl;
    await waitFor(() => !!home.files.get("gbrain"));
    await waitFor(() => mem.gbrainPool!().filter((r) => r.tags?.includes("digest")).length === 2);
    const u = ctx.use("user").profile();
    expect(u.callMe).toBe("matt");
    expect(u.work).toBe("building eigenwife");
    expect(u.name).toBe("Matthew Kim");
    expect(u.sources.name).toBe("gbrain");
    expect(u.interests).toEqual(["anime", "climbing"]);
    expect(u.people).toEqual([{ name: "Katie Shuai", relation: "girlfriend" }]);
    // gbrain facts are searchable but never persisted to memories.jsonl (so never mirrored to Zo or Moss).
    expect(mem.all().filter((r) => r.source === "gbrain")).toEqual([]);
    const facts = mem.gbrainPool!();
    expect(facts.every((r) => r.provenance?.system === "gbrain")).toBe(true);
    expect((await mem.recall("eyan koko high school", { emit: false }))[0]?.record.content).toBe("Close with Eyan Koko since high school");
    expect((home.files.get("gbrain") as Digest).by).toBe("brain");
    const status = mem.gbrain!() as { live: boolean; write: boolean; digest: { facts: number } };
    expect(status.live).toBe(true);
    expect(status.write).toBe(false); // throwaway home: no write-back unless asked
    expect(status.digest.facts).toBe(2);
    await stop();

    // Fresh cache: the next boot applies it without asking gbrain again.
    const ctx2 = fakeContext();
    ctx2.provide("home", home);
    const g2 = new FakeGbrain();
    const stop2 = await startModules(ctx2, [onboardingModule(), memoryModule({ openaiKey: "", moss: null, gbrain: { runner: g2.runner, digestDelayMs: 0 } })]);
    await settle(20);
    expect(g2.of("query").length).toBe(0);
    await stop2();
  });
});

describe("live lookups", () => {
  test("cues: remember-when, known people, relations, places, projects, names mid-sentence", () => {
    expect(liveCue("remember when we went to the beach at 2am?")).toEqual({ kind: "remember", query: "went beach 2am" });
    expect(liveCue("i'm getting food with eyan later", ["Eyan Koko"])).toEqual({ kind: "person", query: "Eyan Koko" });
    expect(liveCue("my roommate jake is being weird")).toEqual({ kind: "person", query: "jake" });
    expect(liveCue("we should go to Tsujita again")).toEqual({ kind: "place", query: "Tsujita" });
    expect(liveCue("the hackathon called treehacks was wild")).toEqual({ kind: "project", query: "treehacks" });
    expect(liveCue("honestly Sean would love this")).toEqual({ kind: "name", query: "Sean" });
    // Sentence-initial capitals are STT noise; small talk is nothing.
    expect(liveCue("Went out for a bit")).toBeNull();
    expect(liveCue("lol")).toBeNull();
    expect(liveCue("what do you think about this")).toBeNull();
    expect(liveCue("Okay. Spotify is open")).toBeNull();
  });

  test("never blocks the reply: the persona call happens before gbrain answers; results serve the NEXT turn", async () => {
    const clock = new FakeClock(Date.now());
    const ctx = fakeContext();
    ctx.config.demo = false;
    ctx.provide("home", new FakeHome());
    const speech = new FakeSpeech(ctx, clock);
    const brains = new FakeBrains((r) => `(${r.behavior}) sure`);
    ctx.provide("speech", speech);
    ctx.provide("brains", brains);
    const g = new FakeGbrain();
    let release!: () => void;
    g.hold = new Promise<void>((r) => (release = r));
    let gbrainDone = false;
    const run = g.runner;
    g.runner = async (a, o) => {
      const r = await run(a, o);
      gbrainDone = true;
      return r;
    };
    const stop = await startModules(ctx, [
      memoryModule({ openaiKey: "", moss: null, gbrain: { runner: g.runner, digest: false, liveSlotMs: 60_000 } }),
      reflexModule({ now: clock.now, jev: createJev({}) }),
    ]);
    const emit = <K extends EventType>(type: K, data: EventMap[K]) => emitAt(ctx, clock, type, data);
    emit("companion.born", { persona });
    await waitFor(() => speech.said.length === 1);
    brains.requests.length = 0;

    emit("voice.final", { text: "eve, remember when eyan and i went to the beach at 2am?" });
    await waitFor(() => brains.requests.length === 1);
    // She's already answering; gbrain is still out.
    expect(g.of("search").length).toBe(1);
    expect(g.of("search")[0]!.args).toEqual(["search", "eyan went beach 2am", "--limit", "6"]);
    expect(gbrainDone).toBe(false);
    expect(brains.requests[0]!.extra ?? "").not.toContain("people/eyan-koko");
    await waitFor(() => speech.said.length === 2);

    release();
    const mem = ctx.use("memory") as MemoryServiceImpl;
    await waitFor(() => mem.shortTerm().some((r) => r.source === "gbrain"));
    expect(mem.shortTerm().filter((r) => r.source === "gbrain").length).toBe(3);
    expect(mem.all().some((r) => r.source === "gbrain")).toBe(false); // short-term only, never on disk
    expect(ctx.contextBlock()).toContain('gbrain.recall: his notes on "eyan went beach 2am": Eyan Koko Eyan is a close friend');

    // Next turn: the recalled note is in her prompt through ordinary local recall.
    emit("voice.final", { text: "what was eyan like that night at the beach" });
    await waitFor(() => brains.requests.length === 2);
    expect(brains.requests[1]!.extra).toContain("people/eyan-koko");
    // No cue in the follow-up, and the same cue within the cooldown doesn't hit gbrain again.
    emit("voice.final", { text: "remember when eyan and i went to the beach at 2am" });
    await settle(10);
    expect(g.of("search").length).toBe(1);
    await stop();
  });
});

describe("write-back", () => {
  const rec = (over: Partial<MemoryRecord> = {}): MemoryRecord => ({ id: `m${Math.random()}`, kind: "fact", content: "Prefers concise answers", importance: 0.8, confidence: 0.9, source: "observation", createdAt: 0, ...over });

  test("only important, non-sensitive, non-screen, non-gbrain long-term facts", () => {
    expect(eligible(rec(), "STORE_LONG_TERM")).toBe(true);
    expect(eligible(rec(), "UPDATE_PREFERENCE")).toBe(true);
    expect(eligible(rec(), "STORE_SHORT_TERM")).toBe(false);
    expect(eligible(rec({ importance: 0.6 }), "STORE_LONG_TERM")).toBe(false);
    expect(eligible(rec({ content: "his card number is 4111111111111111" }), "STORE_LONG_TERM")).toBe(false);
    expect(eligible(rec({ content: "Started therapy last month" }), "STORE_LONG_TERM")).toBe(false);
    expect(eligible(rec({ tags: ["boundary", "private"] }), "STORE_LONG_TERM")).toBe(false);
    expect(eligible(rec({ source: "screen:vision" }), "STORE_LONG_TERM")).toBe(false);
    expect(eligible(rec({ source: "gbrain" }), "STORE_LONG_TERM")).toBe(false);
    expect(eligible(rec({ source: "seed" }), "STORE_LONG_TERM")).toBe(false);
    expect(eligible(rec({ source: "onboarding" }), "STORE_LONG_TERM")).toBe(true);
  });

  test("batched and debounced into one page write, deduped against the page", async () => {
    const g = new FakeGbrain();
    const t = Date.UTC(2026, 8, 26, 20, 5);
    const slug = pageSlug(t, 0);
    expect(slug).toBe("eigenwife/learned/2026-09-26");
    g.pages.set(slug, "# eigenwife learned 2026-09-26\n\n- [19:00] (eigenwife) matt: Likes spicy food\n");
    const wb = new GbrainWriteback({ client: new GbrainClient(g.runner), debounceMs: 20, now: () => t, tzOffsetMin: 0, who: () => "matt" });
    expect(wb.offer(rec({ content: "Likes spicy food" }), "STORE_LONG_TERM")).toBe(true);
    expect(wb.offer(rec({ content: "Is training for a half marathon" }), "STORE_LONG_TERM")).toBe(true);
    expect(wb.offer(rec({ content: "Hates long explanations" }), "UPDATE_PREFERENCE")).toBe(true);
    expect(wb.offer(rec({ content: "Hates long explanations", importance: 0.2 }), "STORE_LONG_TERM")).toBe(false);
    expect(wb.pending()).toBe(3);
    expect(g.of("put").length).toBe(0);
    await waitFor(() => g.of("put").length === 1);
    const page = g.pages.get(slug)!;
    expect(page).toContain("- [20:05] (eigenwife) matt: Is training for a half marathon");
    expect(page).toContain("- [20:05] (eigenwife) matt: Hates long explanations");
    expect(page.match(/Likes spicy food/g)!.length).toBe(1);
    expect(factsOnPage(page)).toEqual(["likes spicy food", "is training for a half marathon", "hates long explanations"]);
    expect(wb.written).toBe(2);
    expect(wb.pending()).toBe(0);
  });

  test("module: memory writes flow to gbrain only when write-back is on", async () => {
    for (const write of [true, false]) {
      const ctx = fakeContext();
      ctx.provide("home", new FakeHome());
      const g = new FakeGbrain();
      const stop = await startModules(ctx, [memoryModule({ openaiKey: "", moss: null, gbrain: { runner: g.runner, digest: false, write, writeDebounceMs: 10_000 } })]);
      const mem = ctx.use("memory");
      await mem.write({ kind: "fact", content: "Is building eigenwife with a friend", importance: 0.85, source: "observation" }, "STORE_LONG_TERM");
      await mem.write({ kind: "fact", content: "Password is hunter2 for the wifi", importance: 0.9, source: "observation" }, "STORE_LONG_TERM");
      await mem.write({ kind: "fact", content: "Looking at a red jacket on the screen", importance: 0.9, source: "screen" }, "STORE_LONG_TERM");
      expect(g.of("put").length).toBe(0); // debounced
      await stop(); // flushes
      const puts = g.of("put");
      if (!write) {
        expect(puts.length).toBe(0);
        continue;
      }
      expect(puts.length).toBe(1);
      expect(puts[0]!.stdin).toContain("(eigenwife) matt: Is building eigenwife with a friend");
      expect(puts[0]!.stdin).not.toContain("hunter2");
      expect(puts[0]!.stdin).not.toContain("jacket");
    }
  });
});
