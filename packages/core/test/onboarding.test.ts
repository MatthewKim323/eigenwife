import { describe, expect, test } from "bun:test";
import type { EventMap, EventType, MemoryRecord, MemoryWritePolicy, Persona } from "@eigenwife/protocol";
import { DEFAULT_EVE, buildPersonaPrompt, renamePersona, userBlock } from "../src/brains/prompt";
import type { ChatBackend, ChatMessage } from "../src/brains/chat";
import { brainsModule } from "../src/brains/module";
import { birthdayFrom, extractAnswer, herNameFrom, nameFrom, parseBrainAnswer, PAUSE, REDO, SKIP } from "../src/onboarding/extract";
import { onboardingModule, STEPS } from "../src/onboarding/module";
import { emptyProfile, mergeProfile, normalizeProfile } from "../src/onboarding/profile";
import { addressed, createJev } from "../src/reflex/jev";
import { readIntent } from "../src/reflex/intent";
import { reflexModule, WAKE_LINE } from "../src/reflex/module";
import { emitAt, FakeBrains, FakeClock, fakeContext, FakeHome, FakeMemory, FakeSpeech, settle, startModules } from "../src/reflex/testing";
import { ONBOARDING_LINES } from "../src/speech/lines";
import type { BrainService, MemoryService, UserProfile } from "../src/services";

const persona: Persona = { ...DEFAULT_EVE };
const Q = ONBOARDING_LINES.questions;

class RecMemory extends FakeMemory {
  writes: { rec: Partial<MemoryRecord>; policy?: MemoryWritePolicy }[] = [];
  constructor(ctx: ConstructorParameters<typeof FakeMemory>[0]) {
    super(ctx, []);
    (this as { write: MemoryService["write"] }).write = async (rec, policy) => {
      this.writes.push({ rec, policy });
      return null;
    };
  }
}

async function waitFor(cond: () => boolean, ms = 1500) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await Bun.sleep(2);
  }
}

async function rig(o: { home?: FakeHome; json?: (sys: string, user: string) => unknown; silenceMs?: number; giveUpMs?: number; reflex?: boolean; spoken?: boolean } = {}) {
  const clock = new FakeClock(Date.now());
  const ctx = fakeContext();
  ctx.config.demo = false;
  const home = o.home ?? new FakeHome();
  const speech = new FakeSpeech(ctx, clock);
  const brains = new FakeBrains((r) => `(${r.behavior}) sure`);
  const jsonCalls: string[] = [];
  (brains as unknown as BrainService).quickJson = (async (sys: string, user: string) => {
    jsonCalls.push(user);
    return o.json ? o.json(sys, user) : null;
  }) as BrainService["quickJson"];
  const memory = new RecMemory(ctx);
  ctx.provide("home", home);
  ctx.provide("speech", speech);
  ctx.provide("brains", brains);
  ctx.provide("memory", memory);
  const states: EventMap["onboarding.state"][] = [];
  const renames: string[] = [];
  const decisions: string[] = [];
  ctx.bus.on("onboarding.state", (e) => void states.push(e.data));
  ctx.bus.on("companion.rename", (e) => void renames.push(e.data.name));
  ctx.bus.on("reflex.decision", (e) => void decisions.push(`${e.data.decision}:${e.data.reason ?? ""}`));
  const mods = [onboardingModule({ spoken: o.spoken ?? true, startDelayMs: 0, silenceMs: o.silenceMs ?? 60_000, giveUpMs: o.giveUpMs ?? 60_000, extractTimeoutMs: 200 })];
  if (o.reflex !== false) mods.push(reflexModule({ now: clock.now, jev: createJev({}) }));
  const stop = await startModules(ctx, mods);
  const emit = <K extends EventType>(type: K, data: EventMap[K]) => emitAt(ctx, clock, type, data);
  const said = () => speech.said.map((s) => s.text);
  const last = () => said().at(-1) ?? "";
  /** Say something and wait until she's said n more lines. */
  const answer = async (text: string, lines = 2) => {
    const n = speech.said.length;
    emit("voice.final", { text });
    await waitFor(() => speech.said.length >= n + lines).catch((e) => {
      throw new Error(`${e.message} after "${text}": ${JSON.stringify(speech.said.map((s) => s.text))}`);
    });
    await settle(5);
  };
  return { ctx, clock, home, speech, brains, memory, states, renames, decisions, jsonCalls, stop, emit, said, last, answer };
}

describe("onboarding flow", () => {
  test("born with no name: asks, extracts, skips, confirms, stores, finishes", async () => {
    const r = await rig({ json: (_s, u) => (u.includes("what do you do") ? { skip: false, work: "building eigenwife, an ai desktop companion" } : null) });
    r.emit("companion.born", { persona, woken: true });
    await waitFor(() => r.said().includes(Q.name));
    // Onboarding took her first words: the reflex didn't greet through persona.
    expect(r.brains.requests.length).toBe(0);
    expect(r.said()[0]).toBe(ONBOARDING_LINES.intro);
    expect(r.ctx.use("onboarding").active()).toBe(true);

    await r.answer("call me matt");
    expect(r.said()).toContain("[mood:happy 0.5] matt. got it.");
    expect(r.last()).toBe(Q.herName);

    await r.answer("nova");
    expect(r.renames).toEqual(["Nova"]);
    expect(r.ctx.world().companion.persona?.name).toBe("Nova");
    expect(r.said()).toContain("[mood:happy 0.6] nova. i like it.");

    await r.answer("mostly i'm building eigenwife these days, it's like an ai that lives on my desktop");
    expect(r.jsonCalls.some((u) => u.includes("eigenwife"))).toBe(true);
    expect(r.said().some((s) => s.includes("building eigenwife, an ai desktop companion. noted."))).toBe(true);

    await r.answer("skip");
    expect(ONBOARDING_LINES.skip as readonly string[]).toContain(r.said().at(-2)!);

    await r.answer("march 14th");
    expect(r.said()).toContain("[mood:smug 0.5] march 14. i won't forget.");

    await r.answer("don't bring up my ex");
    expect(r.said()).toContain("[mood:neutral 0.5] got it. i won't go there.");
    expect(r.last()).toBe(ONBOARDING_LINES.outro);

    const u = r.ctx.use("user").profile();
    expect(u.callMe).toBe("matt");
    expect(u.herName).toBe("Nova");
    expect(u.work).toContain("eigenwife");
    expect(u.interests).toEqual([]);
    expect(u.birthday).toBe("03-14");
    expect(u.boundaries).toEqual(["bring up my ex"]);
    expect(u.sources.callMe).toBe("onboarding");
    const onDisk = await r.home.read<UserProfile | null>("user", null);
    expect(onDisk?.callMe).toBe("matt");
    expect((await r.home.read<{ status: string }>("onboarding", { status: "?" })).status).toBe("done");

    // High-importance memories, the boundary tagged private.
    expect(r.memory.writes.length).toBe(5);
    expect(r.memory.writes.every((w) => w.rec.importance === 0.9 && w.policy === "STORE_LONG_TERM" && w.rec.source === "onboarding")).toBe(true);
    expect(r.memory.writes.find((w) => w.rec.content!.includes("ex"))!.rec.tags).toContain("private");

    expect(r.states.at(-1)).toMatchObject({ status: "done", step: null, answered: 5, total: STEPS.length });
    expect(r.states.some((s) => s.status === "active" && s.step === "birthday" && s.index === 4)).toBe(true);
    expect(r.ctx.use("onboarding").active()).toBe(false);
    expect(r.ctx.use("onboarding").pending()).toBe(false);
    // Every answer went to onboarding, none to the normal reply path.
    expect(r.brains.requests.length).toBe(0);
    expect(r.decisions.filter((d) => !d.includes("first words")).every((d) => d.includes("onboarding answer"))).toBe(true);
    await r.stop();
  });

  test("addressing override: mumbles are answers during onboarding, ambient reactions wait", async () => {
    const r = await rig();
    r.emit("companion.born", { persona, woken: true });
    await waitFor(() => r.said().includes(Q.name));
    // Not addressed by the normal gate (no name, no question, not mid-conversation after 2 min).
    r.clock.advance(120_000);
    const it = readIntent("uh matthew i guess");
    const base = { trigger: { id: "u", rule: "utterance", description: "", urgency: "immediate" as const, data: {}, at: 0, ambient: false }, world: r.ctx.world(), relationship: r.ctx.world().companion.relationship, now: r.clock.now() };
    expect(addressed(base, "uh matthew i guess", it).yes).toBe(false);
    expect(addressed({ ...base, onboarding: true }, "uh matthew i guess", it)).toEqual({ yes: true, why: "answering her onboarding question" });

    r.emit("app.opened", { app: "Spotify" });
    r.emit("media.play", { track: "x" });
    await r.answer("uh matthew i guess");
    expect(r.said()).toContain("[mood:happy 0.5] matthew. got it.");
    expect(r.brains.requests.length).toBe(0);
    expect(r.decisions.filter((d) => !d.includes("onboarding answer") && !d.includes("first words"))).toEqual([]);
    await r.stop();
  });

  test("silence: one nudge, then she lets it go (paused, resumable)", async () => {
    const r = await rig({ silenceMs: 30, giveUpMs: 30 });
    r.emit("companion.born", { persona, woken: true });
    await waitFor(() => r.said().includes(ONBOARDING_LINES.pause), 2000);
    expect(r.said().some((s) => s.startsWith(ONBOARDING_LINES.nudge))).toBe(true);
    expect(r.states.at(-1)!.status).toBe("paused");
    expect(r.ctx.use("onboarding").active()).toBe(false);
    expect(r.ctx.use("onboarding").pending()).toBe(true);
    // Not active anymore: he's talking to the normal reflex again.
    r.clock.advance(120_000);
    r.emit("voice.final", { text: "eve what's up" });
    await waitFor(() => r.brains.requests.length > 0);
    // "let's finish the questions" resumes where she stopped.
    await r.answer("let's finish the questions");
    expect(r.said()).toContain(ONBOARDING_LINES.resume);
    expect(r.last()).toBe(Q.name);
    await r.stop();
  });

  test("pause phrase stops the flow; resumes at the same step next time she's woken", async () => {
    const home = new FakeHome();
    const r = await rig({ home });
    r.emit("companion.born", { persona, woken: true });
    await waitFor(() => r.said().includes(Q.name));
    await r.answer("matt");
    await r.answer("eve's fine");
    expect(r.renames).toEqual([]);
    expect(r.said()).toContain("[mood:happy 0.5] eve it is.");
    await r.answer("not now", 1);
    expect(r.last()).toBe(ONBOARDING_LINES.pause);
    expect(r.speech.stops).toContain("onboarding paused");
    await r.stop();

    // New process, same home: resume at "work".
    const r2 = await rig({ home });
    expect(r2.ctx.use("onboarding").pending()).toBe(true);
    r2.emit("companion.born", { persona, woken: true });
    await waitFor(() => r2.said().includes(Q.work));
    expect(r2.said()[0]).toBe(ONBOARDING_LINES.resume);
    expect(r2.ctx.use("user").profile().callMe).toBe("matt");
    await r2.stop();
  });

  test("restart mid-onboarding: restored birth waits for a client, then resumes", async () => {
    const home = new FakeHome(new Map<string, unknown>([["onboarding", { status: "active", index: 3, answered: ["name", "herName", "work"], skipped: [], updatedAt: 1 }], ["user", { callMe: "matt", herName: "Nova" }]]));
    const r = await rig({ home });
    r.emit("companion.born", { persona, restored: true });
    await settle(10);
    expect(r.said()).toEqual([]);
    // Her name comes back after a restart.
    expect(r.ctx.world().companion.persona?.name).toBe("Nova");
    expect(r.ctx.use("onboarding").active()).toBe(true);
    r.emit("bus.hello", { client: "overlay", role: "shell", version: "0" });
    await waitFor(() => r.said().includes(Q.interests));
    expect(r.said()[0]).toBe(ONBOARDING_LINES.resume);
    await r.stop();
  });

  test("redo: 'let's start over' after it's done asks everything again", async () => {
    const home = new FakeHome(new Map<string, unknown>([["onboarding", { status: "done", index: 6, answered: [], skipped: [], updatedAt: 1 }], ["user", { callMe: "matt" }]]));
    const r = await rig({ home });
    r.emit("companion.born", { persona, woken: true });
    await settle(10);
    // Already onboarded: the normal wake line, no questions.
    expect(r.said()).toEqual([WAKE_LINE]);
    expect(r.ctx.use("onboarding").pending()).toBe(false);
    r.speech.said.length = 0;
    r.clock.advance(120_000);
    expect(r.ctx.use("onboarding").claims("let's start over")).toBe(true);
    await r.answer("let's start over");
    expect(r.said()).toEqual([ONBOARDING_LINES.redo, Q.name]);
    expect(r.brains.requests.length).toBe(0);
    await r.answer("it's matthew");
    expect(r.ctx.use("user").profile().callMe).toBe("matthew");
    await r.stop();
  });

  test("unparseable answer: one retry, then skip", async () => {
    const r = await rig();
    r.emit("companion.born", { persona, woken: true });
    await waitFor(() => r.said().includes(Q.name));
    await r.answer("the thing is that it depends honestly", 1);
    expect(r.last().startsWith("[mood:thinking 0.5]")).toBe(true);
    expect(r.last().endsWith(Q.name)).toBe(true);
    await r.answer("the thing is that it depends honestly");
    expect(r.last()).toBe(Q.herName);
    expect(r.ctx.use("user").profile().sources.callMe).toBe("default");
    await r.stop();
  });

  test("HTTP: GET state, POST answer drives the same flow", async () => {
    const r = await rig({ reflex: false });
    const routes = (r.ctx as unknown as { routes: Map<string, (req: Request, url: URL) => Promise<Response | null>> }).routes;
    const call = async (path: string, body?: unknown) => {
      const url = new URL(`http://x${path}`);
      const req = new Request(url, body ? { method: "POST", body: JSON.stringify(body) } : {});
      const h = [...routes.keys()].filter((p) => url.pathname.startsWith(p)).sort((a, b) => b.length - a.length)[0]!;
      return (await (await routes.get(h)!(req, url))!.json()) as Record<string, any>;
    };
    expect((await call("/api/onboarding")).pending).toBe(true);
    await call("/api/onboarding/start", {});
    await waitFor(() => r.said().includes(Q.name));
    const res = await call("/api/onboarding/answer", { text: "call me matt" });
    expect(res.profile.callMe).toBe("matt");
    expect((await call("/api/user")).profile.callMe).toBe("matt");
    expect((await call("/api/user", { interests: ["climbing"] })).profile.interests).toEqual(["climbing"]);
    await r.stop();
  });
});

async function api(ctx: ReturnType<typeof fakeContext>, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const routes = (ctx as unknown as { routes: Map<string, (req: Request, url: URL) => Promise<Response | null>> }).routes;
  const url = new URL(`http://x${path}`);
  const req = new Request(url, { method, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
  const h = [...routes.keys()].filter((p) => url.pathname.startsWith(p)).sort((a, b) => b.length - a.length)[0]!;
  const res = (await routes.get(h)!(req, url))!;
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

describe("profile without spoken onboarding (the default)", () => {
  test("off by default: seeds matt, never asks, the reflex greets as usual", async () => {
    delete process.env.EVE_ONBOARDING;
    const ctx = fakeContext();
    ctx.config.demo = false;
    const home = new FakeHome();
    const speech = new FakeSpeech(ctx);
    ctx.provide("home", home);
    ctx.provide("speech", speech);
    ctx.provide("brains", new FakeBrains((r) => `(${r.behavior}) hi`));
    const stop = await startModules(ctx, [onboardingModule({ startDelayMs: 0 }), reflexModule({ jev: createJev({}) })]);
    const u = ctx.use("user").profile();
    expect([u.name, u.callMe, u.herName]).toEqual(["matt", "matt", undefined]);
    expect(u.sources).toEqual({ name: "default", callMe: "default" });
    expect((home.files.get("user") as UserProfile).callMe).toBe("matt");
    expect(ctx.use("onboarding").pending()).toBe(false);
    expect(ctx.use("onboarding").claims("redo onboarding")).toBe(false);
    ctx.bus.emit("companion.born", { persona, woken: true });
    await waitFor(() => speech.said.length > 0);
    await settle(10);
    expect(speech.said.map((s) => s.text)).toEqual([WAKE_LINE]);
    expect((await api(ctx, "POST", "/api/onboarding/start", {})).status).toBe(409);
    await stop();
  });

  test("seeding never overwrites what's there", async () => {
    const ctx = fakeContext();
    const home = new FakeHome(new Map<string, unknown>([["user", { name: "Matthew Kim", herName: "Nova", work: "eigenwife" }]]));
    ctx.provide("home", home);
    const stop = await startModules(ctx, [onboardingModule()]);
    const u = ctx.use("user").profile();
    expect([u.name, u.callMe, u.herName, u.work]).toEqual(["Matthew Kim", "matt", "Nova", "eigenwife"]);
    expect(u.sources.name).toBeUndefined();
    await stop();
  });

  test("PUT/PATCH /api/user: validated, persisted, renamed, remembered, beats gbrain", async () => {
    const ctx = fakeContext();
    const home = new FakeHome();
    const memory = new RecMemory(ctx);
    const renames: EventMap["companion.rename"][] = [];
    ctx.bus.on("companion.rename", (e) => void renames.push(e.data));
    ctx.provide("home", home);
    ctx.provide("memory", memory);
    const stop = await startModules(ctx, [onboardingModule()]);
    ctx.bus.emit("companion.born", { persona, woken: true });

    // Bad input: nothing applied.
    let r = await api(ctx, "PUT", "/api/user", { callMe: 3, birthday: "someday", shoeSize: 11, interests: "anime" });
    expect(r.status).toBe(400);
    expect(r.json.errors).toEqual(['unknown field "shoeSize"', "callMe must be a string or null", 'birthday "someday" isn\'t a date (use MM-DD or YYYY-MM-DD)', "interests must be an array of strings"]);
    expect((await api(ctx, "PUT", "/api/user", "{nope")).status).toBe(400);
    expect(ctx.use("user").profile().sources.callMe).toBe("default");

    r = await api(ctx, "PUT", "/api/user", {
      name: "Matthew Kim",
      callMe: "matt",
      herName: "Nova",
      pronouns: "he/him",
      birthday: "march 14",
      work: "building eigenwife",
      interests: ["climbing", "anime", "climbing"],
      people: [{ name: "Katie", relation: "girlfriend" }, "Sean"],
      boundaries: ["my ex"],
    });
    expect(r.status).toBe(200);
    expect(r.json.changed).toEqual(["name", "herName", "pronouns", "birthday", "work", "interests", "boundaries", "people"]);
    const u = r.json.profile as UserProfile;
    expect(u.birthday).toBe("03-14");
    expect(u.interests).toEqual(["climbing", "anime"]);
    expect(u.people).toEqual([{ name: "Katie", relation: "girlfriend" }, { name: "Sean", relation: "" }]);
    expect(u.sources.callMe).toBe("onboarding");
    expect((home.files.get("user") as UserProfile).herName).toBe("Nova");
    expect(renames.at(-1)).toEqual({ name: "Nova", by: "user" });
    expect(ctx.world().companion.persona?.name).toBe("Nova");
    const facts = memory.writes.map((w) => w.rec.content);
    expect(facts).toContain("Their name is Matthew Kim; they go by matt");
    expect(facts).toContain("They named the companion Nova");
    expect(facts).toContain("Their birthday is march 14");
    expect(memory.writes.every((w) => w.rec.importance === 0.9 && w.rec.tags?.includes("website"))).toBe(true);
    expect(memory.writes.find((w) => w.rec.content === "Never bring up or do: my ex")!.rec.tags).toContain("private");

    // gbrain can't overwrite what he said; it can only add list items.
    await ctx.use("user").merge({ work: "cs student", interests: ["music"] }, "gbrain");
    expect(ctx.use("user").profile().work).toBe("building eigenwife");
    expect(ctx.use("user").profile().interests).toEqual(["climbing", "anime", "music"]);

    // PATCH: only the given fields; null clears; lists replace. Clearing her name renames her back.
    const n = memory.writes.length;
    r = await api(ctx, "PATCH", "/api/user", { herName: null, interests: ["climbing"] });
    expect(r.json.changed).toEqual(["herName", "interests"]);
    expect(r.json.profile.herName).toBeUndefined();
    expect(r.json.profile.work).toBe("building eigenwife");
    expect(r.json.profile.interests).toEqual(["climbing"]);
    expect(renames.at(-1)).toEqual({ name: "Eve", by: "user" });
    expect(memory.writes.length).toBe(n + 1); // the new interests fact only

    // No-op edit: nothing changes, nothing written.
    r = await api(ctx, "PATCH", "/api/user", { work: "building eigenwife" });
    expect(r.json.changed).toEqual([]);
    expect(memory.writes.length).toBe(n + 1);
    expect((await api(ctx, "GET", "/api/user")).json.herName).toBe("Eve");
    await stop();
  });
});

describe("extraction", () => {
  test("names", () => {
    expect(nameFrom("call me matt")).toEqual({ callMe: "matt" });
    expect(nameFrom("my name is Matthew Kim but call me matt")).toEqual({ name: "Matthew Kim", callMe: "matt" });
    expect(nameFrom("matt")).toEqual({ name: "Matt", callMe: "matt" });
    expect(nameFrom("it's matt.")).toEqual({ name: "Matt", callMe: "matt" });
    expect(nameFrom("the thing is that it depends")).toBeNull();
    expect(herNameFrom("nova")).toBe("Nova");
    expect(herNameFrom("i'll call you mika")).toBe("Mika");
    expect(herNameFrom("eve's fine")).toBe("Eve");
    expect(herNameFrom("keep it")).toBe("Eve");
  });
  test("birthdays", () => {
    expect(birthdayFrom("march 14th")).toBe("03-14");
    expect(birthdayFrom("it's 14 march 2003")).toBe("2003-03-14");
    expect(birthdayFrom("3/14")).toBe("03-14");
    expect(birthdayFrom("oct 2")).toBe("10-02");
    expect(birthdayFrom("2004-12-25")).toBe("2004-12-25");
    expect(birthdayFrom("13/40")).toBeNull();
    expect(birthdayFrom("i don't celebrate")).toBeNull();
  });
  test("skip, pause, redo", () => {
    for (const s of ["skip", "idk", "later", "i don't know", "pass", "uh, skip that", "rather not say"]) expect(SKIP.test(s)).toBe(true);
    for (const s of ["matt", "skipping rope and climbing", "i like later nights"]) expect(SKIP.test(s)).toBe(false);
    for (const s of ["not now", "stop", "let's do this later", "okay stop asking"]) expect(PAUSE.test(s)).toBe(true);
    for (const s of ["redo onboarding", "let's start over", "ask me those questions again"]) expect(REDO.test(s)).toBe(true);
    expect(REDO.test("the game made me start overthinking")).toBe(false);
  });
  test("brain answers are validated", () => {
    expect(parseBrainAnswer("birthday", { birthday: "March 3" })).toEqual({ skip: false, patch: { birthday: "03-03" } });
    expect(parseBrainAnswer("birthday", { birthday: "whenever" })).toBeNull();
    expect(parseBrainAnswer("name", { skip: true })).toEqual({ skip: true, patch: {} });
    expect(parseBrainAnswer("name", { name: "Matthew Kim", callMe: null })).toEqual({ skip: false, patch: { name: "Matthew Kim", callMe: "matthew" } });
    expect(parseBrainAnswer("interests", { interests: ["climbing", 3, ""] })).toEqual({ skip: false, patch: { interests: ["climbing"] } });
    expect(parseBrainAnswer("boundaries", { none: true })).toEqual({ skip: false, patch: { boundaries: [] } });
    expect(parseBrainAnswer("work", "nope")).toBeNull();
  });
  test("regex fast path skips the brain; the brain reads the rest; regex covers a dead brain", async () => {
    let calls = 0;
    const brains = { quickJson: async () => (calls++, { interests: ["climbing", "anime"] }) } as unknown as BrainService;
    expect(await extractAnswer(brains, "name", "call me matt")).toEqual({ kind: "value", patch: { callMe: "matt" }, by: "regex" });
    expect(calls).toBe(0);
    expect(await extractAnswer(brains, "interests", "honestly climbing and a lot of anime")).toEqual({ kind: "value", patch: { interests: ["climbing", "anime"] }, by: "brain" });
    const dead = { quickJson: async () => null } as unknown as BrainService;
    expect(await extractAnswer(dead, "interests", "climbing, anime and music")).toEqual({ kind: "value", patch: { interests: ["climbing", "anime", "music"] }, by: "regex" });
    expect(await extractAnswer(dead, "boundaries", "nah")).toEqual({ kind: "value", patch: { boundaries: [] }, by: "regex" });
  });
});

describe("profile", () => {
  test("onboarding beats gbrain for scalars; lists union with his answers first", () => {
    let p = emptyProfile();
    p = mergeProfile(p, { work: "student at UCSB", interests: ["music"], people: [{ name: "Katie", relation: "" }] }, "gbrain", 1);
    p = mergeProfile(p, { work: "building eigenwife", interests: ["climbing"] }, "onboarding", 2);
    p = mergeProfile(p, { work: "cs student", interests: ["anime"], people: [{ name: "Katie", relation: "girlfriend" }, { name: "Sean", relation: "friend" }] }, "gbrain", 3);
    expect(p.work).toBe("building eigenwife");
    expect(p.sources.work).toBe("onboarding");
    expect(p.interests).toEqual(["climbing", "music", "anime"]);
    expect(p.people).toEqual([{ name: "Katie", relation: "girlfriend" }, { name: "Sean", relation: "friend" }]);
    expect(p.updatedAt).toBe(3);
    // Nothing changed: updatedAt stays.
    expect(mergeProfile(p, { work: "cs student" }, "gbrain", 9).updatedAt).toBe(3);
  });
  test("normalize survives junk and strips em dashes", () => {
    const p = normalizeProfile({ name: 3, callMe: " matt ", work: "a \u2014 b", interests: "x", people: ["Sean", { relation: "no name" }], sources: { work: "hacker" } });
    expect(p.callMe).toBe("matt");
    expect(p.work).toBe("a, b");
    expect(p.interests).toEqual([]);
    expect(p.people).toEqual([{ name: "Sean", relation: "" }]);
    expect(p.sources).toEqual({});
  });
});

describe("prompt", () => {
  const profile: UserProfile = {
    ...emptyProfile(),
    name: "Matthew Kim",
    callMe: "matt",
    herName: "Nova",
    work: "building eigenwife",
    interests: ["climbing", "anime"],
    people: [{ name: "Katie", relation: "girlfriend" }],
    boundaries: ["bring up my ex", "comment on my weight"],
  };
  test("every persona prompt gets who you're talking to, boundaries as hard rules", () => {
    const card = renamePersona(DEFAULT_EVE, "Nova");
    const m = buildPersonaPrompt({ persona: card, world: "", req: { event: "e", behavior: "react" }, user: profile });
    expect(m.system).toContain("you are Nova.");
    expect(m.system).toContain("Nova lives on the user's desktop");
    expect(m.system).not.toMatch(/\bEve\b/);
    expect(m.system).toContain("[who you're talking to]");
    expect(m.system).toContain('call them "matt"');
    expect(m.system).toContain("they named you Nova");
    expect(m.system).toContain("Katie (girlfriend)");
    expect(m.system).toContain("never break these");
    expect(m.system).toContain("- never: bring up my ex");
    expect(m.system).toContain("- never: comment on my weight");
    expect(m.user).toContain("reply out loud as Nova");
    expect(m.system).not.toMatch(/[\u2013\u2014]/);
  });
  test("no profile, no block", () => {
    expect(userBlock(emptyProfile())).toEqual([]);
    expect(buildPersonaPrompt({ persona: DEFAULT_EVE, world: "", req: { event: "e", behavior: "b" } }).system).not.toContain("who you're talking to");
  });
  test("brains module: persona backend sees the renamed card and the profile", async () => {
    const ctx = fakeContext();
    const seen: ChatMessage[] = [];
    const backend: ChatBackend = {
      name: "fake",
      configured: () => true,
      model: () => "fake",
      async *stream(msg) {
        seen.push(msg);
        yield "hey matt.";
      },
    };
    ctx.provide("user", { profile: () => profile, herName: () => "Nova", merge: async () => profile });
    const stop = await startModules(ctx, [brainsModule({ personaBackends: [backend], jsonBackends: [], frontierEngines: [] })]);
    let out = "";
    for await (const c of ctx.use("brains").persona({ event: "e", behavior: "greet" })) out += c;
    expect(out).toBe("hey matt.");
    expect(seen[0]!.system).toContain("you are Nova.");
    expect(seen[0]!.system).toContain("- never: bring up my ex");
    await stop();
  });
});
