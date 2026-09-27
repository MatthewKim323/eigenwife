import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_RELATIONSHIP, type AnyEnvelope, type Persona } from "@eigenwife/protocol";
import { startCore, type Module, type RunningCore } from "../src/index";
import type { FrontierRequest, UserProfile } from "../src/services";
import { createJev } from "../src/reflex/jev";
import { reflexModule } from "../src/reflex/module";
import { FakeAgency, FakeBrains, FakeHome, FakeMemory, FakeSpeech } from "../src/reflex/testing";
import { conversationFor } from "../src/brains/module";
import { createAgency } from "../src/agency/module";
import { CREATE_EVENT_JXA } from "../src/agency/actions/calendar";
import type { OsaRunner } from "../src/agency/osa";
import { liveModule } from "../src/live/module";
import { buildInstructions, contextUpdate, startupHistory } from "../src/live/instructions";
import { liveConfig, providerOrder, NO_ACCESS_REASON } from "../src/live/config";
import { sessionConfig, isAccessProblem } from "../src/live/provider";
import { readSwitch } from "../src/live/switch";
import { moodOf, finishedSentences } from "../src/live/mood";
import { UsageMeter, localDay } from "../src/live/usage";
import { isDeep } from "../src/live/delegation";
import { cleanLine } from "../src/live/controller";
import { Side, isBackchannel } from "../src/live/transcript";
import { HeadlessPage } from "../src/live/headless";
import { FakeLiveServer, type FakeMode } from "../src/live/testing";

process.env.EIGEN_QUIET = "1";

const persona: Persona = {
  name: "Eve",
  tagline: "your type, compiled",
  description: "Eve lives on the user's desktop.",
  personality: "Dry, teasing, quick. Warm underneath.",
  scenario: "It is evening.",
  dials: { humor: 0.8, sarcasm: 0.7, warmth: 0.65, initiative: 0.7, verbosity: 0.3, chaos: 0.5 },
  voice: { provider: "elevenlabs", voiceId: "x", style: "soft" },
  palette: { hue: 330 },
  vector: {},
};

const profile: UserProfile = {
  name: "Matthew Kim",
  callMe: "matt",
  interests: ["ramen", "startups"],
  people: [],
  boundaries: ["bring up his ex"],
  vibe: [],
  updatedAt: 0,
  sources: {},
};

const waitFor = async (pred: () => boolean, ms = 2500, what = "condition") => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};

class Brains extends FakeBrains {
  frontiers: FrontierRequest[] = [];
  frontierText = "tokyo is 16 hours ahead of irvine right now.";
  async frontier(req?: FrontierRequest) {
    if (req) this.frontiers.push(req);
    return { ok: true, text: this.frontierText, engine: "fake", ms: 1 };
  }
}

interface Rig {
  core: RunningCore;
  tick(): void;
  fake: FakeLiveServer;
  page: HeadlessPage;
  events: AnyEnvelope[];
  speech: FakeSpeech;
  brains: Brains;
  memory: FakeMemory;
  agency: FakeAgency;
  home: FakeHome;
  clock: { t: number };
  of<K extends AnyEnvelope["type"]>(t: K): Extract<AnyEnvelope, { type: K }>[];
  live(): Promise<void>;
  post(engine: "live" | "classic"): Promise<Record<string, unknown>>;
  status(): Promise<Record<string, unknown>>;
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    r.page.close();
    await r.core.stop();
    r.fake.stop();
  }
});

async function rig(o: { mode?: FakeMode; gateway?: boolean; openai?: boolean; cap?: number; engine?: "live" | "classic"; savedEngine?: "live" | "classic"; page?: boolean } = {}): Promise<Rig> {
  const fake = new FakeLiveServer().start();
  fake.mode = o.mode ?? "ok";
  const clock = { t: Date.now() };
  const home = new FakeHome();
  if (o.savedEngine) home.files.set("voice", { engine: o.savedEngine });
  const brains = new Brains((r) => (r.behavior === "confirm" ? "calendar tsuki at 7:30, yeah?" : `(${r.behavior}) persona line`));
  const agency = new FakeAgency({ ok: true, summary: "booked tsuki ramen at 7:30." }, 30);
  const events: AnyEnvelope[] = [];
  let speech!: FakeSpeech;
  let memory!: FakeMemory;
  const fixtures: Module = {
    name: "fixtures",
    start(ctx) {
      ctx.bus.on("*", (e: AnyEnvelope) => void events.push(e));
      // What the brains module does in the app: every conversation.turn lands in the session conversation.
      ctx.bus.on("conversation.turn", (e) => void conversationFor(ctx).add(e.data.role, e.data.text));
      speech = new FakeSpeech(ctx);
      memory = new FakeMemory(ctx, ["likes spicy ramen"]);
      ctx.provide("home", home);
      ctx.provide("speech", speech);
      ctx.provide("brains", brains);
      ctx.provide("memory", memory);
      ctx.provide("agency", agency);
      ctx.provide("user", { profile: () => profile, merge: async () => profile, herName: () => null });
      ctx.provide("relationship", { get: () => ({ ...DEFAULT_RELATIONSHIP, banter: 0.8 }), nudge: () => DEFAULT_RELATIONSHIP });
    },
  };
  const live = liveModule({
    config: {
      envEngine: o.engine ?? null,
      provider: "auto",
      gatewayKey: o.gateway === false ? "" : fake.gatewayKey,
      openaiKey: o.openai ? fake.openaiKey : "",
      gatewayUrl: fake.url,
      openaiUrl: fake.url,
      dailyCapMin: o.cap ?? 60,
      idleMin: 0,
    },
    tickMs: 0,
    userGapMs: 40,
    eveGapMs: 60,
    closeTimeoutMs: 500,
    delegationFallbackMs: 120,
    now: () => clock.t,
  });
  const core = await startCore([fixtures, live, reflexModule({ jev: createJev({}) })], { port: 0, demo: false });
  core.ctx.bus.emit("companion.born", { persona }, "test");
  await Bun.sleep(20);
  const page = new HeadlessPage({ core: `ws://127.0.0.1:${core.port}` });
  if (o.page !== false) await page.connect();
  const base = `http://127.0.0.1:${core.port}`;
  const r: Rig = {
    core,
    tick: () => live.controller()!.tick(),
    fake,
    page,
    events,
    speech,
    brains,
    memory,
    agency,
    home,
    clock,
    of: (t) => events.filter((e) => e.type === t) as never,
    live: () => waitFor(() => fake.live && page.started && events.some((e) => e.type === "live.state" && e.data.status === "live"), 3000, "live session"),
    post: async (engine) => (await (await fetch(`${base}/api/live/engine`, { method: "POST", body: JSON.stringify({ engine, by: "tray" }) })).json()) as Record<string, unknown>,
    status: async () => (await (await fetch(`${base}/api/live`)).json()) as Record<string, unknown>,
  };
  rigs.push(r);
  return r;
}

// ---------------------------------------------------------------------------
// pure pieces
// ---------------------------------------------------------------------------

describe("session config assembly", () => {
  test("instructions carry the persona card, dials, profile + boundaries, summary, world, and the delegation policy", () => {
    const text = buildInstructions({ persona, relationship: { ...DEFAULT_RELATIONSHIP, banter: 0.8 }, user: profile, summary: "they planned ramen friday.", world: "- scene: desktop\n- active app: Figma" });
    expect(text).toContain("you are Eve. Eve lives on the user's desktop.");
    expect(text).toContain("personality dials (0..1): humor 0.80");
    expect(text).toContain("relationship so far (0..1): banter 0.80");
    expect(text).toContain('call them "matt"');
    expect(text).toContain("- never: bring up his ex");
    expect(text).toContain("[earlier in your conversation]\nthey planned ramen friday.");
    expect(text).toContain("- active app: Figma");
    expect(text).toContain("[when to ask your backend]");
    expect(text).toContain("do NOT delegate small talk");
    expect(text).not.toMatch(new RegExp("[\\u2013\\u2014]"));
  });

  test("startup history maps turns to Live input messages, newest kept, marks stripped", () => {
    const turns = Array.from({ length: 60 }, (_, i) => ({ role: (i % 2 ? "eve" : "user") as "eve" | "user", text: `[mood:happy 0.5] line ${i}` }));
    const h = startupHistory(turns);
    expect(h.length).toBe(40);
    expect(h.at(-1)).toEqual({ type: "message", role: "assistant", content: [{ type: "output_text", text: "line 59" }] });
    expect(h[0]).toEqual({ type: "message", role: "user", content: [{ type: "input_text", text: "line 20" }] });
    expect(startupHistory(turns, { maxChars: 20 }).length).toBe(2);
  });

  test("gateway sessions get openai/ model + PCM format; webrtc omits the format; always client delegation, store false", () => {
    const cfg = liveConfig(() => "", { voice: "gleam" });
    const gw = sessionConfig(cfg, "gateway", { instructions: "x", input: [] });
    expect(gw).toEqual({ model: "openai/gpt-live-1", store: false, delegation: { type: "client" }, audio: { output: { voice: "gleam" }, format: { type: "audio/pcm", rate: 24000 } }, instructions: "x" });
    const rtc = sessionConfig(cfg, "openai", { instructions: "x", input: [{ a: 1 }] });
    expect(rtc.model).toBe("gpt-live-1");
    expect(rtc.audio).toEqual({ output: { voice: "gleam" } });
    expect(rtc.input).toEqual([{ a: 1 }]);
  });

  test("context refresh stays under the 500-token append limit", () => {
    const u = contextUpdate({ persona, relationship: DEFAULT_RELATIONSHIP, user: profile, world: "x".repeat(5000) });
    expect(u.length).toBeLessThanOrEqual(1800);
    expect(u).toContain("context update");
  });

  test("config: env parsing, voice default, provider order", () => {
    const env: Record<string, string> = { EVE_VOICE_ENGINE: "live", EVE_LIVE_DAILY_MIN: "15", AI_GATEWAY_API_KEY: "g", OPENAI_API_KEY: "o" };
    const cfg = liveConfig((n) => env[n] ?? "");
    expect(cfg.envEngine).toBe("live");
    expect(cfg.dailyCapMin).toBe(15);
    expect(cfg.voice).toBe("gleam");
    expect(providerOrder(cfg)).toEqual(["gateway", "openai"]);
    expect(providerOrder({ ...cfg, provider: "openai" })).toEqual(["openai"]);
    expect(liveConfig(() => "").envEngine).toBeNull();
    expect(liveConfig((n) => (n === "EVE_LIVE_VOICE" ? "Marin" : "")).voice).toBe("marin");
  });
});

describe("small readers", () => {
  test("spoken switch", () => {
    expect(readSwitch("switch to live mode")).toBe("live");
    expect(readSwitch("yo eve, can you switch to live mode please")).toBe("live");
    expect(readSwitch("go live")).toBe("live");
    expect(readSwitch("go back to classic")).toBe("classic");
    expect(readSwitch("switch back to your normal voice")).toBe("classic");
    expect(readSwitch("use your normal voice")).toBe("classic");
    expect(readSwitch("turn off live mode")).toBe("classic");
    expect(readSwitch("i watched a live show last night")).toBeNull();
    expect(readSwitch("what do you think about live mode vs classic")).toBeNull();
  });

  test("mood from her transcript", () => {
    expect(moodOf("haha okay fine")?.mood).toBe("happy");
    expect(moodOf("ugh, seriously?")?.mood).toBe("annoyed");
    expect(moodOf("told you. obviously.")?.mood).toBe("smug");
    expect(moodOf("hmm, let me check")?.mood).toBe("thinking");
    expect(moodOf("the meeting is at three")).toBeNull();
    expect(finishedSentences("one. two! three")).toEqual(["one.", "two!"]);
  });

  test("deep questions go to the frontier, actions don't", () => {
    expect(isDeep("can you explain how transformers attention works")).toBe(true);
    expect(isDeep("why is the sky blue")).toBe(true);
    expect(isDeep("play our song")).toBe(false);
    expect(isDeep("put your hoodie on")).toBe(false);
    expect(isDeep("hey")).toBe(false);
  });

  test("clean lines, backchannels, access errors", () => {
    expect(cleanLine("[mood:smug 0.6] obviously. [pause:0.4] you're welcome")).toBe("obviously. you're welcome");
    expect(isBackchannel("mhm")).toBe(true);
    expect(isBackchannel("mm-hmm")).toBe(false);
    expect(isBackchannel("yeah.")).toBe(true);
    expect(isAccessProblem(402, "")).toBe(true);
    expect(isAccessProblem(undefined, "insufficient_quota: You exceeded your current quota")).toBe(true);
    expect(isAccessProblem(500, "internal")).toBe(false);
  });

  test("transcript side: grows, ends on a gap, flushes on demand", async () => {
    const log: string[] = [];
    const s = new Side({ start: () => log.push("start"), grow: (t) => log.push(`grow ${t}`), end: (t, why) => log.push(`end ${t} ${why}`) }, 20);
    s.push("hi");
    s.push(" there");
    await Bun.sleep(40);
    s.push("again");
    s.flush();
    expect(log).toEqual(["start", "grow hi", "grow hi there", "end hi there gap", "start", "grow again", "end again flush"]);
  });

  test("usage meter: max(wall, reported), closed sessions add up, day rollover", () => {
    const clock = { t: new Date(2026, 8, 26, 23, 50).getTime() };
    const m = new UsageMeter(() => clock.t, { day: localDay(clock.t), seconds: 120 });
    expect(m.seconds()).toBe(120);
    m.begin();
    clock.t += 30_000;
    expect(m.seconds()).toBe(150);
    m.report(45);
    expect(m.seconds()).toBe(165);
    m.end(50);
    expect(m.seconds()).toBe(170);
    clock.t += 20 * 60_000; // past midnight
    expect(m.seconds()).toBe(0);
    expect(new UsageMeter(() => clock.t, { day: "2020-01-01", seconds: 999 }).seconds()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// against the fake realtime server
// ---------------------------------------------------------------------------

describe("eve live end to end (fake gpt-live-1)", () => {
  test("live engine: core mints a single-use gateway secret, page connects, session.start carries the assembled config; the key never reaches the page", async () => {
    const r = await rig({ engine: "live" });
    await r.live();
    expect(r.fake.mints).toEqual([{ model: "openai/gpt-live-1", routeKind: "live" }]);
    const start = r.fake.starts[0]!;
    expect(start.model).toBe("openai/gpt-live-1");
    expect(start.delegation).toEqual({ type: "client" });
    expect(start.store).toBe(false);
    expect(start.audio).toEqual({ output: { voice: "gleam" }, format: { type: "audio/pcm", rate: 24000 } });
    expect(String(start.instructions)).toContain("you are Eve");
    expect(String(start.instructions)).toContain("- never: bring up his ex");
    expect(JSON.stringify(r.page.downs)).not.toContain(r.fake.gatewayKey);
    expect(r.of("voice.engine")[0]!.data).toEqual({ engine: "live", by: "env" });
    const st = r.of("live.state").at(-1)!.data;
    expect(st).toMatchObject({ status: "live", provider: "gateway", voice: "gleam", capMin: 60 });
    await Bun.sleep(60);
    expect(r.fake.audioFrames).toBeGreaterThan(0);
    const s = await r.status();
    expect(s).toMatchObject({ engine: "live", status: "live", provider: "gateway", owner: "overlay" });
  });

  test("bus parity: his live words become voice.partial/final/turn + conversation.turn; hers become speech.begin/end, avatar state + mood, conversation.turn", async () => {
    const r = await rig({ engine: "live" });
    await r.live();
    await r.fake.userSays("hey what are you up to");
    await waitFor(() => r.of("voice.final").length > 0, 2000, "voice.final");
    expect(r.of("voice.partial").at(-1)!.data.text).toBe("hey what are you up to");
    expect(r.of("voice.final")[0]!.data.text).toBe("hey what are you up to");
    await waitFor(() => r.of("voice.turn").length > 0 && r.of("conversation.turn").some((e) => e.data.role === "user"), 2000, "turn");
    await r.fake.eveSays("haha, just judging your tabs. obviously.");
    await waitFor(() => r.of("speech.end").some((e) => e.source === "live"), 2000, "speech.end");
    const begin = r.of("speech.begin").find((e) => e.source === "live")!;
    expect(begin.data.brain).toBe("live");
    expect(r.of("avatar.state").map((e) => e.data.state)).toEqual(expect.arrayContaining(["listening", "speaking"]));
    expect(r.of("avatar.mood").some((e) => e.source === "live" && e.data.mood === "happy")).toBe(true);
    const eveTurn = r.of("conversation.turn").find((e) => e.data.role === "eve")!;
    expect(eveTurn.data.text).toBe("haha, just judging your tabs. obviously.");
    const convo = conversationFor(r.core.ctx).turns.map((t) => `${t.role}: ${t.text}`);
    expect(convo).toEqual(expect.arrayContaining(["user: hey what are you up to", "eve: haha, just judging your tabs. obviously."]));
    // Reflex's own reply to his live words was dropped: no classic TTS, no persona call.
    await Bun.sleep(100);
    expect(r.speech.said.filter((s) => s.opts?.brain === "persona" && !s.text.includes("greet"))).toEqual([]);
    expect(r.brains.requests.filter((q) => q.userText === "hey what are you up to")).toEqual([]);
  });

  test("delegation round trip: 'play our song' -> reflex ACT -> agency.act music.play -> commentary back to the voice model with the delegation id", async () => {
    const r = await rig({ engine: "live" });
    await r.live();
    await r.fake.userSays("play our song");
    await Bun.sleep(10);
    const id = r.fake.delegate();
    await waitFor(() => r.agency.acts.some((a) => a.kind === "music.play"), 2000, "music.play");
    await waitFor(() => r.fake.of("session.commentary.append").some((e) => e.delegation_id === id) || r.fake.of("session.thinking.append").some((e) => e.delegation_id === id && String(e.content).includes("done")), 2000, "result back");
    const decision = r.of("reflex.decision").find((e) => e.data.decision === "ACT");
    expect(decision).toBeTruthy();
    // Memory for his words went in quietly.
    await waitFor(() => r.fake.of("session.thinking.append").some((e) => e.delegation_id === id && String(e.content).includes("likes spicy ramen")), 2000, "memory thinking");
    // The classic TTS never spoke.
    expect(r.speech.said.filter((s) => s.opts?.parent && r.of("voice.final").some((f) => f.id === s.opts!.parent))).toEqual([]);
  });

  test("deep question: delegation goes to the frontier brain and the answer comes back as commentary", async () => {
    const r = await rig({ engine: "live" });
    await r.live();
    await r.fake.userSays("can you explain why tokyo is so far ahead of us in time");
    await Bun.sleep(10);
    const id = r.fake.delegate();
    await waitFor(() => r.fake.of("session.commentary.append").some((e) => e.delegation_id === id), 3000, "frontier commentary");
    const c = r.fake.of("session.commentary.append").find((e) => e.delegation_id === id)!;
    expect(String(c.content)).toContain("tokyo is 16 hours ahead");
    expect(r.brains.frontiers[0]!.goal).toContain("why tokyo is so far ahead");
    expect(r.fake.of("error")).toEqual([]);
  });

  test("delegated task: runTask via reflex ESCALATE, progress as thinking, the report as commentary", async () => {
    const r = await rig({ engine: "live" });
    await r.live();
    await r.fake.userSays("book me a ramen place for tonight");
    await Bun.sleep(10);
    const id = r.fake.delegate();
    await waitFor(() => r.agency.tasks.length > 0, 2000, "runTask");
    await waitFor(() => r.fake.of("session.commentary.append").some((e) => e.delegation_id === id && String(e.content).includes("booked tsuki")), 3000, "report");
    expect(r.fake.of("session.thinking.append").some((e) => e.delegation_id === id && String(e.content).startsWith("backend: working on it"))).toBe(true);
  });

  test("spoken approval: the gate's question goes to the live session, his 'yeah' (live transcript) approves it through the existing gate", async () => {
    const r = await rig({ engine: "live" });
    await r.live();
    const calls: string[] = [];
    const osa: OsaRunner = async (script) => {
      calls.push(script);
      return { ok: true, stdout: JSON.stringify(script === CREATE_EVENT_JXA ? { uid: "UID-1", calendar: "Eigenwife", fellBack: false } : ""), stderr: "", code: 0 };
    };
    const agency = createAgency(r.core.ctx, { deps: { osa, env: () => "", now: () => Date.now(), openUrl: async () => true, openVisible: async () => false, loadHarem: async () => null }, approvalTimeoutMs: 3000 });
    const pending = agency.gate.request("calendar.create_event", { title: "Tsuki Ramen", start: "19:30", durationMin: 60, location: "Irvine" });
    await waitFor(() => r.fake.of("session.commentary.append").some((e) => String(e.content).startsWith("ask him this")), 2000, "approval question");
    const q = r.fake.of("session.commentary.append").find((e) => String(e.content).startsWith("ask him this"))!;
    expect(String(q.content)).toContain("calendar tsuki at 7:30, yeah?");
    expect(r.speech.said.some((s) => s.text.includes("calendar tsuki"))).toBe(false);
    await r.fake.eveSays("want me to put tsuki at seven thirty on your calendar?");
    await r.fake.userSays("yeah lock it in");
    const res = await pending;
    expect(res.ok).toBe(true);
    expect(r.of("action.approval")[0]!.data).toMatchObject({ approved: true, by: "voice" });
    expect(calls).toContain(CREATE_EVENT_JXA);
  });

  test("ambient lines (not replies to him) are voiced by the live model as commentary", async () => {
    const r = await rig({ engine: "live" });
    await r.live();
    const out = await r.core.ctx.use("speech").say("[mood:smug 0.6] you've had that tab open for an hour.", { priority: "low", brain: "persona" });
    expect(out.text).toBe("you've had that tab open for an hour.");
    await waitFor(() => r.fake.of("session.commentary.append").length > 0, 2000, "commentary");
    const c = r.fake.of("session.commentary.append").at(-1)!;
    expect(c).toMatchObject({ delegation_id: null, content: "you've had that tab open for an hour." });
    expect(r.of("avatar.mood").at(-1)!.data).toMatchObject({ mood: "smug", intensity: 0.6 });
    expect(r.speech.said.some((s) => s.text.includes("that tab"))).toBe(false);
  });

  test("toggle: tray switches to classic (graceful close, usage counted, ears get voice.engine), back to live opens a fresh session with a greeting; choice persists", async () => {
    const r = await rig({ savedEngine: "live" });
    await r.live();
    expect(r.of("voice.engine")[0]!.data).toEqual({ engine: "live", by: "restore" });
    r.fake.usage(12);
    await Bun.sleep(20);
    const off = await r.post("classic");
    expect(off).toMatchObject({ ok: true, engine: "classic" });
    await waitFor(() => r.fake.of("session.close").length === 1, 2000, "session.close");
    await waitFor(() => r.of("live.state").at(-1)!.data.status === "off", 2000, "off");
    await waitFor(() => !r.page.started, 2000, "page transport down");
    expect(r.of("voice.engine").at(-1)!.data).toEqual({ engine: "classic", by: "tray" });
    expect(r.home.files.get("voice")).toMatchObject({ engine: "classic" });
    expect(((await r.status()).usedMin as number) > 0).toBe(true);
    // Classic again: the classic path speaks.
    await r.core.ctx.use("speech").say("classic line", { brain: "persona" });
    expect(r.speech.said.at(-1)!.text).toBe("classic line");
    const on = await r.post("live");
    expect(on).toMatchObject({ ok: true, engine: "live" });
    await waitFor(() => r.fake.starts.length === 2 && r.page.started, 2000, "second session");
    await waitFor(() => r.fake.of("session.instructions.append").some((e) => e.event_id === "greet"), 2000, "greet");
    expect(r.fake.mints.length).toBe(2);
    expect(r.home.files.get("voice")).toMatchObject({ engine: "live" });
  });

  test("spoken switch from classic ears: 'switch to live mode' flips the engine and reflex's persona reply is swallowed", async () => {
    const r = await rig();
    expect(r.of("live.state").at(-1)!.data.status).toBe("off");
    r.core.ctx.bus.emit("voice.final", { text: "yo switch to live mode" }, "ears");
    await r.live();
    expect(r.of("voice.engine").at(-1)!.data).toEqual({ engine: "live", by: "voice" });
    await Bun.sleep(80);
    expect(r.speech.said.filter((s) => s.opts?.brain === "persona" && /persona line/.test(s.text) && !/greet/.test(s.text))).toEqual([]);
    // And back, by voice, through the live transcript.
    await r.fake.userSays("go back to classic");
    await waitFor(() => r.of("voice.engine").at(-1)!.data.engine === "classic", 2000, "classic");
    await waitFor(() => r.speech.said.some((s) => s.text.includes("back to my usual voice")), 2000, "her confirmation");
  });

  test("no credits at mint: clear no_access state, engine falls back to classic, classic keeps talking", async () => {
    const r = await rig({ engine: "live", mode: "no_credits_mint" });
    await waitFor(() => r.of("live.state").some((e) => e.data.status === "no_access"), 2000, "no_access");
    const st = r.of("live.state").find((e) => e.data.status === "no_access")!.data;
    expect(st.reason).toStartWith(NO_ACCESS_REASON);
    expect(st.reason).toContain("gateway");
    await waitFor(() => r.of("voice.engine").at(-1)!.data.engine === "classic", 2000, "fallback");
    expect(r.of("voice.engine").at(-1)!.data.by).toBe("fallback");
    await waitFor(() => r.speech.said.some((s) => s.text.includes("needs credits")), 2000, "her line");
    expect(r.page.started).toBe(false);
  });

  test("no credits at the socket (token minted, model blocked): same clear state", async () => {
    const r = await rig({ engine: "live", mode: "no_credits_ws" });
    await waitFor(() => r.of("live.state").some((e) => e.data.status === "no_access"), 3000, "no_access");
    expect(r.of("voice.engine").at(-1)!.data).toMatchObject({ engine: "classic", by: "fallback" });
  });

  test("gateway blocked, openai present: falls through to the WebRTC SDP exchange (key stays in core); openai out of quota too: no_access", async () => {
    const r = await rig({ engine: "live", mode: "no_credits_mint", openai: true });
    await waitFor(() => r.fake.webrtcCreates.length === 1 && r.page.answers.length === 1, 2000, "webrtc answer");
    const create = r.fake.webrtcCreates[0] as { session: Record<string, unknown>; transport: { type: string; sdp: string } };
    expect(create.transport.type).toBe("webrtc");
    expect(create.session.model).toBe("gpt-live-1");
    expect(create.session.audio).toEqual({ output: { voice: "gleam" } });
    expect(r.page.answers[0]!.sdp).toContain("fake-answer");
    expect(JSON.stringify(r.page.downs)).not.toContain(r.fake.openaiKey);

  });

  test("gateway blocked and openai out of quota (the keys today): no_access with the credits reason", async () => {
    const r = await rig({ engine: "live", mode: "no_credits_mint", openai: true });
    r.fake.openaiNoQuota = true;
    await waitFor(() => r.of("live.state").some((e) => e.data.status === "no_access"), 3000, "no_access");
    const st = r.of("live.state").find((e) => e.data.status === "no_access")!.data;
    expect(st.reason).toStartWith(NO_ACCESS_REASON);
    expect(r.fake.webrtcCreates.length).toBe(1);
    expect(r.of("voice.engine").at(-1)!.data).toMatchObject({ engine: "classic", by: "fallback" });
  });

  test("no keys at all: the toggle refuses with the credits reason", async () => {
    const r = await rig({ gateway: false });
    const out = await r.post("live");
    expect(out).toMatchObject({ ok: false, engine: "classic", status: "no_access" });
    expect(String(out.reason)).toContain(NO_ACCESS_REASON);
  });

  test("cost cap: warns near the cap, then falls back to classic and refuses live until tomorrow", async () => {
    const r = await rig({ engine: "live", cap: 5 });
    await r.live();
    r.clock.t += 3.5 * 60_000;
    r.fake.usage(210);
    await Bun.sleep(20);
    r.tick();
    await waitFor(() => r.fake.of("session.instructions.append").some((e) => e.event_id === "cap_warning"), 2000, "warning");
    expect(r.of("voice.engine").at(-1)!.data.engine).toBe("live");
    r.clock.t += 2 * 60_000;
    r.tick();
    await waitFor(() => r.of("live.state").some((e) => e.data.status === "capped"), 2000, "capped");
    expect(r.of("voice.engine").at(-1)!.data).toMatchObject({ engine: "classic", by: "cost" });
    await waitFor(() => r.speech.said.some((s) => s.text.includes("live minutes")), 2000, "cap line");
    const again = await r.post("live");
    expect(again).toMatchObject({ ok: false, engine: "classic", status: "capped" });
    expect(r.home.files.get("live-usage")).toMatchObject({ day: localDay(r.clock.t) });
  });

  test("no page yet: live waits for the overlay, connects when it says hello", async () => {
    const r = await rig({ engine: "live", page: false });
    await Bun.sleep(30);
    expect(r.of("live.state").at(-1)!.data).toMatchObject({ status: "connecting" });
    expect(r.fake.mints.length).toBe(0);
    await r.page.connect();
    await r.live();
  });
});
