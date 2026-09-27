import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { AnyEnvelope } from "@eigenwife/protocol";
import { EventBus } from "../src/bus";
import { loadConfig } from "../src/config";
import { createContext } from "../src/context";
import type { SpeechService } from "../src/services";
import { createAgency } from "../src/agency/module";
import type { BrowserBackend, BrowserPage, Located, Target } from "../src/agency/browser/driver";
import type { OsaRunner } from "../src/agency/osa";
import type { Exec, ExecOpts } from "../src/agency/types";
import { createWork } from "../src/work/module";
import { readWorkIntent } from "../src/work/intent";
import { ambiguity, findFiles } from "../src/work/find";
import { createFollowup, classify, placesLine } from "../src/followup/module";
import { extractOptions, extractTimes, optionsFromText, pickTime, resolveChoice, type Option } from "../src/followup/options";
import { reported } from "../src/followup/report";
import { createJev } from "../src/reflex/jev";
import { reflexModule } from "../src/reflex/module";
import { emitAt, FakeAgency, FakeBrains, FakeClock, fakeContext, FakeMemory, FakeSpeech, settle, startModules } from "../src/reflex/testing";

const PERSONA = {
  name: "Eve",
  tagline: "",
  description: "",
  personality: "",
  scenario: "",
  dials: { humor: 0.7, sarcasm: 0.6, warmth: 0.5, initiative: 0.5, verbosity: 0.3, chaos: 0.2 },
  voice: { provider: "x", voiceId: "x", style: "x" },
  palette: { hue: 0 },
  vector: {},
};

process.env.EIGEN_QUIET = "1";

const TMP = mkdtempSync(join(tmpdir(), "eve-followup-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const DAY = 86_400_000;
const NOW = Date.now();

/** Write a file with an mtime `daysAgo` days back. */
function file(path: string, daysAgo = 1, body = "x") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  const t = new Date(NOW - daysAgo * DAY);
  utimesSync(path, t, t);
  return path;
}

/** mdfind -name returns every path whose name contains the word; content search returns `content`. */
function fakeExec(paths: string[], content: string[] = []) {
  const calls: string[][] = [];
  const exec: Exec = async (argv: string[], _o?: ExecOpts) => {
    calls.push(argv);
    if (argv[0] === "mdfind") {
      const dir = argv[2]!;
      const name = argv[3] === "-name" ? argv[4]!.toLowerCase() : null;
      const list = name ? paths.filter((p) => p.split("/").pop()!.toLowerCase().includes(name)) : content;
      return { code: 0, stdout: list.filter((p) => p.startsWith(dir)).join("\n"), stderr: "", timedOut: false };
    }
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  return { exec, calls };
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

// ---------------------------------------------------------------------------
// fixtures: her browser pages
// ---------------------------------------------------------------------------

const EN = String.fromCharCode(0x2013);
const MAPS_TEXT = [
  "Results",
  "Mensho Tokyo SF",
  "4.6(2,480)",
  "$$ · Ramen · 672 Geary St",
  "Open · Closes 10 PM",
  "Dine-in · Takeout",
  "Marufuku Ramen",
  "4.5(3,211)",
  `$20${EN}30`,
  "Ramen · 1581 Webster St",
  '"Spicy tonkotsu and chicken paitan"',
  "Open · Closes 10 PM",
  "Nagi Ramen",
  "4.4(812)",
  "$ · Ramen · 339 Kearny St",
  "Closed · Opens 11 AM",
  "Sponsored",
].join("\n");

const YELP_TEXT = [
  "Top 10 Best Ramen in San Francisco, CA",
  "Sort: Recommended",
  "1. Marufuku Ramen",
  "4.5 (3.2k reviews)",
  "Ramen",
  "$$ Japantown",
  '"best spicy tonkotsu in the city"',
  "2. Ramen Nagi",
  "4.3 (1.1k reviews)",
  "Ramen",
  "$$ Downtown",
  "3. Hinodeya Ramen Bar",
  "4.4 (980 reviews)",
  "$$ Japantown",
  "dashi ramen, quiet spot",
].join("\n");

const PLACE_TEXT = "Marufuku Ramen\n4.5(3,211)\nRamen · 1581 Webster St\nOpen · Closes 10 PM\nMenu\nHakata tonkotsu $18";
const OPENTABLE_TEXT = "Results for Marufuku Ramen\nMarufuku Ramen\nJapantown · Ramen · $$\n7:30 PM\n8:15 PM\n9:00 PM\nSome Other Place\n6:00 PM";
const CONFIRM_TEXT = "Reservation confirmed. See you tonight at 7:30 PM. Confirmation #4411";

const M = { screenX: 0, screenY: 33, outerWidth: 735, outerHeight: 890, innerWidth: 735, innerHeight: 800, devicePixelRatio: 2 };

/** Her browser, faked: pages by url, clicks recorded, a click on a time "books" it. */
function fakeBrowser(log: string[]) {
  let open = false;
  let url = "about:blank";
  let booked = false;
  const closed: (() => void)[] = [];
  const key = (t: Target) => t.selector ?? t.text ?? "";
  const page: BrowserPage = {
    async goto(u) {
      log.push(`goto ${u}`);
      url = u;
      booked = false;
    },
    url: () => url,
    metrics: async () => M,
    async locate(t): Promise<Located | null> {
      const k = key(t);
      if (/^\d{1,2}:\d{2}$/.test(k)) return { box: { x: 100, y: 200, width: 80, height: 30 }, submits: false, label: `${k} PM` };
      return null;
    },
    async click(t) {
      log.push(`click ${key(t)}`);
      if (/^\d{1,2}:\d{2}$/.test(key(t))) booked = true;
    },
    async type() {},
    async wheel() {},
    async read() {
      if (booked) return { title: "Confirmed", url, text: CONFIRM_TEXT };
      if (url.includes("opentable.com")) return { title: "OpenTable", url, text: OPENTABLE_TEXT };
      if (url.includes("google.com/maps/search/Marufuku")) return { title: "Marufuku Ramen", url, text: PLACE_TEXT };
      if (url.includes("google.com/maps/search")) return { title: "ramen - Google Maps", url, text: MAPS_TEXT };
      return { title: "page", url, text: "nothing much" };
    },
    screenshot: async () => new Uint8Array([1]),
    enterSubmits: async () => false,
  };
  const backend: BrowserBackend = {
    async launch() {
      open = true;
      return { page, avail: { x: 0, y: 33, width: 1470, height: 923 } };
    },
    async setBounds() {},
    async close() {
      open = false;
      for (const c of closed) c();
    },
    isOpen: () => open,
    onClosed: (cb) => void closed.push(cb),
  };
  return backend;
}

const calOsa: OsaRunner = async () => ({ ok: true, stdout: JSON.stringify({ uid: "evt-1", calendar: "Eigenwife", fellBack: false }), stderr: "", code: 0 });

function rig(o: { exec?: Exec; home?: string; now?: () => number; ttlMs?: number; approvalTimeoutMs?: number } = {}) {
  const bus = new EventBus(5000);
  const ctx = createContext(bus, { ...loadConfig(), eveHome: mkdtempSync(join(TMP, "eve-")), demo: false });
  const events: AnyEnvelope[] = [];
  bus.on("*", (e) => void events.push(e));
  const { speech, said } = fakeSpeech();
  ctx.provide("speech", speech);
  const browserLog: string[] = [];
  const env = (n: string) => (n === "EVE_FILES_HOME" ? (o.home ?? "") : n === "EIGEN_LOCATION" ? "San Francisco, CA" : "");
  const fx = o.exec ? { exec: o.exec } : fakeExec([]);
  const agency = createAgency(ctx, {
    deps: { exec: fx.exec, osa: calOsa, env, openUrl: async () => true, loadHarem: async () => null, browserBackend: () => fakeBrowser(browserLog), sleep: async () => {}, fetch: async () => new Response("", { status: 503 }) },
    approvalTimeoutMs: o.approvalTimeoutMs ?? 300,
  });
  ctx.provide("agency", agency.service);
  const work = createWork(ctx, { poll: false, deps: { exec: fx.exec, osa: calOsa, env, idleSeconds: async () => 60, sleep: async () => {} } });
  ctx.provide("work", work.service);
  const fu = createFollowup(ctx, { deps: { env, ...(o.now ? { now: o.now } : {}) }, ttlMs: o.ttlMs });
  ctx.provide("followup", fu.service);
  const of = <K extends AnyEnvelope["type"]>(t: K) => events.filter((e) => e.type === t) as Extract<AnyEnvelope, { type: K }>[];
  const acts = () => of("action.request").map((e) => e.data.kind);
  const stop = () => {
    fu.stop();
    work.stop();
    agency.stop();
  };
  return { bus, ctx, events, said, agency, work, fu: fu.service, of, acts, browserLog, stop };
}

// ---------------------------------------------------------------------------
// files: ranking like a person looks
// ---------------------------------------------------------------------------

describe("files: find my X", () => {
  const H = join(TMP, "home-a");
  const paths = [
    file(join(H, "Downloads", "matt_kim_resume.pdf"), 10),
    file(join(H, "dev", "eigenwife", "packages", "core", "test", "fixtures", "resume.pdf"), 0.1),
    file(join(H, "dev", "eigenwife", "packages", "core", "test", "resume.test.ts"), 0.1),
    file(join(H, "Documents", "side", "proj", "test", "resume.json"), 0.2),
    file(join(H, "Documents", "side", "proj", "docs", "resume-template.md"), 2),
    file(join(H, "Library", "Caches", "resume.pdf"), 0.1),
    file(join(H, "node_modules", "x", "resume.js"), 0.1),
    file(join(H, "Desktop", "Resume copy.pdf"), 700),
  ];
  mkdirSync(join(H, "Documents", "side", "proj", ".git"), { recursive: true });
  const jobs = file(join(H, "Documents", "notes", "jobs.md"), 3, "update resume before friday");

  test("resume in Downloads beats test fixtures in ~/dev; code trees, caches and repo tests are out", async () => {
    const { exec } = fakeExec(paths, [jobs, paths[1]!]);
    const ranked = await findFiles(exec, "resume", { home: H, now: NOW, owner: ["matt", "kim"] });
    expect(ranked[0]!.name).toBe("matt_kim_resume.pdf");
    expect(ranked[0]!.where).toBe("downloads");
    const all = ranked.map((r) => r.path).join("\n");
    expect(all).not.toContain("/dev/");
    expect(all).not.toContain("Library");
    expect(all).not.toContain("node_modules");
    expect(all).not.toContain("/proj/test/");
    // Filename beats content: the note that only mentions it ranks below every name match.
    const names = ranked.map((r) => r.name);
    expect(names.indexOf("jobs.md")).toBeGreaterThan(names.indexOf("Resume copy.pdf"));
    // A doc inside some git repo is more likely a fixture: below his real one.
    expect(names.indexOf("resume-template.md")).toBeGreaterThan(0);
  });

  test("naming a repo searches inside it (its tests still out)", async () => {
    const repo = join(H, "dev", "eigenwife");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const readme = file(join(repo, "RESUME_NOTES.md"), 1);
    const { exec } = fakeExec([...paths, readme]);
    const ranked = await findFiles(exec, "resume", { home: H, now: NOW, repoPath: repo });
    expect(ranked.some((r) => r.path === readme)).toBe(true);
    expect(ranked.some((r) => r.path.includes("/test/"))).toBe(false);
  });

  test("the same file twice (download + copy) counts once", async () => {
    const H2 = join(TMP, "home-dupe");
    const a = file(join(H2, "Downloads", "cover_letter.pdf"), 5, "same");
    const b = file(join(H2, "Documents", "cover_letter (1).pdf"), 5, "same");
    const { exec } = fakeExec([a, b]);
    const ranked = await findFiles(exec, "cover letter", { home: H2, now: NOW });
    expect(ranked).toHaveLength(1);
  });

  test("close top two ask, a clear winner doesn't", async () => {
    const H3 = join(TMP, "home-amb");
    const aug = file(join(H3, "Documents", "resume_fall.pdf"), 45);
    const mar = file(join(H3, "Downloads", "resume.pdf"), 190);
    const { exec } = fakeExec([aug, mar]);
    const ranked = await findFiles(exec, "resume", { home: H3, now: NOW });
    const q = ambiguity(ranked, NOW);
    expect(q?.question).toMatch(/^the one from \w+ or the older one from \w+/);
    const solo = await findFiles(fakeExec([aug]).exec, "resume", { home: H3, now: NOW });
    expect(ambiguity(solo, NOW)).toBeNull();
  });

  test("'find my resume' opens the best one with one line, never reads it aloud", async () => {
    const fx = fakeExec(paths, [jobs]);
    const r = rig({ exec: fx.exec, home: H });
    const out = await r.work.service.handle("find my resume");
    expect(out.ok).toBe(true);
    expect(out.summary).toBe("found matt_kim_resume.pdf in downloads, opening it.");
    expect(fx.calls.some((c) => c[0] === "open" && c[1] === paths[0])).toBe(true);
    expect(r.acts()).toEqual(["files.search", "files.open"]);
    // Nothing read: no files.read, no textutil, no PDF text.
    expect(fx.calls.some((c) => c[0] === "textutil")).toBe(false);
    expect(r.fu.pending()).toMatchObject({ domain: "files", expect: "none" });
    expect(r.ctx.contextBlock()).toContain("followup.pending: opened matt_kim_resume.pdf");
    r.stop();
  });

  test("ambiguous: she asks, his answer opens that one", async () => {
    const H4 = join(TMP, "home-amb2");
    const newer = file(join(H4, "Documents", "resume_fall.pdf"), 45);
    const older = file(join(H4, "Downloads", "resume.pdf"), 190);
    const fx = fakeExec([newer, older]);
    const r = rig({ exec: fx.exec, home: H4 });
    const out = await r.work.service.handle("find my resume");
    expect(out.summary).toMatch(/^found two\. the one from \w+ or the older one from \w+/);
    expect(fx.calls.some((c) => c[0] === "open")).toBe(false);
    expect(r.work.service.claims("the older one")).toBe(true);
    const pick = await r.work.service.handle("the older one");
    expect(pick.summary).toBe("opening resume.pdf from downloads.");
    expect(fx.calls.some((c) => c[0] === "open" && c[1] === older)).toBe(true);
    r.stop();
  });

  test("'read it' reads (only when asked); 'the other one' opens the next; 'show it in finder' reveals", async () => {
    const H5 = join(TMP, "home-read");
    const a = file(join(H5, "Downloads", "matt_resume.md"), 3, "# Matt Kim\n\nBuilder. Shipped eigenwife, jabby and a lot of late nights at Kali Labs.\n");
    const b = file(join(H5, "Desktop", "resume_old.md"), 900, "# old\n\nAn older resume from long ago with less stuff on it.\n");
    const fx = fakeExec([a, b]);
    const r = rig({ exec: fx.exec, home: H5 });
    await r.work.service.handle("find my resume");
    expect(r.acts()).not.toContain("files.read");
    const read = await r.work.service.handle("read it");
    expect(r.acts()).toContain("files.read");
    expect(read.summary).toContain("matt_resume.md");
    const other = await r.work.service.handle("the other one");
    expect(other.summary).toBe("opening resume_old.md from desktop.");
    const reveal = await r.work.service.handle("show it in finder");
    expect(reveal.summary).toBe("it's selected in finder.");
    expect(fx.calls.some((c) => c[0] === "open" && c[1] === "-R" && c[2] === b)).toBe(true);
    r.stop();
  });

  test("'where's my resume' says where and offers; yeah opens", async () => {
    const H6 = join(TMP, "home-where");
    const a = file(join(H6, "Documents", "resume.pdf"), 3);
    const fx = fakeExec([a]);
    const r = rig({ exec: fx.exec, home: H6 });
    const out = await r.work.service.handle("where's my resume");
    expect(out.summary).toBe("resume.pdf, in documents. want me to open it?");
    expect(fx.calls.some((c) => c[0] === "open")).toBe(false);
    const yes = await r.work.service.handle("yeah");
    expect(yes.summary).toBe("opening resume.pdf from documents.");
    r.stop();
  });

  test("a failed open still gets a line and an offer", async () => {
    const H7 = join(TMP, "home-fail");
    const a = file(join(H7, "Downloads", "resume.pdf"), 3);
    const base = fakeExec([a]);
    const exec: Exec = async (argv, o) => (argv[0] === "open" && argv[1] !== "-R" ? { code: 1, stdout: "", stderr: "nope", timedOut: false } : base.exec(argv, o));
    const r = rig({ exec, home: H7 });
    const out = await r.work.service.handle("find my resume");
    expect(out.ok).toBe(false);
    expect(out.summary).toBe("found resume.pdf in downloads but couldn't open it. want me to show it in finder?");
    const yes = await r.work.service.handle("yeah");
    expect(yes.summary).toBe("it's selected in finder.");
    r.stop();
  });
});

// ---------------------------------------------------------------------------
// options off her page + his answers
// ---------------------------------------------------------------------------

describe("options: extraction from her browser page", () => {
  test("google maps result list (text)", () => {
    const o = optionsFromText(MAPS_TEXT);
    expect(o.map((x) => x.name)).toEqual(["Mensho Tokyo SF", "Marufuku Ramen", "Nagi Ramen"]);
    expect(o.map((x) => x.rating)).toEqual([4.6, 4.5, 4.4]);
    expect(o[0]).toMatchObject({ reviews: 2480, price: "$$", kind: "Ramen", address: "672 Geary St" });
    expect(o[1]!.price).toBe("$20-30");
    expect(o[1]!.detail).toContain("spicy tonkotsu");
    expect(o[2]!.hours).toMatch(/^Closed, Opens 11 AM/);
  });

  test("yelp-style list with numbered names and k review counts", () => {
    const o = optionsFromText(YELP_TEXT);
    expect(o.map((x) => x.name)).toEqual(["Marufuku Ramen", "Ramen Nagi", "Hinodeya Ramen Bar"]);
    expect(o[0]).toMatchObject({ rating: 4.5, reviews: 3200, price: "$$" });
  });

  test("cards from the page win when they look like listings; nav tiles are dropped", () => {
    const o = extractOptions({
      text: "",
      cards: [
        { name: "Directions", text: "Directions" },
        { name: "Mensho Tokyo SF", text: "Mensho Tokyo SF\n4.6(2,480)\n$$ · Ramen · 672 Geary St\nOpen · Closes 10 PM", url: "https://www.google.com/maps/place/mensho" },
        { name: "Marufuku Ramen", text: "Marufuku Ramen\n4.5(3,211)\n$$ · Ramen · 1581 Webster St" },
        { name: "About this data", text: "About this data" },
        // Ratings that only live in aria-labels.
        { name: "Denya Ramen", text: "Denya Ramen\nRamen · 1234 Polk St\nOpen · Closes 10 PM\n4.7 stars 1,234 Reviews\nPrice: $$" },
      ],
    });
    expect(o.map((x) => x.name)).toEqual(["Mensho Tokyo SF", "Marufuku Ramen", "Denya Ramen"]);
    expect(o[0]!.url).toContain("/maps/place/");
    expect(o[2]).toMatchObject({ rating: 4.7, reviews: 1234, price: "$$" });
  });

  test("reservation times, and which one he said", () => {
    expect(extractTimes("7:30 PM\n8:15 PM\n19:45")).toEqual(["7:30 pm", "8:15 pm", "7:45 pm"]);
    expect(pickTime("8:15 then", ["7:30 pm", "8:15 pm"])).toBe("8:15 pm");
    expect(pickTime("the 7:30", ["7:30 pm", "8:15 pm"])).toBe("7:30 pm");
    expect(pickTime("9 pm", ["7:30 pm", "9:00 pm"])).toBe("9:00 pm");
    expect(pickTime("yeah", ["7:30 pm"])).toBeNull();
  });
});

describe("options: resolving his answer", () => {
  const opts = optionsFromText(MAPS_TEXT);
  test.each([
    ["the second one", 1, "ordinal"],
    ["second", 1, "ordinal"],
    ["the last one", 2, "ordinal"],
    ["let's do the first one", 0, "ordinal"],
    ["marufuku", 1, "name"],
    ["marafuku", 1, "name"],
    ["mensho please", 0, "name"],
    ["nagi", 2, "name"],
    ["the spicy one", 1, "attribute"],
    ["the cheaper one", 2, "attribute"],
    ["the highest rated", 0, "attribute"],
    ["the one with the most reviews", 1, "attribute"],
  ])("%p -> option %p by %p", (text, index, by) => {
    expect(resolveChoice(text, opts)).toEqual({ index: index as number, by: by as never });
  });

  test("chatter isn't a choice", () => {
    expect(resolveChoice("what time is it", opts)).toBeNull();
    expect(resolveChoice("ramen sounds good in general", opts)).toBeNull();
  });

  test("files: by month, newer/older, folder", () => {
    const aug = new Date(2026, 7, 10).getTime();
    const mar = new Date(2026, 2, 3).getTime();
    const files: Option[] = [
      { n: 1, name: "resume_fall.pdf", modified: aug, where: "documents", detail: "resume_fall.pdf documents august" },
      { n: 2, name: "resume.pdf", modified: mar, where: "downloads", detail: "resume.pdf downloads march" },
    ];
    expect(resolveChoice("the one from august", files)).toEqual({ index: 0, by: "attribute" });
    expect(resolveChoice("the older one", files)).toEqual({ index: 1, by: "attribute" });
    expect(resolveChoice("the newer one", files)).toEqual({ index: 0, by: "attribute" });
    expect(resolveChoice("the one in downloads", files)).toEqual({ index: 1, by: "attribute" });
  });

  test("placesLine: top three, her pick with a reason, the question", () => {
    const line = placesLine(opts, { pick: 1, why: "it's got the spicy thing you like" });
    expect(line).toBe("found 3: Mensho Tokyo SF, 4.6, mid; Marufuku Ramen, 4.5; Nagi Ramen, 4.4, cheap. i'd do marufuku ramen, it's got the spicy thing you like. which one?");
    expect(line.split(/\s+/).length).toBeLessThanOrEqual(32);
  });
});

// ---------------------------------------------------------------------------
// places: browse, pick, table, booking behind his yes, calendar
// ---------------------------------------------------------------------------

describe("places: the whole follow-through", () => {
  test("intent: 'find me ramen places in san francisco' is options to pick from", () => {
    expect(readWorkIntent("find me ramen places in san francisco")).toEqual({ kind: "browse.options", query: "ramen places in san francisco" });
    expect(readWorkIntent("can you look for some sushi spots near me")).toMatchObject({ kind: "browse.options" });
    expect(readWorkIntent("find my resume")).toMatchObject({ kind: "files.search", mode: "open" });
    expect(readWorkIntent("where's my resume")).toMatchObject({ kind: "files.search", mode: "locate" });
    expect(readWorkIntent("book a table for two")).toBeNull();
  });

  test("find -> which one -> the second one -> table -> 'yeah' books 7:30 -> calendar", async () => {
    const r = rig();
    const s1 = await r.work.service.handle("find me ramen places in san francisco");
    expect(s1.ok).toBe(true);
    expect(s1.summary).toMatch(/^found 3: Mensho Tokyo SF, 4\.6, mid; Marufuku Ramen, 4\.5; Nagi Ramen, 4\.4, cheap\. i'd do mensho tokyo sf, best rated of the bunch\. which one\?$/);
    expect(r.browserLog.some((l) => l.startsWith("goto https://www.google.com/maps/search/ramen+places+in+san+francisco"))).toBe(true);
    expect(r.ctx.contextBlock()).toContain("followup.pending: asked \"which one?\" (ramen places in san francisco); options: 1 Mensho Tokyo SF 2 Marufuku Ramen 3 Nagi Ramen");
    expect(r.of("followup.pending").at(-1)!.data).toMatchObject({ domain: "places", expect: "choice" });

    expect(r.work.service.claims("the second one")).toBe(true);
    const s2 = await r.work.service.handle("the second one");
    expect(s2.summary).toBe("pulled up marufuku ramen, open till 10 pm. want me to look for a table?");
    expect(r.of("followup.resolved").at(-1)!.data).toMatchObject({ choice: "Marufuku Ramen", by: "ordinal" });

    const s3 = await r.work.service.handle("yeah");
    expect(s3.summary).toBe("they have 7:30, 8:15 or 9:00, want 7:30?");
    expect(r.browserLog.some((l) => l.includes("opentable.com"))).toBe(true);
    // Nothing booked yet: browsing only.
    expect(r.acts()).not.toContain("browser.submit");
    expect(r.browserLog.some((l) => l.startsWith("click 7:30"))).toBe(false);

    const s4 = await r.work.service.handle("yeah");
    expect(s4.summary).toBe("booked marufuku ramen at 7:30. want it on your calendar?");
    const submit = r.agency.gate.trace.find((t) => t.kind === "browser.submit")!;
    expect(submit.permission).toBe("EXTERNAL_SIDE_EFFECT");
    expect(submit.decision).toMatchObject({ approved: true, by: "voice" });
    expect(submit.decision!.reason).toContain('to "they have 7:30, 8:15 or 9:00, want 7:30?"');
    expect(r.browserLog).toContain("click 7:30");

    const s5 = await r.work.service.handle("yeah");
    expect(s5.summary).toBe("on your calendar, 7:30 at marufuku ramen.");
    const cal = r.agency.gate.trace.find((t) => t.kind === "calendar.create_event")!;
    expect(cal.args).toMatchObject({ title: "Marufuku Ramen", start: "19:30" });
    expect(r.fu.pending()).toBeNull();
    expect(r.of("followup.cleared").at(-1)!.data.reason).toBe("done");
    r.stop();
  });

  test("a different time is his pick: '8:15' books 8:15", async () => {
    const r = rig();
    await r.work.service.handle("find me ramen places in san francisco");
    await r.work.service.handle("marufuku");
    await r.work.service.handle("book it");
    const s = await r.work.service.handle("8:15 then");
    expect(s.summary).toBe("booked marufuku ramen at 8:15. want it on your calendar?");
    expect(r.browserLog).toContain("click 8:15");
    r.stop();
  });

  test("booking needs his yes: 'nah' books nothing", async () => {
    const r = rig();
    await r.work.service.handle("find me ramen places in san francisco");
    await r.work.service.handle("the spicy one");
    await r.work.service.handle("yeah");
    const no = await r.work.service.handle("nah");
    expect(no.summary).toBe("okay.");
    expect(r.acts()).not.toContain("browser.submit");
    expect(r.browserLog.some((l) => /^click \d/.test(l))).toBe(false);
    expect(r.fu.pending()).toBeNull();
    r.stop();
  });

  test("the gate never takes a pre-approval for sends, and a submit without one still asks", async () => {
    const r = rig({ approvalTimeoutMs: 150 });
    const send = await r.agency.gate.request("jabby.send", { channel: "email", to: "leo@example.com", body: "hi" }, { preApproved: { text: "yeah", question: "send it?" } });
    expect(send.ok).toBe(false);
    expect(send.observation).toMatch(/^not done: no answer/);
    const sub = await r.agency.gate.request("browser.submit", { steps: [{ op: "click", text: "7:30", submit: true }] });
    expect(sub.ok).toBe(false);
    expect(r.said.length).toBeGreaterThanOrEqual(2);
    r.stop();
  });

  test("the 'show me' browse (not through work) still gets a line and a question", async () => {
    const r = rig();
    await r.agency.service.act("browser.task", { query: "ramen near san francisco", maps: true });
    for (let i = 0; i < 20 && !r.said.length; i++) await Bun.sleep(5);
    expect(r.said.at(-1)).toMatch(/^found 3: .* which one\?$/);
    expect(r.fu.pending()?.expect).toBe("choice");
    r.stop();
  });
});

// ---------------------------------------------------------------------------
// state: expiry, topic change, never quiet
// ---------------------------------------------------------------------------

describe("follow-up state", () => {
  const OPTS = optionsFromText(MAPS_TEXT);

  test("expires after about two minutes", () => {
    let now = 1_000_000;
    const r = rig({ now: () => now });
    r.fu.offer({ domain: "places", expect: "choice", question: "which one?", options: OPTS });
    expect(r.fu.claims("the second one")).toBe(true);
    now += 119_000;
    expect(r.fu.pending()).not.toBeNull();
    now += 2_000;
    expect(r.fu.pending()).toBeNull();
    expect(r.fu.claims("the second one")).toBe(false);
    expect(r.of("followup.cleared").at(-1)!.data.reason).toBe("expired");
    expect(r.ctx.contextBlock()).not.toContain("followup.pending");
    r.stop();
  });

  test("a new topic drops it, an answer or a filler doesn't", () => {
    const r = rig();
    r.fu.offer({ domain: "places", expect: "choice", question: "which one?", options: OPTS });
    r.bus.emit("voice.final", { text: "hmm" }, "ears");
    r.bus.emit("voice.final", { text: "the second one" }, "ears");
    expect(r.fu.pending()).not.toBeNull();
    r.bus.emit("voice.final", { text: "what's the weather like tomorrow" }, "ears");
    expect(r.fu.pending()).toBeNull();
    expect(r.of("followup.cleared").at(-1)!.data.reason).toBe("topic");
    r.stop();
  });

  test("classify: yes/no/steps by what she's waiting on", () => {
    const base = { id: "f", at: 0, expiresAt: 1e15, options: OPTS };
    const choice = { ...base, domain: "places" as const, expect: "choice" as const, question: "which one?" };
    const confirm = { ...base, domain: "places" as const, expect: "confirm" as const, question: "want me to look for a table?", chosen: OPTS[1], next: "availability" };
    expect(classify("no the second one", choice)).toMatchObject({ kind: "choice", index: 1 });
    expect(classify("nah none of them", choice)).toEqual({ kind: "no" });
    expect(classify("yeah", confirm)).toEqual({ kind: "yes" });
    expect(classify("sure, go for it", confirm)).toEqual({ kind: "yes" });
    expect(classify("are they open late", confirm)).toEqual({ kind: "step", step: "hours" });
    expect(classify("put it on my calendar", confirm)).toEqual({ kind: "step", step: "calendar" });
    expect(classify("tell me a joke", confirm)).toBeNull();
    const files = { ...base, domain: "files" as const, expect: "none" as const, question: "opened resume.pdf", options: [{ n: 1, name: "resume.pdf", path: "/x/resume.pdf", detail: "resume.pdf" }] };
    expect(classify("yeah", files)).toBeNull();
    expect(classify("what does it say", files)).toEqual({ kind: "step", step: "read" });
    expect(classify("send it to leo", files)).toEqual({ kind: "step", step: "send", arg: "leo" });
  });

  test("reflex hook: his answer to her follow-up escalates to work, which resolves it, and she says the outcome", async () => {
    const clock = new FakeClock(Date.now());
    const ctx = fakeContext();
    ctx.config.demo = false;
    const speech = new FakeSpeech(ctx, clock);
    ctx.provide("speech", speech);
    ctx.provide("brains", new FakeBrains(() => "sure"));
    ctx.provide("memory", new FakeMemory(ctx, []));
    ctx.provide("agency", new FakeAgency());
    const handled: string[] = [];
    const pending = new Set(["the second one"]);
    ctx.provide("followup", { claims: (t: string) => pending.has(t) } as never);
    ctx.provide("work", {
      claims: (t: string) => pending.has(t),
      awaiting: () => false,
      context: () => null,
      resolveRepo: () => null,
      handle: async (t: string) => {
        handled.push(t);
        return { ok: true, summary: "pulled up marufuku, open till 10. want me to look for a table?" };
      },
    });
    const decisions: string[] = [];
    ctx.bus.on("reflex.decision", (e) => void decisions.push(e.data.decision));
    const stop = await startModules(ctx, [reflexModule({ now: clock.now, jev: createJev({}) })]);
    emitAt(ctx, clock, "companion.born", { persona: PERSONA });
    await settle(10);
    clock.advance(120_000);
    speech.said.length = 0;
    decisions.length = 0;
    emitAt(ctx, clock, "voice.final", { text: "the second one" });
    await settle(30);
    expect(decisions).toContain("ESCALATE");
    expect(handled).toEqual(["the second one"]);
    expect(speech.said.map((s) => s.text)).toContain("pulled up marufuku, open till 10. want me to look for a table?");
    await stop();
  });

  test("never quiet: a failed action nobody reports gets a line; reported ones don't", async () => {
    const r = rig();
    r.bus.emit("action.request", { actionId: "a1", kind: "music.play", permission: "SAFE_ACTION", description: "play x", args: {}, needsApproval: false }, "agency");
    r.bus.emit("action.result", { actionId: "a1", ok: false, observation: "spotify isn't running" }, "agency");
    await Bun.sleep(5);
    expect(r.said.at(-1)).toBe("couldn't get spotify to play that. is it open?");
    const n = r.said.length;
    await reported(async () => {
      r.bus.emit("action.request", { actionId: "a2", kind: "music.play", permission: "SAFE_ACTION", description: "play x", args: {}, needsApproval: false }, "agency");
      r.bus.emit("action.result", { actionId: "a2", ok: false, observation: "spotify isn't running" }, "agency");
    });
    await Bun.sleep(5);
    expect(r.said.length).toBe(n);
    r.stop();
  });
});
