import { describe, expect, test } from "bun:test";
import { agentGlideMs, type AnyEnvelope, type ScreenRect } from "@eigenwife/protocol";
import { EventBus } from "../src/bus";
import { loadConfig } from "../src/config";
import { createContext } from "../src/context";
import { lookAroundSteps, mapsSearchUrl, normalizeSteps, placeSteps, rememberPlace, stepsFor } from "../src/agency/actions/browser";
import { PLAY_SCRIPT } from "../src/agency/actions/music";
import { soundsConsequential, type BrowserBackend, type BrowserPage, type Located, type Target } from "../src/agency/browser/driver";
import { addressBarPoint, aimPoint, chromeOffset, leftHalf, pageToScreen, pageZoom, shotToScreen, type PageMetrics } from "../src/agency/browser/geometry";
import { AgentCursor, CURSOR_CLIENT, nativeTargetFrom, WINDOW_BOUNDS_JXA } from "../src/agency/cursor";
import { createAgency } from "../src/agency/module";
import type { OsaRunner } from "../src/agency/osa";
import type { AgencyDeps } from "../src/agency/types";
import { readBrowse, readIntent } from "../src/reflex/intent";

process.env.EIGEN_QUIET = "1";

// A 720x956 window at (0, 33) on a 2x display: 87pt of tab strip + toolbar.
const M: PageMetrics = { screenX: 0, screenY: 33, outerWidth: 735, outerHeight: 923, innerWidth: 735, innerHeight: 836, devicePixelRatio: 2 };

describe("page -> screen mapping", () => {
  test("chrome offset is calibrated from outer - inner", () => {
    expect(chromeOffset(M)).toEqual({ left: 0, top: 87 });
    expect(pageToScreen(M, { x: 100, y: 200 })).toEqual({ x: 100, y: 33 + 87 + 200 });
  });

  test("window position moves everything", () => {
    const moved = { ...M, screenX: 400, screenY: 120 };
    expect(pageToScreen(moved, { x: 10, y: 10 })).toEqual({ x: 410, y: 120 + 87 + 10 });
  });

  test("page zoom from devicePixelRatio: css px scale, chrome stays the same size", () => {
    // 150% zoom on a 2x display: dpr 3, inner size in css px shrinks by 1.5.
    const z: PageMetrics = { ...M, devicePixelRatio: 3, innerWidth: 490, innerHeight: 836 / 1.5 };
    expect(pageZoom(z, 2)).toBeCloseTo(1.5, 6);
    expect(chromeOffset(z, 1.5).top).toBeCloseTo(87, 6);
    const p = pageToScreen(z, { x: 100, y: 100 }, 2);
    expect(p.x).toBeCloseTo(150, 6);
    expect(p.y).toBeCloseTo(33 + 87 + 150, 6);
    // Same element at 100% on a 1x display maps without scaling.
    const oneX: PageMetrics = { ...M, devicePixelRatio: 1 };
    expect(pageToScreen(oneX, { x: 100, y: 100 }, 1)).toEqual({ x: 100, y: 220 });
  });

  test("side borders split evenly (non-mac chrome)", () => {
    const win: PageMetrics = { ...M, outerWidth: 751, innerWidth: 735, outerHeight: 931 };
    expect(chromeOffset(win)).toEqual({ left: 8, top: 931 - 836 - 8 });
    expect(pageToScreen(win, { x: 0, y: 0 }).x).toBe(8);
  });

  test("screenshot pixels are device px: divide by dpr first", () => {
    expect(shotToScreen(M, { x: 200, y: 400 })).toEqual(pageToScreen(M, { x: 100, y: 200 }));
  });

  test("address bar sits in the toolbar row, left half is the left half", () => {
    const a = addressBarPoint(M);
    expect(a.y).toBeGreaterThan(33);
    expect(a.y).toBeLessThan(33 + 87);
    expect(a.x).toBeGreaterThan(100);
    expect(leftHalf({ x: 0, y: 33, width: 1470, height: 923 })).toEqual({ x: 0, y: 33, width: 735, height: 923 });
    expect(leftHalf({ x: 0, y: 25, width: 1000, height: 700 }).width).toBe(640);
    expect(aimPoint({ x: 0, y: 0, width: 100, height: 40 }).y).toBe(20);
  });
});

describe("native targets (window bounds only)", () => {
  test("biggest window center-ish, else the Dock", () => {
    const displays: ScreenRect[] = [{ x: 0, y: 0, width: 1470, height: 956 }];
    const w = nativeTargetFrom({ window: { x: 100, y: 100, width: 800, height: 600 }, displays });
    expect(w?.kind).toBe("window");
    expect(w?.point.x).toBe(500);
    expect(w!.point.y).toBeGreaterThan(100);
    expect(w!.point.y).toBeLessThan(400);
    const dock = nativeTargetFrom({ window: null, displays });
    expect(dock).toEqual({ kind: "dock", point: { x: 735, y: 956 - 34 } });
    expect(nativeTargetFrom(null)).toBeNull();
  });

  test("the JXA reads bounds and owners, never window titles or pixels", () => {
    expect(WINDOW_BOUNDS_JXA).toContain("kCGWindowBounds");
    expect(WINDOW_BOUNDS_JXA).toContain("kCGWindowOwnerName");
    expect(WINDOW_BOUNDS_JXA).not.toContain("kCGWindowName");
    expect(WINDOW_BOUNDS_JXA).not.toMatch(/CGWindowListCreateImage|CGDisplayCreateImage|screencapture/);
    // Never posts input: no mouse events anywhere in the cursor code path.
    expect(WINDOW_BOUNDS_JXA).not.toMatch(/CGEventPost|CGWarpMouse|CGEventCreateMouse/);
  });
});

function cursorBus() {
  const bus = new EventBus(5000);
  const events: AnyEnvelope[] = [];
  bus.on("*", (e) => {
    events.push(e);
  });
  const slept: number[] = [];
  const cursor = new AgentCursor(bus, { sleep: async (ms) => void slept.push(ms), idleAfterMs: 5 });
  return { bus, events, slept, cursor, cur: () => events.filter((e) => e.type === "agent.cursor").map((e) => e.data as { action: string; x: number; y: number; ms?: number; label?: string }) };
}

describe("AgentCursor", () => {
  test("move waits for the glide, click lands where it arrived, then idles", async () => {
    const h = cursorBus();
    await h.cursor.move({ x: 100, y: 100 }, { label: "Menu" });
    await h.cursor.move({ x: 900, y: 500 });
    h.cursor.click({ label: "Menu" });
    h.cursor.settle();
    await Bun.sleep(20);
    const c = h.cur();
    expect(c.map((x) => x.action)).toEqual(["move", "move", "click", "idle"]);
    expect(c[1]!.ms).toBe(agentGlideMs({ x: 100, y: 100 }, { x: 900, y: 500 }));
    expect(h.slept).toEqual([c[0]!.ms!, c[1]!.ms!]);
    expect(c[2]).toMatchObject({ x: 900, y: 500, label: "Menu" });
    expect(h.events.every((e) => e.type !== "agent.cursor" || (e.data as { space: string }).space === "screen")).toBe(true);
  });

  test("watching = the cursor layer said hello", () => {
    const h = cursorBus();
    expect(h.cursor.watching()).toBe(false);
    h.bus.emit("bus.hello", { client: "shell", role: "shell", version: "1" }, "shell");
    expect(h.cursor.watching()).toBe(false);
    h.bus.emit("bus.hello", { client: CURSOR_CLIENT, role: "observer", version: "1" }, "overlay");
    expect(h.cursor.watching()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fake browser
// ---------------------------------------------------------------------------

interface FakeEl {
  box: { x: number; y: number; width: number; height: number };
  label: string;
  submits?: boolean;
  post?: boolean;
}

function fakeBackend(els: Record<string, FakeEl>, log: string[]) {
  let open = false;
  const closed: (() => void)[] = [];
  const key = (t: Target) => t.selector ?? t.text ?? "";
  let url = "about:blank";
  const page: BrowserPage = {
    async goto(u) {
      log.push(`goto ${u}`);
      url = u;
    },
    url: () => url,
    metrics: async () => M,
    async locate(t): Promise<Located | null> {
      const e = els[key(t)];
      return e ? { box: e.box, submits: !!e.submits, label: e.label } : null;
    },
    async click(t) {
      log.push(`click ${key(t)}`);
    },
    async type(t, text, o) {
      log.push(`type ${key(t)} ${text}${o.enter ? " +enter" : ""}`);
    },
    async wheel(_at, dy) {
      log.push(`wheel ${dy}`);
    },
    read: async () => ({ title: "Tsuki Ramen", url, text: "Hours 11-10. Spicy tonkotsu $12" }),
    screenshot: async () => new Uint8Array([137, 80, 78, 71]),
    enterSubmits: async (t) => !!els[key(t)]?.post,
  };
  const backend: BrowserBackend = {
    async launch() {
      log.push("launch");
      open = true;
      return { page, avail: { x: 0, y: 33, width: 1470, height: 923 } };
    },
    async setBounds(r) {
      log.push(`bounds ${r.x},${r.y},${r.width}x${r.height}`);
    },
    async close() {
      open = false;
      log.push("close");
      for (const c of closed) c();
    },
    isOpen: () => open,
    onClosed: (cb) => void closed.push(cb),
  };
  return backend;
}

const ELS: Record<string, FakeEl> = {
  Menu: { box: { x: 200, y: 300, width: 80, height: 30 }, label: "Menu" },
  Hours: { box: { x: 40, y: 500, width: 120, height: 24 }, label: "Hours" },
  "#q": { box: { x: 100, y: 60, width: 400, height: 40 }, label: "Search" },
  "#name": { box: { x: 100, y: 120, width: 300, height: 36 }, label: "Name", post: true },
  "Book now": { box: { x: 300, y: 600, width: 140, height: 44 }, label: "Book now", submits: true },
};

function harness(o: { env?: Record<string, string>; osa?: OsaRunner; timeoutMs?: number } = {}) {
  const bus = new EventBus(5000);
  const ctx = createContext(bus, { ...loadConfig(), demo: true });
  const events: AnyEnvelope[] = [];
  const log: string[] = [];
  bus.on("*", (e) => {
    events.push(e);
    if (e.type === "agent.cursor") log.push(`cursor ${e.data.action}${e.data.label ? ` ${e.data.label}` : ""}`);
  });
  const env = o.env ?? {};
  const osaCalls: string[] = [];
  const deps: Partial<AgencyDeps> = {
    osa:
      o.osa ??
      (async (script) => {
        osaCalls.push(script);
        log.push(script === WINDOW_BOUNDS_JXA ? "osa bounds" : "osa action");
        if (script === WINDOW_BOUNDS_JXA) return { ok: true, stdout: JSON.stringify({ window: { x: 800, y: 80, width: 600, height: 500 }, displays: [{ x: 0, y: 0, width: 1470, height: 956 }] }), stderr: "", code: 0 };
        return { ok: true, stdout: "GGEZ by Someone", stderr: "", code: 0 };
      }),
    loadHarem: async () => null,
    now: () => Date.now(),
    env: (n) => env[n] ?? "",
    openUrl: async () => true,
    fetch: async () => new Response("", { status: 503 }),
    browserBackend: () => fakeBackend(ELS, log),
    sleep: async () => {},
  };
  const agency = createAgency(ctx, { deps, approvalTimeoutMs: o.timeoutMs ?? 300 });
  const of = <K extends AnyEnvelope["type"]>(t: K) => events.filter((e) => e.type === t) as Extract<AnyEnvelope, { type: K }>[];
  return { bus, ctx, agency, events, log, of, osaCalls };
}

describe("eve.browser driver + browser.task", () => {
  test("opens on the left half, glides before every click and keystroke", async () => {
    const h = harness();
    const r = await h.agency.gate.request("browser.task", {
      steps: [{ op: "open", url: "https://tsuki.example" }, { op: "click", text: "Menu" }, { op: "type", selector: "#q", value: "spicy" }, { op: "scroll", dy: 400 }, { op: "read" }],
    });
    expect(r.ok).toBe(true);
    const L = h.log;
    expect(L.slice(0, 2)).toEqual(["launch", "bounds 0,33,735x923"]);
    const open = h.of("agent.browser")[0]!;
    expect(open.data).toMatchObject({ status: "open", bounds: { x: 0, y: 33, width: 735, height: 923 } });
    // open: glide to the address bar, click it, "type" the url, then navigate.
    const iGoto = L.indexOf("goto https://tsuki.example/");
    expect(L.slice(iGoto - 3, iGoto)).toEqual(["cursor move address bar", "cursor click address bar", "cursor type tsuki.example"]);
    // click: move precedes the cursor click, which precedes the real click.
    const iClick = L.indexOf("click Menu");
    expect(L.slice(iClick - 2, iClick)).toEqual(["cursor move Menu", "cursor click Menu"]);
    // type: glide, click into the field, type animation, then the keys.
    const iType = L.indexOf("type #q spicy");
    expect(L.slice(iType - 3, iType)).toEqual(["cursor move Search", "cursor click Search", 'cursor type "spicy"']);
    expect(L.indexOf("cursor scroll down")).toBeLessThan(L.indexOf("wheel 400"));
    // The Menu click glided to the element's real screen spot.
    const menuMove = h.of("agent.cursor").find((e) => e.data.action === "move" && e.data.label === "Menu")!;
    const want = pageToScreen(M, aimPoint(ELS.Menu!.box));
    expect(menuMove.data.x).toBe(Math.round(want.x));
    expect(menuMove.data.y).toBe(Math.round(want.y));
    const data = r.data as { trace: { op: string; ok: boolean }[]; reads: { title: string }[] };
    expect(data.trace.map((t) => t.op)).toEqual(["open", "click", "type", "scroll", "read"]);
    expect(data.reads[0]!.title).toBe("Tsuki Ramen");
    expect(r.observation).toContain("browsed");
    // SAFE_ACTION: no approval asked.
    expect(h.of("action.request").find((e) => e.data.kind === "browser.task")?.data.needsApproval).toBe(false);
  });

  test("step budget: extra steps are dropped and reported", async () => {
    const h = harness();
    const steps = Array.from({ length: 9 }, () => ({ op: "scroll", dy: 100 }));
    const r = await h.agency.gate.request("browser.task", { steps, budget: 4 });
    const data = r.data as { trace: unknown[]; truncated: number };
    expect(data.trace.length).toBe(4);
    expect(data.truncated).toBe(5);
    expect(r.observation).toContain("5 steps over budget");
  });

  test("optional steps that miss are skipped, required ones stop the run", async () => {
    const h = harness();
    const ok = await h.agency.gate.request("browser.task", { steps: [{ op: "click", text: "Reservations", optional: true }, { op: "click", text: "Hours" }] });
    expect(ok.ok).toBe(true);
    const bad = await h.agency.gate.request("browser.task", { steps: [{ op: "click", text: "Nope" }, { op: "click", text: "Hours" }] });
    expect(bad.ok).toBe(false);
    expect(bad.observation).toContain('couldn\'t find "Nope"');
  });

  test("submitting stops and asks: no yes, no click", async () => {
    const h = harness({ timeoutMs: 200 });
    const r = await h.agency.gate.request("browser.task", { steps: [{ op: "click", text: "Menu" }, { op: "click", text: "Book now" }], goal: "book tsuki" });
    expect(r.ok).toBe(false);
    expect(h.log).not.toContain("click Book now");
    const sub = h.of("action.request").find((e) => e.data.kind === "browser.submit")!;
    expect(sub.data.permission).toBe("EXTERNAL_SIDE_EFFECT");
    expect(sub.data.needsApproval).toBe(true);
    // The cursor went to the button and hovered there while she asked.
    expect(h.log).toContain("cursor move wait: Book now");
  });

  test("submitting with a spoken yes clicks it", async () => {
    const h = harness({ timeoutMs: 2000 });
    h.bus.on("action.request", (e) => {
      if (e.data.needsApproval) setTimeout(() => h.bus.emit("voice.final", { text: "yeah do it" }, "shell"), 5);
    });
    const r = await h.agency.gate.request("browser.task", { steps: [{ op: "click", text: "Book now" }] });
    expect(r.ok).toBe(true);
    const i = h.log.indexOf("click Book now");
    expect(i).toBeGreaterThan(0);
    expect(h.log.slice(i - 2, i)).toEqual(["cursor move Book now", "cursor click Book now"]);
    expect(h.of("action.approval").some((e) => e.data.by === "voice" && e.data.approved)).toBe(true);
  });

  test("Enter in a POST form is a submit; Enter in a search box is browsing", async () => {
    const h = harness({ timeoutMs: 150 });
    const search = await h.agency.gate.request("browser.task", { steps: [{ op: "type", selector: "#q", value: "ramen", enter: true }] });
    expect(search.ok).toBe(true);
    expect(h.log).toContain("type #q ramen +enter");
    const form = await h.agency.gate.request("browser.task", { steps: [{ op: "type", selector: "#name", value: "matt", enter: true }] });
    expect(form.ok).toBe(false);
    expect(h.log).not.toContain("type #name matt +enter");
  });

  test("non-web urls are refused before anything opens", async () => {
    const h = harness();
    const r = await h.agency.gate.request("browser.task", { steps: [{ op: "open", url: "file:///etc/passwd" }] });
    expect(r.ok).toBe(false);
    expect(h.log).not.toContain("launch");
  });

  test("browser.close closes her window and says so on the bus", async () => {
    const h = harness();
    await h.agency.gate.request("browser.task", { url: "https://tsuki.example" });
    await h.agency.gate.request("browser.close", {});
    expect(h.of("agent.browser").map((e) => e.data.status)).toEqual(["open", "closed"]);
  });

  test("step scripts: places, maps, a url, 'it'", () => {
    expect(normalizeSteps([{ op: "rm", x: 1 }, { op: "click" }, { op: "click", text: "Menu", optional: true }, { op: "wait", ms: 99999 }])).toEqual([
      { op: "click", text: "Menu", optional: true },
      { op: "wait", ms: 5000 },
    ]);
    expect(placeSteps({ name: "Tsuki", address: "Irvine" })[0]).toEqual({ op: "open", url: mapsSearchUrl("Tsuki Irvine") });
    expect(placeSteps({ name: "Tsuki", url: "https://tsuki.example" })).toEqual(lookAroundSteps("https://tsuki.example"));
    expect(stepsFor({ query: "tsuki.example" }).what).toBe("tsuki.example");
    rememberPlace(null);
    expect(stepsFor({ query: "it" }).steps).toEqual([]);
    rememberPlace({ name: "Tsuki Ramen", address: "Irvine, CA" });
    expect(stepsFor({}).what).toBe("Tsuki Ramen");
    rememberPlace(null);
    expect(soundsConsequential("Book now")).toBe(true);
    expect(soundsConsequential("Place order")).toBe(true);
    expect(soundsConsequential("Menu")).toBe(false);
  });
});

describe("native actions: her cursor goes and does it", () => {
  test("music.play glides to Spotify's window and clicks before the AppleScript runs", async () => {
    const h = harness();
    h.agency.cursor.markWatching();
    const r = await h.agency.gate.request("music.play", { query: "our song" });
    expect(r.ok).toBe(true);
    const L = h.log;
    expect(L.slice(0, 4)).toEqual(["osa bounds", "cursor move Spotify", "cursor click play our song on Spotify", "osa action"]);
    const move = h.of("agent.cursor")[0]!.data;
    expect(move).toMatchObject({ x: 1100, target: "Spotify" });
    expect(h.osaCalls[1]).toContain("play track");
    expect(h.osaCalls[1]).toBe(PLAY_SCRIPT("spotify:track:6iwsWcvqCQcj025NqCeyFS"));
  });

  test("nobody watching: no window lookup, no cursor, same action", async () => {
    const h = harness();
    await h.agency.gate.request("app.quit", { app: "Spotify" });
    expect(h.log).toEqual(["osa action"]);
    expect(h.of("agent.cursor").length).toBe(0);
  });
});

describe("voice: show me / do it yourself / open it", () => {
  test("intents", () => {
    expect(readBrowse("show me")).toEqual({});
    expect(readBrowse("do it yourself")).toEqual({});
    expect(readBrowse("open it")).toEqual({});
    expect(readBrowse("yo eve can you show me the menu")).toEqual({});
    expect(readBrowse("show me ramen places near irvine")).toEqual({ query: "ramen places near irvine" });
    expect(readBrowse("open hacker news in your browser")).toEqual({ query: "hacker news" });
    expect(readBrowse("show me my resume")).toBeNull();
    expect(readBrowse("open OVERLAY.md")).toBeNull();
    const it = readIntent("open it");
    expect(it.browse).toEqual({});
    expect(it.work).toBe(false);
    expect(readIntent("show me my resume").work).toBe(true);
    expect(readIntent("play our song").browse).toBeNull();
  });
});

describe("the show during a task", () => {
  test("EVE_BROWSER_SHOW=1: a food task browses Maps and the pick, without holding the answer", async () => {
    const h = harness({ env: { EVE_BROWSER_SHOW: "1", EIGEN_LOCATION: "Irvine, CA" }, timeoutMs: 300 });
    const res = await h.agency.runTask("figure out dinner tonight, something spicy and cheap");
    expect(res.summary.length).toBeGreaterThan(0);
    await Bun.sleep(50);
    const tasks = h.of("action.request").filter((e) => e.data.kind === "browser.task");
    expect(tasks.length).toBe(2);
    expect(String(tasks[0]!.data.args.query)).toContain("near Irvine, CA");
    expect(tasks[1]!.data.args.place).toBeTruthy();
    expect(h.log.some((l) => l.startsWith("goto https://www.google.com/maps/search/"))).toBe(true);
    expect(h.ctx.world().slots.agency?.last_place).toBeTruthy();
  });

  test("off by default when nobody is watching", async () => {
    const h = harness({ timeoutMs: 100 });
    await h.agency.runTask("figure out dinner tonight");
    await Bun.sleep(20);
    expect(h.of("action.request").filter((e) => e.data.kind === "browser.task").length).toBe(0);
    expect(h.log).not.toContain("launch");
  });
});

describe("shared attention: she points at what she's talking about", () => {
  const talk = (h: ReturnType<typeof harness>, id: string, text: string) => h.bus.emit("speech.begin", { utteranceId: id, text, brain: "persona" }, "speech");
  const cursorLog = (h: ReturnType<typeof harness>) => h.of("agent.cursor").map((e) => `${e.data.action}${e.data.label ? ` ${e.data.label}` : ""}`);

  test("names an app: glide to its window, point while talking, idle when done", async () => {
    const h = harness();
    h.agency.cursor.markWatching();
    talk(h, "u1", "your Spotify has been open all day btw");
    await Bun.sleep(30);
    expect(cursorLog(h)).toEqual(["move Spotify", "point Spotify"]);
    expect(h.of("agent.cursor")[0]!.data).toMatchObject({ x: 1100, target: "Spotify" });
    h.bus.emit("speech.end", { utteranceId: "u1", interrupted: false }, "speech");
    await Bun.sleep(1300);
    expect(cursorLog(h).at(-1)).toBe("idle");
  });

  test("a fresh gaze point wins; nothing known = no point", async () => {
    const h = harness();
    h.agency.cursor.markWatching();
    talk(h, "u0", "hm, interesting");
    await Bun.sleep(20);
    expect(h.of("agent.cursor").length).toBe(0);
    h.bus.emit("gaze.point", { x: 640, y: 222, nx: 0.4, ny: 0.2 }, "eye");
    talk(h, "u1", "wait what is that");
    await Bun.sleep(20);
    expect(h.of("agent.cursor").map((e) => [e.data.action, e.data.x, e.data.y])).toEqual([
      ["move", 640, 222],
      ["point", 640, 222],
    ]);
  });

  test("rate limited, never while busy, never when nobody's watching", async () => {
    const h = harness();
    talk(h, "u1", "Spotify again?");
    await Bun.sleep(20);
    expect(h.of("agent.cursor").length).toBe(0); // not watching
    h.agency.cursor.markWatching();
    await h.agency.cursor.move({ x: 5, y: 5 }); // a task step just happened
    talk(h, "u2", "Spotify again?");
    await Bun.sleep(20);
    expect(h.of("agent.cursor").length).toBe(1);
    const fresh = harness();
    fresh.agency.cursor.markWatching();
    talk(fresh, "a", "Spotify");
    await Bun.sleep(20);
    fresh.bus.emit("speech.end", { utteranceId: "a", interrupted: false }, "speech");
    talk(fresh, "b", "Calendar though");
    await Bun.sleep(20);
    expect(fresh.of("agent.cursor").filter((e) => e.data.action === "point").length).toBe(1);
  });

  test("appMentioned", async () => {
    const { appMentioned } = await import("../src/agency/pointer");
    expect(appMentioned("open chrome real quick")).toBe("Google Chrome");
    expect(appMentioned("what's that", "Figma")).toBe("Figma");
    expect(appMentioned("nice weather")).toBeNull();
    expect(appMentioned("look at this", "Electron")).toBeNull();
  });
});
