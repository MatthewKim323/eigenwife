import { describe, expect, test } from "bun:test";
import type { AnyEnvelope, MemoryHit } from "@eigenwife/protocol";
import { EventBus } from "../src/bus";
import { loadConfig } from "../src/config";
import { createContext } from "../src/context";
import type { BrainService, FrontierRequest, MemoryService, SpeechService } from "../src/services";
import { classifyApproval, judgeApproval } from "../src/agency/approval";
import { CREATE_EVENT_JXA, DELETE_EVENT_JXA, FREE_BUSY_JXA, LIST_CALENDARS_JXA, firstFreeSlot, parseStart } from "../src/agency/actions/calendar";
import { QUIT_APP_SCRIPT, safeUrl } from "../src/agency/actions/apps";
import { htmlToText, parseDuckDuckGo } from "../src/agency/actions/web";
import { agencyModule, createAgency } from "../src/agency/module";
import { appleScriptString, jxaLiteral, type OsaRunner } from "../src/agency/osa";
import { normalizePlan } from "../src/agency/planner";
import type { AgencyDeps, HaremModule } from "../src/agency/types";

process.env.EIGEN_QUIET = "1";

/** 3pm on demo day, local time. Deterministic "tonight". */
const NOW = new Date(2026, 8, 26, 15, 0, 0, 0).getTime();
const at = (h: number, m = 0) => new Date(2026, 8, 26, h, m, 0, 0).getTime();

interface OsaCall {
  script: string;
  lang?: string;
  args: string[];
}

function fakeOsa(opts: { fail?: boolean } = {}) {
  const calls: OsaCall[] = [];
  const run: OsaRunner = async (script, o = {}) => {
    calls.push({ script, lang: o.lang, args: o.args ?? [] });
    if (opts.fail) return { ok: false, stdout: "", stderr: "Calendar got an error: not allowed", code: 1 };
    const payload = o.args?.[0] ? JSON.parse(o.args[0]) : {};
    let out: unknown = "";
    if (script === CREATE_EVENT_JXA) out = { uid: "UID-1", calendar: "Eigenwife", fellBack: false };
    else if (script === DELETE_EVENT_JXA) out = { deleted: 1 };
    else if (script === LIST_CALENDARS_JXA) out = ["Home", "Work", "Slow"];
    else if (script === FREE_BUSY_JXA) {
      if (payload.calendar === "Slow") return { ok: false, stdout: "", stderr: "", code: 143 };
      out = payload.calendar === "Home" ? [{ title: "gym", start: at(18), end: at(19, 15), calendar: "Home" }] : [];
    } else return { ok: true, stdout: "quit", stderr: "", code: 0 };
    return { ok: true, stdout: JSON.stringify(out), stderr: "", code: 0 };
  };
  return { run, calls };
}

const RESTAURANTS = {
  places: [
    { name: "Hironori Craft Ramen", price: "$$", cost: 21, rating: 4.7, address: "Irvine", why: "great but pricey", dish: "tonkotsu" },
    { name: "Tsuki Ramen", price: "$", cost: 12, rating: 4.5, address: "Irvine", why: "cheap and spicy", dish: "spicy tonkotsu" },
  ],
};

function fakeBrains(opts: { fail?: boolean } = {}) {
  const frontierCalls: FrontierRequest[] = [];
  const quickCalls: string[] = [];
  const brains: BrainService = {
    async *persona() {
      if (opts.fail) throw new Error("persona down");
      yield "tsuki at 7:30, ";
      yield "want it on the calendar?";
    },
    async frontier(req) {
      frontierCalls.push(req);
      if (opts.fail) throw new Error("frontier down");
      if (req.goal.includes("Eve's planner"))
        return {
          ok: true,
          text: "",
          engine: "fake",
          ms: 1,
          json: { agents: [{ role: "MEMORY", goal: "recall taste" }, { role: "PLACES", goal: "find ramen" }, { role: "CALENDAR", goal: "free time" }, { role: "PLAN", goal: "decide" }], confidence: 0.8 },
        };
      return { ok: true, text: "", engine: "fake", ms: 1, json: RESTAURANTS };
    },
    async quickJson<T>(system: string) {
      quickCalls.push(system);
      if (opts.fail) throw new Error("quick down");
      if (system.includes("pick real restaurants")) return RESTAURANTS as T;
      if (system.includes("dinner preferences")) return { cuisine: "ramen", budget: "cheap", likes: ["spicy"], avoid: [] } as T;
      if (system.includes("approves a pending action")) return { decision: "yes" } as T;
      return null;
    },
    status: () => ({ fake: true }),
  };
  return { brains, frontierCalls, quickCalls };
}

function fakeSpeech() {
  const said: string[] = [];
  const speech: SpeechService = {
    async say(text) {
      let s = "";
      if (typeof text === "string") s = text;
      else for await (const c of text) s += c;
      said.push(s);
      return { utteranceId: `u${said.length}`, text: s };
    },
    stop() {},
    speaking: () => false,
  };
  return { speech, said };
}

function fakeMemory() {
  const written: string[] = [];
  const rec = (content: string): MemoryHit => ({ score: 0.9, record: { id: content, kind: "preference", content, importance: 0.8, confidence: 0.9, source: "seed", createdAt: 0 } });
  const memory: MemoryService = {
    async recall() {
      return [rec("likes spicy food"), rec("thinks $21 ramen is too expensive"), rec("saving money this month")];
    },
    async write(r) {
      written.push(r.content);
      return null;
    },
    async observe() {
      return [];
    },
    count: () => 3,
    all: () => [],
  };
  return { memory, written };
}

function firecrawlFetch(log: string[] = []) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    log.push(input);
    if (input.startsWith("https://api.firecrawl.dev/v2/search"))
      return Response.json({ success: true, data: { web: [{ title: "Tsuki Ramen Irvine", url: "https://tsuki.example", description: "spicy tonkotsu $12" }] } });
    if (input.startsWith("https://api.firecrawl.dev/v2/scrape")) {
      const b = JSON.parse(String(init?.body ?? "{}"));
      return Response.json({ success: true, data: { markdown: `# menu for ${b.url}`, json: { price: 21 }, metadata: { title: "Menya Tsuki", description: "ramen" } } });
    }
    return new Response("<html><head><title>Plain</title></head><body><main><h1>Menu</h1><p>Garlic ramen $21</p><script>evil()</script></main></body></html>");
  };
}

function harness(o: {
  demo?: boolean;
  timeoutMs?: number;
  budget?: number;
  brains?: BrainService | null;
  speech?: boolean;
  memory?: boolean;
  osaFail?: boolean;
  fetch?: AgencyDeps["fetch"];
  env?: Record<string, string>;
  harem?: HaremModule | null;
} = {}) {
  const bus = new EventBus(5000);
  const ctx = createContext(bus, { ...loadConfig(), demo: o.demo ?? true });
  const events: AnyEnvelope[] = [];
  bus.on("*", (e) => {
    events.push(e);
  });
  const osa = fakeOsa({ fail: o.osaFail });
  const sp = fakeSpeech();
  const mem = fakeMemory();
  if (o.brains) ctx.provide("brains", o.brains);
  if (o.speech !== false) ctx.provide("speech", sp.speech);
  if (o.memory) ctx.provide("memory", mem.memory);
  const opened: string[] = [];
  const env = o.env ?? {};
  const deps: Partial<AgencyDeps> = {
    osa: osa.run,
    fetch: o.fetch ?? firecrawlFetch(),
    openUrl: async (u) => {
      opened.push(u);
      return true;
    },
    openVisible: async () => false,
    loadHarem: async () => o.harem ?? null,
    now: () => NOW,
    env: (n) => env[n] ?? "",
  };
  const agency = createAgency(ctx, { deps, approvalTimeoutMs: o.timeoutMs ?? 400, budget: o.budget });
  const types = () => events.map((e) => e.type);
  const of = <K extends AnyEnvelope["type"]>(t: K) => events.filter((e) => e.type === t) as Extract<AnyEnvelope, { type: K }>[];
  /** Answer every approval request the moment it shows up. */
  const autoAnswer = (answer: { voice?: string; key?: string }) =>
    bus.on("action.request", (e) => {
      if (!e.data.needsApproval) return;
      setTimeout(() => {
        if (answer.voice) bus.emit("voice.final", { text: answer.voice }, "shell");
        if (answer.key) bus.emit("shell.key", { key: answer.key }, "shell");
      }, 5);
    });
  return { bus, ctx, agency, events, types, of, osa, said: sp.said, written: mem.written, opened, autoAnswer };
}

// ---------------------------------------------------------------------------
// Voice approvals
// ---------------------------------------------------------------------------

describe("voice approval classification", () => {
  test.each(["yeah", "Yes.", "do it", "lock it in", "bet", "go", "sure", "ok", "okay!", "yeah go ahead", "Yep, sounds good"])("%p is yes", (t) => {
    expect(classifyApproval(t)).toBe("yes");
  });
  test.each(["nah", "no", "wait", "stop", "hold on", "cancel", "nope", "not now", "don't do it", "not ok"])("%p is no", (t) => {
    expect(classifyApproval(t)).toBe("no");
  });
  test.each(["hmm what time is it", "", "no wait do it", "tell me more about the place"])("%p is unclear", (t) => {
    expect(classifyApproval(t)).toBeNull();
  });
  test("words inside other words don't count", () => {
    expect(classifyApproval("gopher snow")).toBeNull();
  });
  test("unclear replies fall back to the quick model", async () => {
    const b = fakeBrains();
    expect(await judgeApproval("i mean i guess that works", "book it", b.brains)).toBe("yes");
    expect(b.quickCalls.length).toBe(1);
    expect(await judgeApproval("yeah", "book it", b.brains)).toBe("yes");
    expect(b.quickCalls.length).toBe(1);
    expect(await judgeApproval("i mean i guess", "book it", null)).toBeNull();
    expect(await judgeApproval("i mean i guess", "book it", fakeBrains({ fail: true }).brains)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Permission gate
// ---------------------------------------------------------------------------

describe("permission gate", () => {
  test("READ runs on its own: policy approval, no question asked", async () => {
    const h = harness({ env: { FIRECRAWL_API_KEY: "fc-test" } });
    const r = await h.agency.gate.request("web.search", { query: "ramen irvine" });
    expect(r.ok).toBe(true);
    expect(r.observation).toContain("firecrawl");
    const req = h.of("action.request")[0]!;
    expect(req.data.permission).toBe("READ");
    expect(req.data.needsApproval).toBe(false);
    expect(h.of("action.approval")[0]!.data).toMatchObject({ approved: true, by: "policy" });
    expect(h.of("action.result")[0]!.data.actionId).toBe(req.data.actionId);
    expect(h.said).toEqual([]);
  });

  test("SAFE_ACTION runs on its own", async () => {
    const h = harness();
    const r = await h.agency.gate.request("browser.open", { url: "https://example.com/menu" });
    expect(r.ok).toBe(true);
    expect(h.opened).toEqual(["https://example.com/menu"]);
  });

  test("EXTERNAL_SIDE_EFFECT asks out loud, waits, runs on a spoken yes", async () => {
    const h = harness({ brains: fakeBrains().brains });
    h.autoAnswer({ voice: "yeah lock it in" });
    const r = await h.agency.gate.request("calendar.create_event", { title: "Tsuki Ramen", start: "19:30", durationMin: 90, location: "Irvine" });
    expect(r.ok).toBe(true);
    expect(r.observation).toContain("Eigenwife");
    expect(h.said.length).toBe(1);
    expect(h.said[0]).toContain("?");
    expect(h.of("action.request")[0]!.data).toMatchObject({ permission: "EXTERNAL_SIDE_EFFECT", needsApproval: true });
    expect(h.of("action.approval")[0]!.data).toMatchObject({ approved: true, by: "voice" });
    const create = h.osa.calls.find((c) => c.script === CREATE_EVENT_JXA)!;
    const payload = JSON.parse(create.args[0]!);
    expect(payload.start).toBe(at(19, 30));
    expect(payload.end).toBe(at(21));
    expect(h.ctx.world().slots.agency?.pending_approval).toBeUndefined();
  });

  test("a spoken no denies and nothing runs", async () => {
    const h = harness();
    h.autoAnswer({ voice: "nah wait" });
    const r = await h.agency.gate.request("calendar.create_event", { title: "x", start: "19:30" });
    expect(r.ok).toBe(false);
    expect(h.of("action.approval")[0]!.data).toMatchObject({ approved: false, by: "voice" });
    expect(h.osa.calls.length).toBe(0);
    expect(h.of("action.result")[0]!.data.ok).toBe(false);
  });

  test("the pending question is visible to prompts while it waits", async () => {
    const h = harness({ timeoutMs: 200 });
    const p = h.agency.gate.request("calendar.create_event", { title: "x", start: "19:30" });
    await Bun.sleep(20);
    expect(h.ctx.world().slots.agency?.pending_approval).toContain("calendar");
    await p;
  });

  test("silence past the timeout is a no", async () => {
    const h = harness({ timeoutMs: 60 });
    const r = await h.agency.gate.request("calendar.create_event", { title: "x", start: "19:30" });
    expect(r.ok).toBe(false);
    expect(r.observation).toContain("no answer");
    expect(h.of("action.approval")[0]!.data).toMatchObject({ approved: false, by: "policy" });
    expect(h.osa.calls.length).toBe(0);
  });

  test("operator keys: Enter approves, Escape denies", async () => {
    const yes = harness();
    yes.autoAnswer({ key: "Enter" });
    expect((await yes.agency.gate.request("calendar.create_event", { title: "x", start: "19:30" })).ok).toBe(true);
    expect(yes.of("action.approval")[0]!.data.by).toBe("key");
    const no = harness();
    no.autoAnswer({ key: "Escape" });
    expect((await no.agency.gate.request("calendar.create_event", { title: "x", start: "19:30" })).ok).toBe(false);
    // Arrow keys belong to the dating cards, not approvals.
    const arrows = harness({ timeoutMs: 80 });
    arrows.autoAnswer({ key: "ArrowRight" });
    expect((await arrows.agency.gate.request("calendar.create_event", { title: "x", start: "19:30" })).observation).toContain("no answer");
  });

  test("unrelated chatter doesn't settle it, an unclear reply goes to the model", async () => {
    const h = harness({ brains: fakeBrains().brains });
    h.autoAnswer({ voice: "i mean i guess that works" });
    const r = await h.agency.gate.request("calendar.create_event", { title: "x", start: "19:30" });
    expect(r.ok).toBe(true);
  });

  test("approvals are asked one at a time", async () => {
    const h = harness({ timeoutMs: 1000 });
    const a = h.agency.gate.request("calendar.create_event", { title: "a", start: "19:00" });
    const b = h.agency.gate.request("calendar.create_event", { title: "b", start: "20:00" });
    await Bun.sleep(20);
    expect(h.said.length).toBe(1);
    h.bus.emit("voice.final", { text: "yes" }, "shell");
    await a;
    await Bun.sleep(20);
    expect(h.said.length).toBe(2);
    h.bus.emit("voice.final", { text: "no" }, "shell");
    expect((await b).ok).toBe(false);
  });

  test("no speech service: still waits for approval, no crash", async () => {
    const h = harness({ speech: false });
    h.autoAnswer({ voice: "sure" });
    expect((await h.agency.gate.request("calendar.create_event", { title: "x", start: "19:30" })).ok).toBe(true);
  });

  test("deny list blocks apps whatever the class", async () => {
    const h = harness();
    for (const app of ["Terminal", "System Settings", "1Password 8"]) {
      const r = await h.agency.gate.request("app.quit", { app });
      expect(r.ok).toBe(false);
      expect(r.observation).toContain("deny list");
    }
    expect(h.osa.calls.length).toBe(0);
    expect(h.of("action.approval").every((e) => e.data.by === "policy" && !e.data.approved)).toBe(true);
  });

  test("app.quit only quits allowlisted apps", async () => {
    const h = harness();
    expect((await h.agency.gate.request("app.quit", { app: "spotify" })).observation).toBe("quit Spotify");
    expect(h.osa.calls[0]!.script).toBe(QUIT_APP_SCRIPT("Spotify"));
    expect((await h.agency.gate.request("app.quit", { app: "Finder" })).ok).toBe(false);
  });

  test("sending and buying are SENSITIVE and never auto, even if registered as safe", async () => {
    const h = harness({ timeoutMs: 50 });
    let ran = false;
    h.agency.gate.register({
      kind: "messages.send",
      permission: "SAFE_ACTION",
      describe: () => "text your mom",
      run: async () => {
        ran = true;
        return { ok: true, observation: "sent" };
      },
    });
    const r = await h.agency.gate.request("messages.send", { to: "mom" });
    expect(h.of("action.request")[0]!.data).toMatchObject({ permission: "SENSITIVE_ACTION", needsApproval: true });
    expect(r.ok).toBe(false);
    expect(ran).toBe(false);
  });

  test("per-session budget stops side effects but not reads", async () => {
    const h = harness({ budget: 2, env: { FIRECRAWL_API_KEY: "fc" } });
    expect((await h.agency.gate.request("shell.open", { scene: "desktop" })).ok).toBe(true);
    expect((await h.agency.gate.request("shell.close_app", {})).ok).toBe(true);
    const third = await h.agency.gate.request("browser.open", { url: "https://example.com" });
    expect(third.ok).toBe(false);
    expect(third.observation).toContain("budget");
    expect((await h.agency.gate.request("web.search", { query: "ramen" })).ok).toBe(true);
    expect(h.agency.gate.policy.used()).toBe(2);
  });

  test("unknown actions fail cleanly", async () => {
    const h = harness();
    const r = await h.agency.gate.request("rocket.launch", {});
    expect(r.ok).toBe(false);
    expect(h.types()).toEqual(["action.request", "action.approval", "action.result"]);
  });

  test("full trace of every step", async () => {
    const h = harness();
    h.autoAnswer({ voice: "do it" });
    await h.agency.gate.request("calendar.create_event", { title: "x", start: "19:30" });
    const t = h.agency.gate.trace[0]!;
    expect(t.kind).toBe("calendar.create_event");
    expect(t.decision).toMatchObject({ approved: true, by: "voice" });
    expect(t.result?.ok).toBe(true);
  });

  test("external action.request (harem) goes through the same gate with its own id", async () => {
    const h = harness();
    h.autoAnswer({ voice: "bet" });
    const e = h.bus.emit(
      "action.request",
      { actionId: "act_harem1", taskId: "t1", kind: "calendar.create", permission: "READ", description: "put Tsuki at 19:30 on the calendar", args: { title: "Tsuki (tonkotsu)", start: "19:30", durationMin: 90, location: "Tsuki" }, needsApproval: false },
      "harem",
    );
    const result = await h.bus.once("action.result", (x) => x.data.actionId === "act_harem1", 2000);
    expect(result?.data.ok).toBe(true);
    // Their READ claim didn't downgrade the gate: we corrected it on the bus under the same id.
    const reqs = h.of("action.request");
    expect(reqs.length).toBe(2);
    expect(reqs[0]!.id).toBe(e.id);
    expect(reqs[1]!.data).toMatchObject({ actionId: "act_harem1", permission: "EXTERNAL_SIDE_EFFECT", needsApproval: true });
    expect(reqs[1]!.source).toBe("agency");
    expect(h.of("action.approval")[0]!.data).toMatchObject({ actionId: "act_harem1", approved: true, by: "voice" });
    expect(h.agency.gate.trace[0]!.permission).toBe("EXTERNAL_SIDE_EFFECT");
    expect(h.agency.gate.trace[0]!.requestedBy).toBe("harem");
  });

  test("an honest external request is not re-emitted", async () => {
    const h = harness();
    h.autoAnswer({ voice: "yes" });
    h.bus.emit(
      "action.request",
      { actionId: "act_h2", kind: "calendar.create", permission: "EXTERNAL_SIDE_EFFECT", description: "put Tsuki at 19:30 on the calendar", args: { title: "Tsuki", start: "19:30" }, needsApproval: true },
      "harem",
    );
    expect((await h.bus.once("action.result", (x) => x.data.actionId === "act_h2", 2000))?.data.ok).toBe(true);
    expect(h.of("action.request").length).toBe(1);
  });

  test("someone else's action.approval for the pending id settles it", async () => {
    const h = harness();
    h.bus.on("action.request", (e) => {
      if (e.data.needsApproval) setTimeout(() => h.bus.emit("action.approval", { actionId: e.data.actionId, approved: true, by: "key" }, "shell"), 5);
    });
    expect((await h.agency.gate.request("calendar.create_event", { title: "x", start: "19:30" })).ok).toBe(true);
    // Only the shell's approval is on the bus, we didn't echo one.
    expect(h.of("action.approval").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

describe("actions", () => {
  test("calendar data only ever travels as argv JSON, never inside the script", async () => {
    const h = harness();
    h.autoAnswer({ voice: "yes" });
    const evil = 'x" & (do shell script "rm -rf ~") & "';
    await h.agency.gate.request("calendar.create_event", { title: evil, start: "19:30", notes: "`${process.exit()}`\n})();" });
    const call = h.osa.calls.find((c) => c.script === CREATE_EVENT_JXA)!;
    expect(call.lang).toBe("JavaScript");
    expect(call.script).not.toContain("rm -rf");
    expect(JSON.parse(call.args[0]!).title).toBe(evil);
  });

  test("calendar.free_busy finds tonight's gap and survives a slow calendar", async () => {
    const h = harness();
    const r = await h.agency.gate.request("calendar.free_busy", { from: at(18), until: at(23, 30), needMin: 90 });
    expect(r.ok).toBe(true);
    const d = r.data as { freeFrom: number; skipped: string[]; busy: unknown[] };
    expect(d.freeFrom).toBe(at(19, 30));
    expect(d.skipped).toEqual(["Slow"]);
    expect(r.observation).toContain("gym");
  });

  test("calendar failures come back as observations", async () => {
    const h = harness({ osaFail: true });
    h.autoAnswer({ voice: "yes" });
    const r = await h.agency.gate.request("calendar.create_event", { title: "x", start: "19:30" });
    expect(r.ok).toBe(false);
    expect(r.observation).toContain("not allowed");
    expect((await h.agency.gate.request("calendar.free_busy", {})).ok).toBe(false);
  });

  test("browser.open refuses non-web urls", async () => {
    const h = harness();
    expect((await h.agency.gate.request("browser.open", { url: "file:///etc/passwd" })).ok).toBe(false);
    expect((await h.agency.gate.request("browser.open", { url: "javascript:alert(1)" })).ok).toBe(false);
    expect(h.opened).toEqual([]);
    expect(safeUrl("https://a.com/x?y=1")).toBe("https://a.com/x?y=1");
  });

  test("shell.close_app closes the Eigen window and sends the shell back to the desktop", async () => {
    const h = harness();
    const keys: string[] = [];
    h.ctx.bus.on("shell.key", (e) => keys.push(e.data.key));
    await h.agency.gate.request("shell.close_app", { app: "Eigen" });
    expect(keys).toContain("eigen.close");
    expect(h.ctx.world().scene).toBe("desktop");
  });

  test("web.scrape uses Firecrawl with a key, plain fetch without", async () => {
    const withKey = harness({ env: { FIRECRAWL_API_KEY: "fc" } });
    const a = (await withKey.agency.gate.request("web.scrape", { url: "https://menya.example", schema: { type: "object" } })).data as { via: string; json: unknown };
    expect(a.via).toBe("firecrawl");
    expect(a.json).toEqual({ price: 21 });
    const noKey = harness();
    const b = (await noKey.agency.gate.request("web.scrape", { url: "https://menya.example" })).data as { via: string; markdown: string; title: string };
    expect(b.via).toBe("fetch");
    expect(b.title).toBe("Plain");
    expect(b.markdown).toContain("Garlic ramen $21");
    expect(b.markdown).not.toContain("evil");
  });

  test("web.search degrades: firecrawl, then duckduckgo, then the frontier brain", async () => {
    const ddgHtml = `<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Framen.example%2F&amp;rut=x">Cheap <b>Ramen</b></a><a class="result__snippet" href="#">spicy &amp; cheap</a>`;
    const ddg = harness({ fetch: async (u) => (u.includes("duckduckgo") ? new Response(ddgHtml) : new Response("", { status: 500 })) });
    const r = await ddg.agency.gate.request("web.search", { query: "ramen" });
    expect(r.observation).toContain("duckduckgo");
    const b = fakeBrains();
    b.brains.frontier = async () => ({ ok: true, text: "", engine: "fake", ms: 1, json: { results: [{ title: "T", url: "https://t.example", description: "d" }] } });
    const brain = harness({ brains: b.brains, fetch: async () => new Response("", { status: 500 }) });
    expect((await brain.agency.gate.request("web.search", { query: "ramen" })).observation).toContain("frontier");
    const none = harness({ fetch: async () => new Response("", { status: 500 }) });
    expect((await none.agency.gate.request("web.search", { query: "ramen" })).ok).toBe(false);
  });

  test("places.search extracts, ranks cheap + spicy first", async () => {
    const h = harness({ brains: fakeBrains().brains, env: { FIRECRAWL_API_KEY: "fc" } });
    const r = await h.agency.gate.request("places.search", { prefs: { cuisine: "ramen", budget: "cheap", likes: ["spicy"] }, location: "Irvine, CA" });
    const places = (r.data as { places: { name: string }[] }).places;
    expect(places[0]!.name).toBe("Tsuki Ramen");
    expect(r.observation).toContain("firecrawl+extract");
  });

  test("GET /api/page/scrape enriches gaze targets", async () => {
    const bus = new EventBus();
    const ctx = createContext(bus, loadConfig());
    const m = agencyModule({ watcher: false, deps: { fetch: firecrawlFetch(), env: () => "" } });
    await m.start(ctx);
    const handler = ctx.routes.get("/api/page/scrape")!;
    const url = new URL("http://x/api/page/scrape?url=https%3A%2F%2Fmenya.example");
    const res = (await handler(new Request(url), url))!;
    const j = (await res.json()) as { ok: boolean; title: string };
    expect(j.ok).toBe(true);
    expect(j.title).toBe("Plain");
    const bad = new URL("http://x/api/page/scrape?url=file:///etc/passwd");
    expect((await handler(new Request(bad), bad))!.status).toBe(400);
    expect(ctx.use("agency")).toBeTruthy();
    await m.stop?.();
  });
});

// ---------------------------------------------------------------------------
// runTask
// ---------------------------------------------------------------------------

describe("runTask", () => {
  test("built-in swarm: plan, parallel agents, approval beat, calendar, done", async () => {
    const b = fakeBrains();
    const h = harness({ brains: b.brains, memory: true, env: { FIRECRAWL_API_KEY: "fc", EIGEN_LOCATION: "Irvine, CA" }, timeoutMs: 2000 });
    h.autoAnswer({ voice: "lock it in" });
    const out = await h.agency.runTask("actually just figure out tonight");
    expect(out.ok).toBe(true);
    expect(out.summary).toContain("7:30");
    expect(out.summary).toContain("Tsuki Ramen");
    expect(out.summary).toContain("$12");
    expect(out.summary).toContain("On your calendar");

    const t = h.types();
    const idx = (type: string, from = 0) => t.indexOf(type as never, from);
    expect(idx("task.start")).toBe(0);
    expect(idx("swarm.plan")).toBeGreaterThan(0);
    expect(idx("swarm.spawn")).toBeGreaterThan(idx("swarm.plan"));
    expect(idx("swarm.progress")).toBeGreaterThan(idx("swarm.spawn"));
    expect(idx("swarm.done")).toBeGreaterThan(idx("swarm.progress"));
    const booking = h.of("action.request").find((e) => e.data.kind === "calendar.create_event")!;
    const bookingAt = h.events.indexOf(booking);
    expect(bookingAt).toBeGreaterThan(t.lastIndexOf("swarm.done"));
    const approval = h.events.findIndex((e) => e.type === "action.approval" && e.data.actionId === booking.data.actionId);
    const result = h.events.findIndex((e) => e.type === "action.result" && e.data.actionId === booking.data.actionId);
    expect(approval).toBeGreaterThan(bookingAt);
    expect(result).toBeGreaterThan(approval);
    expect(t.at(-1)).toBe("task.done");
    expect(h.of("task.done").length).toBe(1);

    expect(new Set(h.of("swarm.spawn").map((e) => e.data.label))).toEqual(new Set(["MEMORY", "PLACES", "CALENDAR", "PLAN"]));
    const progress = h.of("swarm.progress").map((e) => e.data.text);
    expect(progress.some((p) => p.includes("spicy"))).toBe(true);
    expect(progress.some((p) => p.startsWith("comparing"))).toBe(true);
    expect(h.of("swarm.merge")[0]!.data.retained[0]).toContain("Tsuki Ramen");
    expect(h.said.length).toBe(1);
    expect(h.written[0]).toContain("Tsuki Ramen");
    expect(h.ctx.world().tasks).toEqual({ active: 0, done: 1 });

    const payload = JSON.parse(h.osa.calls.find((c) => c.script === CREATE_EVENT_JXA)!.args[0]!);
    expect(payload.start).toBe(at(19, 30));
    expect(payload.calendar).toBe("Eigenwife");
  });

  test("a no at the approval beat still ends with a plan", async () => {
    const h = harness({ brains: fakeBrains().brains, memory: true, env: { FIRECRAWL_API_KEY: "fc" }, timeoutMs: 2000 });
    h.autoAnswer({ voice: "nah" });
    const out = await h.agency.runTask("figure out tonight");
    expect(out.ok).toBe(true);
    expect(out.summary).toContain("Not on your calendar");
    expect(h.osa.calls.some((c) => c.script === CREATE_EVENT_JXA)).toBe(false);
  });

  test("delegates to harem when installed, and doesn't double-emit task.done", async () => {
    let got: { goal: string; hasBrain: boolean } | null = null;
    class ScriptedBrain {
      name = "scripted";
      constructor(public scripts: unknown) {}
      async structured<T>(): Promise<T> {
        return {} as T;
      }
    }
    const harem: HaremModule = {
      ScriptedBrain,
      DEMO_SCRIPTS: { food: {} },
      async executeWithHarem(task, deps) {
        got = { goal: task.goal, hasBrain: deps.brain instanceof ScriptedBrain };
        expect(typeof deps.schedule).toBe("function");
        deps.bus.emit("task.done", { taskId: task.taskId, ok: true, summary: "7:30 at Tsuki. Done.", ms: 1 }, "harem");
        return { ok: true, summary: "7:30 at Tsuki. Done." };
      },
    };
    const h = harness({ harem, brains: fakeBrains().brains });
    const out = await h.agency.runTask("figure out tonight");
    expect(out).toEqual({ ok: true, summary: "7:30 at Tsuki. Done." });
    expect(got!).toEqual({ goal: "figure out tonight", hasBrain: true });
    expect(h.of("task.start")[0]!.data.brain).toBe("harem");
    expect(h.of("task.done").length).toBe(1);
    expect(h.of("swarm.plan").length).toBe(0);
  });

  test("outside demo mode harem gets the frontier brain adapter", async () => {
    let brainName = "";
    const harem: HaremModule = {
      async executeWithHarem(task, deps) {
        brainName = deps.brain?.name ?? "";
        const json = await deps.brain!.structured<{ agents: unknown[] }>({ agent: "planner", system: "s", prompt: "Eve's planner", schema: {} });
        expect(Array.isArray(json.agents)).toBe(true);
        return { ok: true, summary: "ok" };
      },
    };
    const h = harness({ harem, demo: false, brains: fakeBrains().brains });
    await h.agency.runTask("figure out tonight");
    expect(brainName).toBe("frontier");
  });

  test("harem throwing falls back to the built-in planner, same task", async () => {
    const harem: HaremModule = {
      async executeWithHarem() {
        throw new Error("harem exploded");
      },
    };
    const h = harness({ harem, brains: fakeBrains().brains, memory: true, env: { FIRECRAWL_API_KEY: "fc" }, timeoutMs: 2000 });
    h.autoAnswer({ voice: "yes" });
    const out = await h.agency.runTask("figure out tonight");
    expect(out.ok).toBe(true);
    expect(out.summary).toContain("Tsuki Ramen");
    const start = h.of("task.start");
    expect(start.length).toBe(1);
    expect(h.of("task.done")[0]!.data.taskId).toBe(start[0]!.data.taskId);
    expect(h.of("swarm.spawn")[0]!.data.taskId).toBe(start[0]!.data.taskId);
  });

  test("demo fallback: every brain, the web and Calendar down, still a plan", async () => {
    const h = harness({ brains: fakeBrains({ fail: true }).brains, fetch: async () => new Response("", { status: 500 }), osaFail: true, timeoutMs: 2000 });
    h.autoAnswer({ voice: "yeah" });
    const out = await h.agency.runTask("I have no idea what I'm doing tonight");
    expect(out.ok).toBe(true);
    expect(out.summary).toContain("Kitakata Ramen Ban Nai");
    expect(out.summary).toContain("7:30");
    expect(out.summary).toContain("Not on your calendar");
    expect(h.of("task.done").length).toBe(1);
    // Her confirm question fell back to plain text when the persona brain was down.
    expect(h.said[0]).toContain("yeah?");
  });

  test("no brains at all in demo mode: default plan, canned places", async () => {
    const h = harness({ brains: null, fetch: async () => new Response("", { status: 500 }), timeoutMs: 2000 });
    h.autoAnswer({ voice: "do it" });
    const out = await h.agency.runTask("figure out tonight");
    expect(out.ok).toBe(true);
    expect(out.summary).toContain("On your calendar");
    expect(h.of("swarm.spawn").length).toBe(4);
  });

  test("outside demo mode an empty search is an honest failure, not a hang", async () => {
    const h = harness({ demo: false, brains: null, fetch: async () => new Response("", { status: 500 }), timeoutMs: 100 });
    const out = await h.agency.runTask("figure out tonight");
    expect(out.ok).toBe(false);
    expect(out.summary).toContain("Couldn't find");
    expect(h.of("task.done")[0]!.data.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("helpers", () => {
  test("AppleScript strings are injection safe", () => {
    expect(appleScriptString('a"b\\c')).toBe('"a\\"b\\\\c"');
    const evil = 'Spotify"\ndo shell script "rm -rf ~"\n"';
    const q = appleScriptString(evil);
    expect(q).not.toContain("\n");
    expect(q).not.toContain("\r");
    // Every quote inside is escaped, so the literal can't close early.
    expect(q.slice(1, -1).replace(/\\\\/g, "").match(/(?<!\\)"/g)).toBeNull();
    expect(appleScriptString("x y\ru")).toBe('"x y u"');
    expect(QUIT_APP_SCRIPT('Spo"tify')).toContain('application "Spo\\"tify"');
  });

  test("JXA literals escape line separators", () => {
    expect(jxaLiteral("a b")).toBe('"a\\u2028b"');
    expect(JSON.parse(jxaLiteral({ t: '"</script>' }))).toEqual({ t: '"</script>' });
  });

  test("parseStart handles clock times and ISO", () => {
    expect(parseStart("19:30", NOW)).toBe(at(19, 30));
    expect(parseStart("7:30pm", NOW)).toBe(at(19, 30));
    expect(parseStart("7pm", NOW)).toBe(at(19));
    expect(parseStart("12am", NOW)).toBe(at(0));
    expect(parseStart(new Date(at(20)).toISOString(), NOW)).toBe(at(20));
    expect(parseStart("25:00", NOW)).toBeNull();
    expect(parseStart("whenever", NOW)).toBeNull();
  });

  test("firstFreeSlot skips busy blocks", () => {
    const busy = [{ title: "a", start: at(19), end: at(20) }];
    expect(firstFreeSlot(busy, at(18, 50), at(23), 60)).toBe(at(20));
    expect(firstFreeSlot([], at(19, 10), at(23), 90)).toBe(at(19, 30));
    expect(firstFreeSlot(busy, at(19), at(20, 30), 90)).toBeNull();
  });

  test("htmlToText keeps content, drops chrome", () => {
    const r = htmlToText(`<title>Menya &amp; Co</title><meta name="description" content="ramen"><body><nav>skip</nav><h2>Spicy</h2><ul><li>Miso $14</li></ul></body>`);
    expect(r.title).toBe("Menya & Co");
    expect(r.description).toBe("ramen");
    expect(r.markdown).toContain("## Spicy");
    expect(r.markdown).toContain("- Miso $14");
    expect(r.markdown).not.toContain("skip");
  });

  test("parseDuckDuckGo unwraps redirect links", () => {
    const hits = parseDuckDuckGo(`<a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2Fx&rut=1">A <b>ramen</b></a>`);
    expect(hits).toEqual([{ url: "https://a.example/x", title: "A ramen", description: "" }]);
  });

  test("normalizePlan keeps known roles, always has PLACES and PLAN", () => {
    expect(normalizePlan({ agents: [{ role: "memory", goal: "x" }, { role: "HACKER" }, { role: "memory" }] })!.map((s) => s.role)).toEqual(["PLACES", "MEMORY", "PLAN"]);
    expect(normalizePlan("nonsense")).toBeNull();
  });
});
