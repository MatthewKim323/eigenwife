import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AnyEnvelope } from "@eigenwife/protocol";
import { EventBus } from "../src/bus";
import { loadConfig } from "../src/config";
import { createContext } from "../src/context";
import { cleanLabel, DesktopGaze, kindFor, targetKey, toTarget, type Resolved, type Skip } from "../src/gaze/desktop";
import { createDesktopGaze } from "../src/gaze/module";
import { parseAt, type AxHit } from "../src/screen/capture";
import { emptyWorld, type WorldSnapshot } from "@eigenwife/protocol";
import { PerceptionEngine } from "../src/reflex/rules";

const hit = (o: Partial<AxHit> = {}): AxHit => ({
  ok: true,
  app: "Google Chrome",
  bundleId: "com.google.Chrome",
  role: "AXLink",
  label: "Garlic Knockout Ramen $21",
  title: "Mensho Tokyo menu",
  url: "https://menshotokyo.com/menu",
  frame: { x: 400, y: 300, w: 360, h: 140 },
  ...o,
});

function harness(resolve: (x: number, y: number) => Promise<Resolved | Skip>, paused = () => false) {
  const out: { type: string; data: any }[] = [];
  const g = new DesktopGaze({ resolve, emit: (type, data) => out.push({ type, data }), paused });
  return { g, out, of: (t: string) => out.filter((e) => e.type === t) };
}

const ramen: Resolved = toTarget(hit(), { x: 500, y: 350 }, "menshotokyo.com", 120);

describe("desktop gaze state machine", () => {
  test("a held fixation resolves once, then re-announces with growing dwell", async () => {
    let calls = 0;
    const h = harness(async () => (calls++, ramen));
    h.g.onMessage({ type: "fixation_start", id: 1, x: 500, y: 350 }, 0);
    await h.g.tick(100); // not settled yet
    expect(calls).toBe(0);
    await h.g.tick(400);
    expect(calls).toBe(1);
    expect(h.of("gaze.fixation")).toHaveLength(1);
    await h.g.tick(1700);
    await h.g.tick(3000);
    const t = h.of("gaze.target");
    expect(t.length).toBeGreaterThanOrEqual(3);
    expect(t.at(-1)!.data.dwellMs).toBe(3000);
    expect(t.at(-1)!.data.target.key).toBe(ramen.target.key);
    expect(calls).toBe(1); // no re-resolve while the eyes don't move
  });

  test("blinks don't break a stare; losing the face does", async () => {
    const h = harness(async () => ramen);
    h.g.onMessage({ type: "fixation_start", id: 1, x: 500, y: 350 }, 0);
    await h.g.tick(400);
    h.g.onMessage({ type: "gaze", valid: false, blink: true, reason: "blink" }, 900);
    await h.g.tick(1700);
    expect(h.of("gaze.lost")).toHaveLength(0);
    expect(h.of("gaze.target").length).toBe(2);
    h.g.onMessage({ type: "gaze", valid: false, reason: "face_lost" }, 2000);
    expect(h.of("gaze.lost").map((e) => e.data.reason)).toEqual(["no_face"]);
  });

  test("looking back within 1.5s continues the stare (dwell keeps counting)", async () => {
    const h = harness(async () => ramen);
    h.g.onMessage({ type: "fixation_start", id: 1, x: 500, y: 350 }, 0);
    await h.g.tick(400);
    h.g.onMessage({ type: "fixation_end", id: 1, ms: 800 }, 800);
    h.g.onMessage({ type: "fixation_start", id: 2, x: 510, y: 355 }, 1200);
    await h.g.tick(1600);
    expect(h.of("gaze.fixation")).toHaveLength(1); // same target, not a new fixation for the rules
    expect(h.of("gaze.target").at(-1)!.data.dwellMs).toBe(1600);
  });

  test("private, Eve and empty points are never announced and break a stare", async () => {
    let next: Resolved | Skip = ramen;
    const h = harness(async () => next);
    h.g.onMessage({ type: "fixation_start", id: 1, x: 500, y: 350 }, 0);
    await h.g.tick(400);
    next = { skip: "private", why: "private site" };
    h.g.onMessage({ type: "fixation_start", id: 2, x: 900, y: 700 }, 1000);
    await h.g.tick(1400);
    expect(h.of("gaze.lost").map((e) => e.data.reason)).toEqual(["offscreen"]);
    const labels = h.of("gaze.target").map((e) => e.data.target.label);
    expect(labels.every((l) => l.includes("Garlic"))).toBe(true);
  });

  test("paused: nothing is resolved at all", async () => {
    let calls = 0;
    const h = harness(async () => (calls++, ramen), () => true);
    h.g.onMessage({ type: "fixation_start", id: 1, x: 500, y: 350 }, 0);
    await h.g.tick(1000);
    expect(calls).toBe(0);
    expect(h.of("gaze.target")).toHaveLength(0);
  });

  test("a flickering tracker makes one gaze.lost, not one per flip", async () => {
    const h = harness(async () => ramen);
    h.g.onMessage({ type: "fixation_start", id: 1, x: 500, y: 350 }, 0);
    await h.g.tick(400);
    for (let t = 1000; t < 4000; t += 300) {
      h.g.onMessage({ type: "face", present: t % 600 === 400 }, t);
      h.g.onMessage({ type: "gaze", valid: false, reason: t % 600 ? "face_lost" : "head_pose_outside_calibration" }, t + 10);
    }
    expect(h.of("gaze.lost")).toHaveLength(1);
  });

  test("eye.status from hello and face, deduped, face gone only after it lasts", async () => {
    const h = harness(async () => ramen);
    h.g.onMessage({ type: "hello", calibrated: true, accuracyDeg: 2.6, face: true }, 0);
    h.g.onMessage({ type: "face", present: true }, 10);
    h.g.onMessage({ type: "face", present: false }, 20);
    await h.g.tick(500); // blip: not reported yet
    h.g.onMessage({ type: "face", present: true }, 600);
    h.g.onMessage({ type: "face", present: false }, 700);
    await h.g.tick(2300);
    const s = h.of("eye.status").map((e) => e.data);
    expect(s).toEqual([
      { connected: true, calibrated: true, accuracyDeg: 2.6, facePresent: true },
      { connected: true, calibrated: true, accuracyDeg: 2.6, facePresent: false },
    ]);
  });
});

describe("targets", () => {
  test("label says what and where; key is stable for the same thing", () => {
    expect(ramen.target.label).toBe("Garlic Knockout Ramen $21 (Google Chrome, menshotokyo.com)");
    expect(ramen.target.kind).toBe("other");
    expect(ramen.target.meta).toMatchObject({ source: "desktop", app: "Google Chrome", host: "menshotokyo.com", point: { x: 500, y: 350 } });
    expect(targetKey(hit())).toBe(targetKey(hit({ frame: { x: 405, y: 302, w: 358, h: 139 } })));
    expect(targetKey(hit())).not.toBe(targetKey(hit({ label: "Gyoza $9" })));
    // animated titles (spinners, unread counts) don't restart a stare
    expect(targetKey(hit({ label: "", title: "◑ Eigenwife" }))).toBe(targetKey(hit({ label: "", title: "◐ Eigenwife" })));
    expect(targetKey(hit({ label: "", title: "(3) Inbox" }))).toBe(targetKey(hit({ label: "", title: "(4) Inbox" })));
  });

  test("label junk (bullets, asterisks, repeats) is dropped", () => {
    expect(cleanLabel("* Built with · Built with · You can add up to 25 tags. · *")).toBe("Built with · You can add up to 25 tags.");
  });

  test("buttons and menus are ui (never a stare), the dock is an app", () => {
    expect(kindFor({ role: "AXButton" })).toBe("ui");
    expect(kindFor({ role: "AXMenuBar" })).toBe("ui");
    expect(kindFor({ role: "AXImage", bundleId: "com.apple.dock" })).toBe("app");
    expect(kindFor({ role: "AXStaticText" })).toBe("other");
  });

  test("a terminal we can't read under the point is named by its window", () => {
    const r = toTarget(hit({ app: "Ghostty", role: "AXTextArea", label: "", coarse: true, title: "eigenwife", url: undefined }), { x: 1, y: 1 }, null, 120);
    expect(r.target.label).toBe('the Ghostty window "eigenwife"');
    expect(r.confidence).toBeLessThan(0.5);
  });

  test("parseAt never lets text out of a secure or private hit", () => {
    const p = parseAt(JSON.stringify({ ok: true, app: "Chrome", private: true, secure: true, label: "hunter2", title: "Sign in" }));
    expect(p).toMatchObject({ private: true, secure: true, label: "" });
    expect(p.title).toBeUndefined();
    const q = parseAt(JSON.stringify({ ok: true, app: "Chrome", role: "AXSecureTextField", label: "pw" }));
    expect(q.label).toBe("");
    expect(parseAt("garbage").ok).toBe(false);
  });
});

describe("module: privacy, pause, redaction", () => {
  function setup(h: Partial<AxHit>, screenJson?: object) {
    const home = mkdtempSync(join(tmpdir(), "eve-gaze-"));
    if (screenJson) writeFileSync(join(home, "screen.json"), JSON.stringify(screenJson));
    const bus = new EventBus();
    const ctx = createContext(bus, { ...loadConfig(), eveHome: home });
    const seen: AnyEnvelope[] = [];
    bus.tap((e) => seen.push(e));
    const g = createDesktopGaze(ctx, { connect: false, tickMs: 60_000, at: async () => hit(h) });
    const stare = async () => {
      g.feed({ type: "hello", calibrated: true, accuracyDeg: 2.5, face: true, display: { ptPerDeg: 48 } });
      g.feed({ type: "fixation_start", id: 1, x: 500, y: 350 });
      await g.tick(Date.now() + 500);
    };
    const targets = () => seen.filter((e) => e.type === "gaze.target").map((e) => (e.data as any).target);
    const done = () => {
      g.stop();
      rmSync(home, { recursive: true, force: true });
    };
    return { g, bus, seen, stare, targets, done };
  }

  test("a normal page element becomes a gaze.target", async () => {
    const s = setup({});
    await s.stare();
    expect(s.targets()[0]?.label).toContain("Garlic Knockout Ramen");
    s.done();
  });

  test("bank sites, private apps and private titles are skipped before anything is emitted", async () => {
    for (const h of [{ url: "https://secure.chase.com/x" }, { app: "1Password", bundleId: "com.1password.1password", url: undefined }, { title: "Sign in to your account", url: undefined }]) {
      const s = setup(h);
      await s.stare();
      expect(s.targets()).toHaveLength(0);
      s.done();
    }
  });

  test("user denylist from screen.json applies, and pausing screen stops gaze too", async () => {
    const a = setup({}, { denylist: { apps: [], domains: ["menshotokyo.com"] } });
    await a.stare();
    expect(a.targets()).toHaveLength(0);
    a.done();
    const b = setup({}, { paused: true });
    await b.stare();
    expect(b.targets()).toHaveLength(0);
    b.done();
    const c = setup({});
    c.bus.emit("attention.pause", { paused: true, by: "tray" } as any);
    await c.stare();
    expect(c.targets()).toHaveLength(0);
    c.done();
  });

  test("Eve's own windows (the overlay, the shell tab) are skipped: the shell does its own DOM gaze", async () => {
    const s = setup({ app: "Google Chrome", url: "http://127.0.0.1:5173/?scene=desktop" });
    await s.stare();
    expect(s.targets()).toHaveLength(0);
    s.done();
  });

  test("secrets in what you're looking at are redacted from the label", async () => {
    const s = setup({ label: "export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789" });
    await s.stare();
    expect(s.targets()[0]?.label).not.toContain("abcdefghijklmnop");
    s.done();
  });
});

describe("with the reflex rules", () => {
  test("desktop stare feeds the stare rules: glance at 2.5s, notice at 4s", async () => {
    const out: { type: string; data: any }[] = [];
    const g = new DesktopGaze({ resolve: async () => ramen, emit: (type, data) => out.push({ type, data }), paused: () => false });
    let now = 100_000;
    const w: WorldSnapshot = { ...emptyWorld(), companion: { ...emptyWorld().companion, born: true, state: "idle" } };
    const rules = new PerceptionEngine(() => w);
    const fired: string[] = [];
    const feedRules = () => {
      for (const e of out.splice(0)) for (const t of rules.feed({ type: e.type, data: e.data, ts: now, source: "gaze", id: String(Math.random()) } as any)) fired.push(t.rule);
    };
    rules.feed({ type: "companion.born", data: { persona: { name: "Eve" } }, ts: 0, source: "core", id: "b" } as any);
    g.onMessage({ type: "fixation_start", id: 1, x: 500, y: 350 }, now);
    for (let t = 0; t <= 5000; t += 200) {
      now = 100_000 + t;
      await g.tick(now);
      feedRules();
    }
    expect(fired).toContain("stare_glance");
    expect(fired).toContain("stare");
  });
});
