import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AnyEnvelope, EventMap } from "@eigenwife/protocol";
import type { Exec } from "../src/agency/types";
import { createCapture, parseDump, type AxDump } from "../src/screen/capture";
import { screenDeictic } from "../src/screen/intent";
import { createScreenJev, parseScreenJev, screenQuestions, screenState } from "../src/screen/jev";
import { screenMemory } from "../src/screen/memory";
import { createScreen, isEve, onScreenLine, type ScreenDeps } from "../src/screen/module";
import { DEFAULT_SETTINGS, parseSettings, privateReason, serializeSettings, type ScreenSettings } from "../src/screen/privacy";
import { luhn, redactScreenText } from "../src/screen/redact";
import { errorLine, summarize } from "../src/screen/summarize";
import { claudeVisionArgs, cleanDescription, describeImage, type VisionEngine } from "../src/screen/vision";
import { fakeContext, FakeClock, FakeMemory, FakeSpeech, settle } from "../src/reflex/testing";

const persona = {
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

const TYPE_ERROR_TEXT = [
  "src/hub.ts",
  "const port = config.server.port;",
  "TypeError: Cannot read properties of undefined (reading 'port')",
  "    at startHub (/Users/matt/dev/eigenwife/packages/core/src/hub.ts:42:17)",
  "    at main (/Users/matt/dev/eigenwife/packages/core/src/main.ts:4:1)",
].join("\n");

// ---------------------------------------------------------------------------
// redaction
// ---------------------------------------------------------------------------

describe("redaction", () => {
  test("emails, phones, cards (Luhn), SSNs, keys and tokens", () => {
    const raw = [
      "mail matt@kalilabs.ai or call +1 (415) 555-0134 / 415.555.0199",
      "card 4242 4242 4242 4242 exp 12/29, not a card: 4242424242424241",
      "ssn 123-45-6789",
      "OPENAI=sk-proj-abcdefghijklmnop1234567890",
      "anthropic sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA",
      "gh ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "api_key = 'supersecretvalue123'",
      "AKIAIOSFODNN7EXAMPLE",
    ].join("\n");
    const r = redactScreenText(raw);
    expect(r.text).not.toContain("matt@kalilabs.ai");
    expect(r.text).toContain("[email]");
    expect(r.text).not.toContain("555-0134");
    expect(r.text).not.toContain("555-0199");
    expect(r.text).toContain("[phone]");
    expect(r.text).not.toContain("4242 4242 4242 4242");
    expect(r.text).toContain("[card]");
    // fails Luhn: left alone (it's just a number)
    expect(r.text).toContain("4242424242424241");
    expect(r.text).not.toContain("123-45-6789");
    for (const secret of ["sk-proj-abcdefghijklmnop", "sk-ant-api03", "ghp_abcdefghij", "eyJhbGciOiJIUzI1NiJ9", "supersecretvalue123", "AKIAIOSFODNN7EXAMPLE"]) expect(r.text).not.toContain(secret);
    expect(r.count).toBeGreaterThanOrEqual(9);
  });

  test("ordinary text passes through untouched", () => {
    const t = "TypeError: Cannot read properties of undefined (reading 'port') at hub.ts:42:17. Price $21.50, 4.6 stars, open until 10pm.";
    expect(redactScreenText(t)).toEqual({ text: t, count: 0 });
  });

  test("luhn", () => {
    expect(luhn("4242424242424242")).toBe(true);
    expect(luhn("4242424242424241")).toBe(false);
    expect(luhn("12345")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// denylist
// ---------------------------------------------------------------------------

describe("denylist", () => {
  const none = { denyApps: [], denyDomains: [] };
  test("password managers, keychain, messages, banks are private apps", () => {
    for (const app of ["1Password 8", "1Password", "Keychain Access", "Messages", "Chase", "Bank of America", "Robinhood", "Passwords", "Wallet", "Mail", "System Settings"]) expect(privateReason({ app }, none)).not.toBeNull();
    expect(privateReason({ app: "Whatever", bundleId: "com.1password.1password" }, none)).not.toBeNull();
    expect(privateReason({ app: "Whatever", bundleId: "com.apple.MobileSMS" }, none)).not.toBeNull();
  });

  test("bank and private domains, including subdomains; bank-looking hosts", () => {
    expect(privateReason({ app: "Google Chrome", url: "https://secure.chase.com/web/auth/dashboard" }, none)).toBe("private site");
    expect(privateReason({ app: "Arc", url: "https://www.paypal.com/myaccount" }, none)).toBe("private site");
    expect(privateReason({ app: "Safari", url: "https://mail.google.com/mail/u/0" }, none)).toBe("private site");
    expect(privateReason({ app: "Safari", url: "https://github.com/MatthewKim323/eigenwife" }, none)).toBeNull();
    expect(privateReason({ app: "Safari", url: "https://banking.firstlocal.com/" }, none)).toBe("private site");
  });

  test("private titles", () => {
    expect(privateReason({ app: "Google Chrome", title: "Sign in to your account" }, none)).toBe("private title");
    expect(privateReason({ app: "Google Chrome", title: "Online Banking | Local CU" }, none)).toBe("private title");
  });

  test("~/.eve/screen.json denylist: apps and domains", () => {
    const s = parseSettings(JSON.stringify({ paused: true, denylist: { apps: ["Figma"], domains: ["*.secret.dev", "notion.so"] } }));
    expect(s.paused).toBe(true);
    expect(privateReason({ app: "Figma" }, s)).toBe("denylisted app");
    expect(privateReason({ app: "Arc", url: "https://x.secret.dev/a" }, s)).toBe("denylisted site");
    expect(privateReason({ app: "Arc", url: "https://www.notion.so/page" }, s)).toBe("denylisted site");
    expect(parseSettings(serializeSettings(s))).toEqual(s);
    expect(parseSettings("not json")).toEqual(DEFAULT_SETTINGS);
  });

  test("ordinary apps and sites are fine", () => {
    for (const w of [{ app: "Cursor", title: "hub.ts - eigenwife" }, { app: "TextEdit", title: "notes.txt" }, { app: "Google Chrome", url: "https://www.ssense.com/en-us/men/product/x" }]) expect(privateReason(w, none)).toBeNull();
  });

  test("Eve's own windows are never read", () => {
    expect(isEve({ app: "Electron" })).toBe(true);
    expect(isEve({ app: "Google Chrome", url: "http://127.0.0.1:5173/?mode=overlay" })).toBe(true);
    expect(isEve({ app: "Google Chrome", title: "Eigenwife" })).toBe(true);
    expect(isEve({ app: "TextEdit", title: "notes" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// secure fields
// ---------------------------------------------------------------------------

describe("secure fields", () => {
  test("parseDump drops secure roles and never keeps a secure focused value or selection", () => {
    const d = parseDump(
      JSON.stringify({
        ok: true,
        app: "Safari",
        texts: [
          { r: "AXStaticText", t: "Log in" },
          { r: "AXSecureTextField", t: "hunter2" },
        ],
        selected: "hunter2",
        focusedValue: "hunter2",
        focusedRole: "AXSecureTextField",
        secureFocused: true,
      }),
    );
    expect(JSON.stringify(d)).not.toContain("hunter2");
    expect(d.texts).toEqual([{ r: "AXStaticText", t: "Log in" }]);
    expect(d.secureFocused).toBe(true);
  });

  test("the helper skips AXSecureTextField before reading any value", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "..", "watcher", "screen-ax.swift"), "utf8");
    // the secure check comes before any value read in the walk, and the focused element check guards its value
    const walk = src.slice(src.indexOf("while let (el, depth)"));
    expect(walk.indexOf("isSecure(role, subrole)")).toBeLessThan(walk.indexOf("kAXValueAttribute"));
    expect(src).toContain("never read a secure field");
  });
});

// ---------------------------------------------------------------------------
// summarizer
// ---------------------------------------------------------------------------

describe("summarizer", () => {
  test("TypeError in an editor: debugging, the error with its file and line", () => {
    const d = summarize({ app: "Cursor", title: "hub.ts - eigenwife", texts: [{ r: "AXTextArea", t: TYPE_ERROR_TEXT }] });
    expect(d.guess.mode).toBe("debugging");
    expect(d.error).toBe("TypeError: Cannot read properties of undefined (reading 'port') (hub.ts line 42)");
    expect(d.summary).toStartWith("Cursor: hub.ts - eigenwife · error: TypeError");
    expect(d.summary.length).toBeLessThanOrEqual(300);
    expect(d.errorKey).toBeDefined();
  });

  test("the same error with new line numbers keeps the same key", () => {
    expect(errorLine(["TypeError: x is not a function at a.ts:10:2"])!.key).toBe(errorLine(["TypeError: x is not a function at a.ts:99:7"])!.key);
  });

  test("shopping: mode, price in the summary, more interesting than code", () => {
    const d = summarize({
      app: "Google Chrome",
      title: "Oversized Wool Jacket in Taupe | SSENSE",
      url: "https://www.ssense.com/en-us/men/product/x",
      texts: [
        { r: "AXHeading", t: "Oversized Wool Jacket" },
        { r: "AXStaticText", t: "$1,250 USD" },
        { r: "AXStaticText", t: "Relaxed fit wool jacket with notched lapels and a two button closure." },
      ],
    });
    expect(d.guess.mode).toBe("shopping");
    expect(d.summary).toContain("$1,250");
    expect(d.guess.interesting).toBeGreaterThan(0.6);
    const code = summarize({ app: "Cursor", title: "a.ts", texts: [{ r: "AXTextArea", t: "export const a = 1;\nexport const b = 2;\nexport const c = 3;" }] });
    expect(code.guess.interesting).toBeLessThan(d.guess.interesting);
  });

  test("the summary is compact: a long document never goes out whole", () => {
    const long = Array.from({ length: 200 }, (_, i) => `paragraph ${i} with some words that go on for a while about nothing in particular.`).join("\n");
    const d = summarize({ app: "TextEdit", title: "essay.txt", texts: [{ r: "AXTextArea", t: long }] });
    expect(d.summary.length).toBeLessThanOrEqual(300);
    expect(d.summary).not.toContain("paragraph 50");
  });

  test("sensitive content is flagged locally", () => {
    expect(summarize({ app: "Notes", title: "stuff", texts: [{ r: "AXTextArea", t: "my recovery phrase is apple banana ..." }] }).guess.sensitive).toBe(true);
    expect(summarize({ app: "Notes", title: "stuff", texts: [{ r: "AXTextArea", t: "groceries: eggs, milk" }] }).guess.sensitive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Jev
// ---------------------------------------------------------------------------

describe("screen jev", () => {
  const digest = summarize({ app: "Cursor", title: "hub.ts - eigenwife", texts: [{ r: "AXTextArea", t: TYPE_ERROR_TEXT }] });
  const answers = {
    model: "jev-1.13.0",
    answers: {
      mode: { type: "choice", choice: "debugging", probabilities: { debugging: 0.9 } },
      stuck: { type: "noul", noul: 0.82 },
      interesting: { type: "score", score: 1.2 },
      sensitive: { type: "noul", noul: 0.03 },
    },
  };

  test("request shape: model, compact state (summary, never raw text), four typed questions", async () => {
    let body: any;
    let url = "";
    const jev = createScreenJev({
      apiKey: "gw",
      url: "https://ai-gateway.vercel.sh/v1/evaluate",
      model: "typesafe-ai/jev",
      fetchImpl: (async (u: string, init: RequestInit) => {
        url = u;
        body = JSON.parse(String(init.body));
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer gw");
        return Response.json(answers);
      }) as never,
    });
    const r = await jev.judge({ digest, stuckMs: 6 * 60_000, idleSeconds: 12 });
    expect(url).toBe("https://ai-gateway.vercel.sh/v1/evaluate");
    expect(body.model).toBe("typesafe-ai/jev");
    expect(Object.keys(body.questions)).toEqual(["mode", "stuck", "interesting", "sensitive"]);
    expect(body.questions.mode.type).toBe("choice");
    expect(Object.keys(body.questions.mode.criteria)).toContain("debugging");
    expect(body.questions.stuck.type).toBe("noul");
    expect(body.questions.interesting.type).toBe("score");
    expect(body.questions.sensitive.type).toBe("noul");
    expect(body.state.summary).toBe(digest.summary);
    expect(body.state.same_error_for_seconds).toBe(360);
    expect(JSON.stringify(body)).not.toContain("at main (");
    expect(r.by).toBe("jev");
    expect(r.scores).toEqual({ mode: "debugging", stuck: true, interesting: 0.4, sensitive: false });
  });

  test("parse: missing extras fall back to local, bad mode throws", () => {
    const local = { mode: "coding" as const, stuck: false, interesting: 0.2, sensitive: true };
    expect(parseScreenJev({ answers: { mode: { choice: "Reading" } } }, local)).toEqual({ mode: "reading", stuck: false, interesting: 0.2, sensitive: true });
    expect(() => parseScreenJev({ answers: { mode: { choice: "dancing" } } }, local)).toThrow();
    expect(() => parseScreenJev({}, local)).toThrow();
  });

  test("fallback to local on http error, timeout, garbage; breaker opens after 3", async () => {
    let calls = 0;
    const clock = new FakeClock();
    const bad = createScreenJev({ apiKey: "k", now: clock.now, fetchImpl: (async () => (calls++, new Response("nope", { status: 500 }))) as never });
    for (let i = 0; i < 3; i++) expect((await bad.judge({ digest, stuckMs: 0, idleSeconds: 1 })).by).toBe("local");
    const r = await bad.judge({ digest, stuckMs: 0, idleSeconds: 1 });
    expect(r.reason).toBe("jev breaker open");
    expect(calls).toBe(3);
    const slow = createScreenJev({ apiKey: "k", timeoutMs: 20, fetchImpl: ((_u: string, i: RequestInit) => new Promise((_r, rej) => i.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as never });
    const s = await slow.judge({ digest, stuckMs: 0, idleSeconds: 1 });
    expect(s.by).toBe("local");
    expect(s.reason).toContain("timeout");
    const junk = createScreenJev({ apiKey: "k", fetchImpl: (async () => Response.json({ hello: 1 })) as never });
    expect((await junk.judge({ digest, stuckMs: 0, idleSeconds: 1 })).by).toBe("local");
  });

  test("no key: local; stuck needs time; local sensitive is a floor", async () => {
    const local = createScreenJev({ stuckMs: 5 * 60_000 });
    expect((await local.judge({ digest, stuckMs: 60_000, idleSeconds: 1 })).scores.stuck).toBe(false);
    expect((await local.judge({ digest, stuckMs: 6 * 60_000, idleSeconds: 1 })).scores.stuck).toBe(true);
    const eager = createScreenJev({ apiKey: "k", fetchImpl: (async () => Response.json(answers)) as never });
    expect((await eager.judge({ digest, stuckMs: 10_000, idleSeconds: 1 })).scores.stuck).toBe(false);
    const priv = summarize({ app: "Notes", texts: [{ r: "AXTextArea", t: "seed phrase: ..." }] });
    expect((await eager.judge({ digest: priv, stuckMs: 0, idleSeconds: 1 })).scores.sensitive).toBe(true);
  });

  test("questions and state are stable", () => {
    expect(screenQuestions().interesting.criteria.length).toBe(4);
    expect(Object.keys(screenState({ digest, stuckMs: 0, idleSeconds: null }))).toEqual(["task", "app", "summary", "error_visible", "same_error_for_seconds", "seconds_since_input"]);
  });
});

// ---------------------------------------------------------------------------
// memory policy
// ---------------------------------------------------------------------------

describe("memory policy", () => {
  const base = { kind: "observation" as const, app: "Chrome", summary: "Google Chrome: Wool Jacket | SSENSE · $1,250", now: 1_000_000 };
  const s = (o: Partial<{ mode: any; interesting: number; sensitive: boolean }> = {}) => ({ mode: "shopping" as const, stuck: false, interesting: 0.8, sensitive: false, ...o });
  test("interesting, non-sensitive observations become short memories", () => {
    const m = screenMemory({ ...base, scores: s() });
    expect(m?.policy).toBe("STORE_SHORT_TERM");
    expect(m?.content).toStartWith("Was looking at Google Chrome: Wool Jacket");
    expect(m?.tags).toContain("screen");
  });
  test("sensitive, private, boring, coding, redacted, or too soon: nothing", () => {
    expect(screenMemory({ ...base, scores: s({ sensitive: true }) })).toBeNull();
    expect(screenMemory({ ...base, private: true, scores: s() })).toBeNull();
    expect(screenMemory({ ...base, scores: s({ interesting: 0.3 }) })).toBeNull();
    expect(screenMemory({ ...base, scores: s({ mode: "coding" }) })).toBeNull();
    expect(screenMemory({ ...base, summary: "mail from [email]", scores: s() })).toBeNull();
    expect(screenMemory({ ...base, lastAt: base.now - 60_000, scores: s() })).toBeNull();
  });
  test("a vision description for a question is kept even at lower interest", () => {
    expect(screenMemory({ ...base, kind: "vision", scores: s({ interesting: 0.3 }) })?.content).toStartWith("Showed Eve");
  });
});

// ---------------------------------------------------------------------------
// deictic phrases
// ---------------------------------------------------------------------------

test("screen deixis: what counts as pointing at the screen", () => {
  for (const t of ["what do you think of this", "thoughts?", "what's this", "can you see this", "look at this", "is this mid?", "should i buy this", "what's wrong with this", "how does that look"]) expect(screenDeictic(t)).toBe(true);
  for (const t of ["that's funny", "i love this song so much honestly", "what time is it", "ok", "remind me to stretch at 5"]) expect(screenDeictic(t)).toBe(false);
});

// ---------------------------------------------------------------------------
// capture: temp files
// ---------------------------------------------------------------------------

describe("capture", () => {
  const home = () => mkdtempSync(join(tmpdir(), "eve-screen-"));
  const fakeExec = (log: string[][], write = true): Exec =>
    (async (argv: string[]) => {
      log.push(argv);
      if (argv[0] === "screencapture" && write) writeFileSync(argv.at(-1)!, Buffer.alloc(4096, 1));
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }) as Exec;

  test("captures exactly one window by id, hands the file over, deletes it after", async () => {
    const h = home();
    const log: string[][] = [];
    const cap = createCapture({ exec: fakeExec(log), eveHome: h, helper: "/fake/screen-ax" });
    let seen = "";
    const r = await cap.withWindowImage(4242, async (p) => {
      seen = p;
      expect(existsSync(p)).toBe(true);
      expect(p.startsWith(join(h, "tmp"))).toBe(true);
      return "desc";
    });
    expect(r).toEqual({ ok: true, value: "desc" });
    expect(existsSync(seen)).toBe(false);
    expect(log[0]!.slice(0, 5)).toEqual(["screencapture", "-l", "4242", "-x", "-o"]);
    rmSync(h, { recursive: true, force: true });
  });

  test("deleted even when the vision call throws; refuses without a window id", async () => {
    const h = home();
    const cap = createCapture({ exec: fakeExec([]), eveHome: h, helper: "/fake/screen-ax" });
    let seen = "";
    const r = await cap.withWindowImage(7, async (p) => {
      seen = p;
      throw new Error("vision down");
    });
    expect(r.ok).toBe(false);
    expect(existsSync(seen)).toBe(false);
    expect((await cap.withWindowImage(0, async () => 1)).ok).toBe(false);
    rmSync(h, { recursive: true, force: true });
  });

  test("a failed capture (no permission) is an error, not an empty image", async () => {
    const h = home();
    const cap = createCapture({ exec: fakeExec([], false), eveHome: h, helper: "/fake/screen-ax" });
    const r = await cap.withWindowImage(7, async () => "x");
    expect(r.ok).toBe(false);
    rmSync(h, { recursive: true, force: true });
  });

  test("sweep removes leftovers from a crash", () => {
    const h = home();
    const cap = createCapture({ exec: fakeExec([]), eveHome: h, helper: "/fake/screen-ax" });
    const { mkdirSync } = require("fs");
    mkdirSync(cap.tmpDir, { recursive: true });
    writeFileSync(join(cap.tmpDir, "screen-old.jpg"), "x");
    writeFileSync(join(cap.tmpDir, "other.txt"), "x");
    expect(cap.sweep()).toBe(1);
    expect(existsSync(join(cap.tmpDir, "screen-old.jpg"))).toBe(false);
    expect(existsSync(join(cap.tmpDir, "other.txt"))).toBe(true);
    rmSync(h, { recursive: true, force: true });
  });

  test("dump passes pid and private hosts to the helper", async () => {
    const log: string[][] = [];
    const exec = (async (argv: string[]) => {
      log.push(argv);
      return { code: 0, stdout: JSON.stringify({ ok: true, app: "TextEdit", texts: [], windowId: 9 }), stderr: "", timedOut: false };
    }) as Exec;
    const cap = createCapture({ exec, eveHome: home(), helper: "/fake/screen-ax" });
    const d = await cap.dump({ pid: 321, denyHosts: ["chase.com", "x.dev"] });
    expect(d.windowId).toBe(9);
    expect(log[0]).toEqual(["/fake/screen-ax", "dump", "--max", "8000", "--pid", "321", "--deny-hosts", "chase.com,x.dev"]);
  });
});

// ---------------------------------------------------------------------------
// vision engines
// ---------------------------------------------------------------------------

describe("vision", () => {
  const engine = (name: string, fn: () => Promise<string>, configured = true): VisionEngine => ({ name, configured: () => configured, describe: fn });
  test("first configured engine that answers wins; description cleaned and redacted", async () => {
    const r = await describeImage(
      [
        engine("gateway", async () => "x", false),
        engine("anthropic", async () => {
          throw new Error("429");
        }),
        engine("claude", async () => "**TextEdit** window with a TypeError in hub.ts — line 42. Contact matt@kalilabs.ai. Third sentence."),
      ],
      { imagePath: "/tmp/x.jpg" },
    );
    expect(r.ok).toBe(true);
    expect(r.by).toBe("claude");
    expect(r.description).toBe("TextEdit window with a TypeError in hub.ts , line 42. Contact [email].");
  });
  test("PRIVATE means private; nothing configured is an honest failure", async () => {
    expect(cleanDescription("PRIVATE").private).toBe(true);
    const r = await describeImage([engine("gateway", async () => "x", false)], { imagePath: "/tmp/x.jpg" });
    expect(r.ok).toBe(false);
  });
  test("claude CLI look: Read tool only, only the temp dir, no MCP, no session", () => {
    const a = claudeVisionArgs("/bin/claude", { imagePath: "/Users/m/.eve/tmp/screen-1.jpg" });
    expect(a).toContain("--strict-mcp-config");
    expect(a).toContain("--no-session-persistence");
    expect(a[a.indexOf("--tools") + 1]).toBe("Read");
    expect(a[a.indexOf("--add-dir") + 1]).toBe("/Users/m/.eve/tmp");
    expect(a[2]).toContain("/Users/m/.eve/tmp/screen-1.jpg");
  });
});

// ---------------------------------------------------------------------------
// the module: level 2 loop, level 3 looks, pause
// ---------------------------------------------------------------------------

function screenRig(o: { dump?: Partial<AxDump>; front?: { app?: string; bundleId?: string; pid?: number }; idle?: number; env?: Record<string, string>; autoVision?: boolean; settings?: Partial<ScreenSettings>; jev?: ScreenDeps["jev"] } = {}) {
  const clock = new FakeClock();
  const ctx = fakeContext();
  const speech = new FakeSpeech(ctx, clock);
  ctx.provide("speech", speech);
  const writes: { content: string; policy?: string }[] = [];
  const memory = new FakeMemory(ctx);
  memory.write = (async (rec: { content: string }, policy?: string) => {
    writes.push({ content: rec.content, policy });
    return null;
  }) as never;
  ctx.provide("memory", memory);
  const events: AnyEnvelope[] = [];
  ctx.bus.on("*", (e: AnyEnvelope) => events.push(e));
  let dump: AxDump = { ok: true, app: "TextEdit", bundleId: "com.apple.TextEdit", pid: 55, windowId: 101, title: "bug.txt", texts: [{ r: "AXTextArea", t: TYPE_ERROR_TEXT }], ...o.dump };
  let front = o.front ?? { app: "TextEdit", bundleId: "com.apple.TextEdit", pid: 55 };
  let idle = o.idle ?? 10;
  let settings: ScreenSettings = { ...structuredClone(DEFAULT_SETTINGS), ...o.settings };
  const saved: ScreenSettings[] = [];
  const dumps: { pid?: number }[] = [];
  const captures: number[] = [];
  const visions: { question?: string; hint?: string }[] = [];
  const s = createScreen(ctx, {
    poll: false,
    autoVision: o.autoVision,
    deps: {
      now: clock.now,
      env: (n) => o.env?.[n] ?? "",
      front: async () => front,
      idleSeconds: async () => idle,
      loadSettings: () => settings,
      saveSettings: (x) => {
        settings = x;
        saved.push(structuredClone(x));
      },
      jev: o.jev ?? createScreenJev({ stuckMs: 5 * 60_000 }),
      capture: {
        dump: async (x) => {
          dumps.push(x ?? {});
          return dump;
        },
        permissions: async () => ({ accessibility: true, screenRecording: true }),
        withWindowImage: async (id, use) => {
          captures.push(id);
          return { ok: true, value: await use("/fake/tmp/screen-x.jpg") };
        },
        sweep: () => 0,
      },
      vision: async (req) => {
        visions.push({ question: req.question, hint: req.hint });
        return { ok: true, description: "A TextEdit window showing a TypeError about reading 'port' in hub.ts line 42.", by: "fake", ms: 5 };
      },
    },
  });
  const of = <K extends keyof EventMap>(type: K) => events.filter((e) => e.type === type).map((e) => e.data as EventMap[K]);
  return {
    ctx,
    clock,
    s,
    speech,
    writes,
    saved,
    dumps,
    captures,
    visions,
    of,
    born: () => ctx.bus.emit("companion.born", { persona }, "test"),
    setDump: (d: Partial<AxDump>) => (dump = { ...dump, ...d }),
    setFront: (f: typeof front) => (front = f),
    setIdle: (n: number) => (idle = n),
    settings: () => settings,
  };
}

describe("screen module", () => {
  test("level 2: reads the focused window, emits a compact observation, sets the world slot, flashes the chip", async () => {
    const r = screenRig();
    r.born();
    expect(await r.s.tick()).toBe("observed (local)");
    const obs = r.of("screen.observation");
    expect(obs.length).toBe(1);
    expect(obs[0]!.app).toBe("TextEdit");
    expect(obs[0]!.error).toContain("TypeError");
    expect(obs[0]!.scores.mode).toBe("debugging");
    expect(obs[0]!.by).toBe("local");
    // the raw text is never on the bus
    expect(JSON.stringify(obs)).not.toContain("at main (");
    expect(r.of("screen.looking")).toEqual([{ level: 2, active: true }]);
    expect(r.ctx.world().slots.screen?.on_screen).toContain("TypeError");
    expect(r.dumps[0]!.pid).toBe(55);
    r.s.stop();
  });

  test("only when changed: an unchanged screen is not re-sent; an error re-judges once a minute so stuck can grow", async () => {
    const r = screenRig();
    r.born();
    await r.s.tick();
    r.clock.advance(7_000);
    expect(await r.s.tick()).toBe("unchanged");
    for (let i = 0; i < 6; i++) {
      r.clock.advance(61_000);
      await r.s.tick();
    }
    const obs = r.of("screen.observation");
    expect(obs.length).toBe(7);
    expect(obs.at(-1)!.stuckMs).toBeGreaterThanOrEqual(6 * 60_000);
    expect(obs.at(-1)!.scores.stuck).toBe(true);
    expect(r.ctx.world().slots.screen?.on_screen).toContain("same error for ~6 min");
    // a different screen without the error resets it
    r.setDump({ texts: [{ r: "AXTextArea", t: "all good now, tests pass and the build is green" }] });
    r.clock.advance(7_000);
    await r.s.tick();
    expect(r.of("screen.observation").at(-1)!.error).toBeUndefined();
    r.s.stop();
  });

  test("private apps: skipped before any accessibility read, shown only as 'private app'", async () => {
    const r = screenRig({ front: { app: "1Password 8", pid: 9 } });
    r.born();
    expect(await r.s.tick()).toBe("private");
    expect(r.dumps.length).toBe(0);
    expect(r.of("screen.looking").length).toBe(0);
    const obs = r.of("screen.observation");
    expect(obs[0]).toEqual({ app: "private app", summary: "", scores: { mode: "idle", stuck: false, interesting: 0, sensitive: true }, by: "local", private: true });
    expect(r.ctx.world().slots.screen?.on_screen).toBe("a private app (not looking)");
    // a private site found by the helper is dropped the same way
    r.setFront({ app: "Google Chrome", pid: 10 });
    r.setDump({ app: "Google Chrome", private: true, texts: [] });
    expect(await r.s.tick()).toBe("private");
    r.s.stop();
  });

  test("screen.json denylist and locally sensitive text never reach Jev", async () => {
    let jevCalls = 0;
    const jev = { judge: async () => (jevCalls++, { scores: { mode: "reading" as const, stuck: false, interesting: 0.5, sensitive: false }, by: "jev" as const, latencyMs: 1 }), status: () => ({ remote: true, failures: 0 }) };
    const r = screenRig({ jev, settings: { denyApps: ["TextEdit"] } });
    r.born();
    expect(await r.s.tick()).toBe("private");
    const r2 = screenRig({ jev, dump: { texts: [{ r: "AXTextArea", t: "routing number and account number for the transfer" }] } });
    r2.born();
    expect(await r2.s.tick()).toBe("sensitive (local)");
    expect(jevCalls).toBe(0);
    expect(r2.writes.length).toBe(0);
    r.s.stop();
    r2.s.stop();
  });

  test("Jev says sensitive: dropped, not stored, no summary on the bus", async () => {
    const jev = { judge: async () => ({ scores: { mode: "social" as const, stuck: false, interesting: 0.9, sensitive: true }, by: "jev" as const, latencyMs: 1 }), status: () => ({ remote: true, failures: 0 }) };
    const r = screenRig({ jev, dump: { texts: [{ r: "AXStaticText", t: "a very personal conversation about feelings and family stuff" }] } });
    r.born();
    expect(await r.s.tick()).toBe("sensitive (jev)");
    expect(r.of("screen.observation")[0]!.private).toBe(true);
    expect(r.of("screen.observation")[0]!.summary).toBe("");
    expect(r.writes.length).toBe(0);
    r.s.stop();
  });

  test("not active (idle), not born, or Eve in front: no read", async () => {
    const r = screenRig({ idle: 300 });
    expect(await r.s.tick()).toBe("unborn");
    r.born();
    expect(await r.s.tick()).toBe("inactive");
    r.setIdle(3);
    r.setFront({ app: "Electron", pid: 1 });
    expect(await r.s.tick()).toBe("eve");
    expect(r.s.service.canLook()).toBe(false);
    expect(r.dumps.length).toBe(0);
    r.s.stop();
  });

  test("memory: interesting non-sensitive observations become short memories, rate limited", async () => {
    const jev = { judge: async () => ({ scores: { mode: "shopping" as const, stuck: false, interesting: 0.85, sensitive: false }, by: "jev" as const, latencyMs: 1 }), status: () => ({ remote: true, failures: 0 }) };
    const r = screenRig({ jev, front: { app: "Google Chrome", pid: 3 }, dump: { app: "Google Chrome", title: "Wool Jacket | SSENSE", url: "https://www.ssense.com/p/1", texts: [{ r: "AXStaticText", t: "$1,250 oversized wool jacket" }] } });
    r.born();
    await r.s.tick();
    expect(r.writes).toEqual([{ content: expect.stringContaining("Was looking at Google Chrome: Wool Jacket") as unknown as string, policy: "STORE_SHORT_TERM" }]);
    r.setDump({ title: "Another Jacket | SSENSE" });
    r.clock.advance(60_000);
    await r.s.tick();
    expect(r.writes.length).toBe(1);
    r.s.stop();
  });

  test("level 3: captures only the focused window, describes it, clear chip on then off, image never stored", async () => {
    const r = screenRig();
    r.born();
    await r.s.tick();
    const res = await r.s.look("deictic", { question: "what do you think of this" });
    expect(res.ok).toBe(true);
    expect(res.description).toContain("TypeError");
    expect(r.captures).toEqual([101]);
    expect(r.visions[0]!.question).toBe("what do you think of this");
    expect(r.visions[0]!.hint).toContain("TypeError");
    expect(r.of("screen.looking").filter((l) => l.level === 3)).toEqual([
      { level: 3, active: true, reason: "deictic" },
      { level: 3, active: false, reason: "deictic" },
    ]);
    const v = r.of("screen.vision")[0]!;
    expect(v.ok).toBe(true);
    expect(JSON.stringify(v)).not.toContain(".jpg");
    r.s.stop();
  });

  test("level 3 rate limits: deictic 8s apart, stuck once per 10 min", async () => {
    const r = screenRig();
    r.born();
    expect((await r.s.look("deictic")).ok).toBe(true);
    expect((await r.s.look("deictic")).error).toBe("looked a moment ago");
    r.clock.advance(9_000);
    expect((await r.s.look("deictic")).ok).toBe(true);
    expect((await r.s.look("stuck")).ok).toBe(true);
    r.clock.advance(5 * 60_000);
    expect((await r.s.look("stuck")).ok).toBe(false);
    r.clock.advance(6 * 60_000);
    expect((await r.s.look("stuck")).ok).toBe(true);
    r.s.stop();
  });

  test("level 3 never captures a private app, Eve, or while paused", async () => {
    const r = screenRig({ front: { app: "Messages", pid: 2 } });
    r.born();
    expect((await r.s.look("deictic")).error).toBe("private app");
    r.setFront({ app: "Electron", pid: 1 });
    expect((await r.s.look("deictic")).ok).toBe(false);
    r.setFront({ app: "TextEdit", pid: 55 });
    r.ctx.bus.emit("screen.pause", { paused: true }, "test");
    expect((await r.s.look("deictic")).error).toBe("screen paused");
    expect(r.captures.length).toBe(0);
    r.s.stop();
  });

  test("auto vision (c) is off by default; on, it looks at most once per 2 min when idle and interesting", async () => {
    const jev = { judge: async () => ({ scores: { mode: "video" as const, stuck: false, interesting: 0.9, sensitive: false }, by: "jev" as const, latencyMs: 1 }), status: () => ({ remote: true, failures: 0 }) };
    const off = screenRig({ jev, idle: 20 });
    off.born();
    await off.s.tick();
    await settle(5);
    expect(off.captures.length).toBe(0);
    const on = screenRig({ jev, idle: 20, autoVision: true });
    on.born();
    await on.s.tick();
    await settle(5);
    expect(on.captures.length).toBe(1);
    on.setDump({ title: "next video" });
    on.clock.advance(30_000);
    await on.s.tick();
    await settle(5);
    expect(on.captures.length).toBe(1);
    on.setDump({ title: "third video" });
    on.clock.advance(2 * 60_000);
    await on.s.tick();
    await settle(5);
    expect(on.captures.length).toBe(2);
    off.s.stop();
    on.s.stop();
  });

  test("pause: screen.pause persists to screen.json and stops reads; attention.pause stops reads without persisting", async () => {
    const r = screenRig();
    r.born();
    r.ctx.bus.emit("screen.pause", { paused: true, by: "overlay" }, "overlay");
    expect(r.settings().paused).toBe(true);
    expect(r.saved.at(-1)!.paused).toBe(true);
    expect(await r.s.tick()).toBe("paused");
    expect(r.s.service.current()).toBeNull();
    expect(r.s.service.canLook()).toBe(false);
    r.ctx.bus.emit("screen.pause", { paused: false }, "overlay");
    expect(await r.s.tick()).toBe("observed (local)");
    const n = r.saved.length;
    r.ctx.bus.emit("attention.pause", { paused: true }, "overlay");
    r.setDump({ title: "changed" });
    expect(await r.s.tick()).toBe("paused");
    expect(r.saved.length).toBe(n);
    r.ctx.bus.emit("attention.pause", { paused: false }, "overlay");
    expect(await r.s.tick()).toBe("observed (local)");
    expect(r.dumps.length).toBe(2);
    r.s.stop();
  });

  test("pause is restored from screen.json on start", async () => {
    const r = screenRig({ settings: { paused: true } });
    r.born();
    expect(await r.s.tick()).toBe("paused");
    r.s.stop();
  });

  test("kill switch: EVE_SCREEN=0 never reads or looks", async () => {
    const r = screenRig({ env: { EVE_SCREEN: "0" } });
    r.born();
    expect(await r.s.tick()).toBe("paused");
    expect((await r.s.look("deictic")).error).toContain("EVE_SCREEN=0");
    expect(r.s.status().enabled).toBe(false);
    expect(r.dumps.length + r.captures.length).toBe(0);
    r.s.stop();
  });

  test("missing permission: she says how to grant it once, ever", async () => {
    const r = screenRig();
    r.born();
    r.setDump({ ok: false, error: "accessibility" });
    await r.s.tick();
    await settle(3);
    r.clock.advance(60_000);
    r.setDump({ title: "x" });
    await r.s.tick();
    await settle(3);
    expect(r.speech.said.length).toBe(1);
    expect(r.speech.said[0]!.text).toContain("accessibility");
    expect(r.settings().told.accessibility).toBe(true);
    r.s.stop();
  });

  test("onScreenLine", () => {
    expect(onScreenLine({ app: "VS Code", summary: "VS Code: hub.ts · error: TypeError (hub.ts line 42)", mode: "debugging", stuck: true, interesting: 0.3, error: "TypeError", stuckMs: 6 * 60_000, at: 0 })).toBe(
      "VS Code: hub.ts · error: TypeError (hub.ts line 42), same error for ~6 min",
    );
  });
});
