import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DEFAULT_RELATIONSHIP } from "@eigenwife/protocol";
import { claudeCliBackend, claudePersonaArgs, featherlessBackend, openAiBackend, openAiBody, parseClaudeStream } from "../src/brains/chat";
import { claudeEngine, claudeFrontierArgs, codexArgs, codexEngine, jabbyEngine, parseClaudeRun, parseCodexRun, runChain, splitJabbyChunk, type BrainEvent } from "../src/brains/frontier";
import { HealthBook } from "../src/brains/health";
import { cliEnv, HttpError } from "../src/brains/io";
import { buildPersonaPrompt, DEFAULT_EVE } from "../src/brains/prompt";
import { createBrains, OFFLINE_LINES, type BrainsDeps } from "../src/brains/service";
import { brainsModule, haremBrain } from "../src/brains/module";
import { startCore, type RunningCore } from "../src/index";
import { collect, fakeIO, fakeProc, openAiSse, scriptedBackend, scriptedEngine, sse } from "./brains.fakes";

async function* lines(xs: unknown[]) {
  for (const x of xs) yield typeof x === "string" ? x : JSON.stringify(x);
}

function brains(over: Partial<BrainsDeps> = {}) {
  return createBrains({
    io: fakeIO(),
    jabbyUrl: "http://jabby.test",
    persona: () => null,
    relationship: () => null,
    world: () => "- scene: desktop\n- user is looking at: Garlic Knockout Ramen, $21",
    ...over,
  });
}

describe("persona prompt", () => {
  test("carries persona, dials, relationship, world, extra, marks and word cap", () => {
    const m = buildPersonaPrompt({
      persona: { ...DEFAULT_EVE, name: "Mina" },
      relationship: { ...DEFAULT_RELATIONSHIP, banter: 0.9 },
      world: "- user is looking at: Garlic Knockout Ramen, $21",
      req: { event: "user asked", behavior: "tease", userText: "thoughts?", extra: "memory: hates $28 ramen", maxWords: 9 },
    });
    expect(m.system).toContain("you are Mina.");
    expect(m.system).toContain("humor 0.80");
    expect(m.system).toContain("banter 0.90");
    expect(m.system).toContain("tease a little more");
    expect(m.system).toContain("Garlic Knockout Ramen, $21");
    expect(m.system).toContain("memory: hates $28 ramen");
    expect(m.system).toContain("[mood:<neutral|happy|annoyed|thinking|surprised|smug|sad> 0.0-1.0]");
    expect(m.system).toContain("[pause:0.5]");
    expect(m.system).toContain("never use em dashes");
    expect(m.user).toContain("they said: thoughts?");
    expect(m.user).toContain("at most 9 words");
    expect(m.system).not.toMatch(/[—–]/);
  });
  test("marks:false tells the model not to use them", () => {
    const m = buildPersonaPrompt({ persona: DEFAULT_EVE, world: "", req: { event: "e", behavior: "b", marks: false } });
    expect(m.system).toContain("do not use any [bracket] marks");
    expect(m.system).not.toContain("[pause:0.5]");
  });
});

describe("persona routing", () => {
  test("falls back in order: featherless, openai, anthropic, claude-cli", async () => {
    const calls: string[] = [];
    const b = brains({
      personaBackends: [
        scriptedBackend("featherless", new HttpError(429, "busy", "featherless"), calls),
        scriptedBackend("openai", new HttpError(500, "boom", "openai"), calls),
        scriptedBackend("anthropic", ["[mood:smug 0.6] so.", " apparently this is your type."], calls),
        scriptedBackend("claude-cli", ["never"], calls),
      ],
    });
    const out = (await collect(b.persona({ event: "birth", behavior: "tease" }))).join("");
    expect(calls).toEqual(["featherless", "openai", "anthropic"]);
    expect(out).toBe("[mood:smug 0.6] so. apparently this is your type.");
    expect(b.lastPersona()?.backend).toBe("anthropic");
    expect(b.lastPersona()?.errors.length).toBe(2);
  });

  test("error text from a backend is never spoken: it falls back instead", async () => {
    const b = brains({
      personaBackends: [scriptedBackend("claude-cli", ["You've hit your limit", " · resets 5pm"]), scriptedBackend("anthropic", ["mm. fine."])],
    });
    const out = (await collect(b.persona({ event: "x", behavior: "react" }))).join("");
    expect(out).toBe("mm. fine.");
    expect(out).not.toContain("limit");
    expect(b.lastPersona()?.errors[0]).toContain("error text suppressed");
  });

  test("a failed backend is parked and skipped next time", async () => {
    const calls: string[] = [];
    const b = brains({ personaBackends: [scriptedBackend("openai", new HttpError(429, "insufficient_quota", "openai"), calls), scriptedBackend("claude-cli", ["ok."], calls)] });
    await collect(b.persona({ event: "x", behavior: "y" }));
    await collect(b.persona({ event: "x", behavior: "y" }));
    expect(calls).toEqual(["openai", "claude-cli", "claude-cli"]);
    expect(b.status().openai).toBe(false);
    expect(b.status()["claude-cli"]).toBe(true);
  });

  test("boot probe parks a dead key so no real turn pays for it", async () => {
    const calls: string[] = [];
    const b = brains({
      personaBackends: [scriptedBackend("openai", new HttpError(429, "insufficient_quota", "openai"), calls), scriptedBackend("anthropic", ["ok"], calls), scriptedBackend("claude-cli", ["hi."], calls)],
    });
    expect(await b.probe()).toEqual({ openai: false, anthropic: true });
    expect(b.status().openai).toBe(false);
    calls.length = 0;
    await collect(b.persona({ event: "x", behavior: "y" }));
    expect(calls).toEqual(["anthropic"]);
  });

  test("empty replies count as failures", async () => {
    const b = brains({ personaBackends: [scriptedBackend("featherless", []), scriptedBackend("openai", ["hi."])] });
    expect((await collect(b.persona({ event: "x", behavior: "y" }))).join("")).toBe("hi.");
  });

  test("mid-stream failure keeps what was said and doesn't restart in another voice", async () => {
    const calls: string[] = [];
    const b = brains({
      personaBackends: [
        scriptedBackend(
          "featherless",
          async function* () {
            yield "seven thirty. cheap ramen. ";
            throw new Error("socket closed");
          },
          calls,
        ),
        scriptedBackend("openai", ["nope"], calls),
      ],
    });
    const out = (await collect(b.persona({ event: "x", behavior: "y" }))).join("");
    expect(out).toBe("seven thirty. cheap ramen. ");
    expect(calls).toEqual(["featherless"]);
  });

  test("everything down: an offline line, never silence, never an error", async () => {
    const b = brains({ personaBackends: [scriptedBackend("openai", new Error("API Error: 500"))] });
    const out = (await collect(b.persona({ event: "x", behavior: "y" }))).join("");
    expect(OFFLINE_LINES).toContain(out);
    expect(b.lastPersona()?.backend).toBe("offline");
  });

  test("the last-resort backend retries once and is never parked by a single hiccup", async () => {
    const calls: string[] = [];
    let n = 0;
    const flaky = scriptedBackend(
      "claude-cli",
      async function* () {
        n += 1;
        if (n === 1) throw new Error("claude-cli exited 1: transient");
        yield "twenty-one bucks. ";
      },
      calls,
    );
    const b = brains({ personaBackends: [scriptedBackend("openai", new Error("openai http 429: no credits")), flaky] });
    expect((await collect(b.persona({ event: "x", behavior: "y" }))).join("")).toBe("twenty-one bucks. ");
    expect(calls).toEqual(["claude-cli", "claude-cli"]);
    // next turn goes straight to the cli: it was not parked
    n = 1;
    expect((await collect(b.persona({ event: "x", behavior: "y" }))).join("")).toBe("twenty-one bucks. ");
    expect(b.lastPersona()?.backend).toBe("claude-cli");
  });

  test("when every backend is parked, the last resort still gets a shot", async () => {
    const calls: string[] = [];
    const cli = scriptedBackend("claude-cli", ["mm. "], calls);
    const b = brains({ personaBackends: [scriptedBackend("openai", new Error("openai http 429")), cli] });
    b.health.fail("claude-cli", new Error("x"));
    b.health.fail("openai", new Error("openai http 429"));
    expect((await collect(b.persona({ event: "x", behavior: "y" }))).join("")).toBe("mm. ");
    expect(calls).toEqual(["claude-cli"]);
  });

  test("uses the born persona and relationship from deps", async () => {
    let seen = "";
    const backend = scriptedBackend("openai", ["hey."]);
    const orig = backend.stream;
    backend.stream = (msg, o) => {
      seen = msg.system;
      return orig(msg, o);
    };
    const b = brains({ personaBackends: [backend], persona: () => ({ ...DEFAULT_EVE, name: "Kari" }), relationship: () => ({ ...DEFAULT_RELATIONSHIP, warmth: 0.95 }) });
    await collect(b.persona({ event: "x", behavior: "y" }));
    expect(seen).toContain("you are Kari.");
    expect(seen).toContain("let the warmth show");
  });
});

describe("chat backends", () => {
  test("openai streams SSE and falls back to the next model when one is missing", async () => {
    const bodies: any[] = [];
    const io = fakeIO({
      secrets: { OPENAI_API_KEY: "sk-test" },
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        if (body.model === "gpt-6-luna") return new Response('{"error":{"message":"The model gpt-6-luna does not exist"}}', { status: 404 });
        return openAiSse(["twenty-one", " dollars."]);
      },
    });
    const b = openAiBackend(io);
    expect((await collect(b.stream({ system: "s", user: "u" }))).join("")).toBe("twenty-one dollars.");
    expect(bodies.map((x) => x.model)).toEqual(["gpt-6-luna", "gpt-4.1-mini"]);
    expect(bodies[0].reasoning_effort).toBe("none");
    expect(bodies[1].max_tokens).toBeGreaterThan(0);
    expect(b.model()).toBe("gpt-4.1-mini");
    // remembers the working model
    await collect(b.stream({ system: "s", user: "u" }));
    expect(bodies.at(-1).model).toBe("gpt-4.1-mini");
  });

  test("openai quota errors throw (no model hopping)", async () => {
    let n = 0;
    const b = openAiBackend(fakeIO({ secrets: { OPENAI_API_KEY: "k" }, fetch: async () => (n++, new Response('{"error":{"code":"insufficient_quota"}}', { status: 429 })) }));
    await expect(collect(b.stream({ system: "s", user: "u" }))).rejects.toBeInstanceOf(HttpError);
    expect(n).toBe(1);
  });

  test("openai body per model family", () => {
    expect(openAiBody("gpt-6-luna", 50, 0.9)).toEqual({ reasoning_effort: "none", max_completion_tokens: 50 });
    expect(openAiBody("gpt-5-mini", 50, 0.9)).toEqual({ reasoning_effort: "minimal", max_completion_tokens: 50 });
    expect(openAiBody("gpt-4o-mini", 50, 0.9)).toEqual({ max_tokens: 50, temperature: 0.9 });
  });

  test("featherless uses Stheno then Hermes, bearer auth", async () => {
    const seen: string[] = [];
    const io = fakeIO({
      secrets: { FEATHERLESS_API_KEY: "fl" },
      fetch: async (url, init) => {
        expect(url).toBe("https://api.featherless.ai/v1/chat/completions");
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer fl");
        const body = JSON.parse(String(init?.body));
        seen.push(body.model);
        return body.model.includes("Stheno") ? new Response("cold", { status: 503 }) : openAiSse(["mm."]);
      },
    });
    const b = featherlessBackend(io);
    expect(b.configured()).toBe(true);
    expect((await collect(b.stream({ system: "s", user: "u" }))).join("")).toBe("mm.");
    expect(seen).toEqual(["Sao10K/L3-8B-Stheno-v3.2", "NousResearch/Hermes-3-Llama-3.1-8B"]);
  });

  test("unconfigured backends say so", () => {
    expect(openAiBackend(fakeIO()).configured()).toBe(false);
    expect(featherlessBackend(fakeIO()).configured()).toBe(false);
    expect(claudeCliBackend(fakeIO()).configured()).toBe(false);
    expect(claudeCliBackend(fakeIO({ bins: ["claude"] })).configured()).toBe(true);
  });

  test("claude stream parser prefers token deltas and ignores thinking", async () => {
    const delta = (text: string) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
    const out = await collect(
      parseClaudeStream(
        lines([
          { type: "system", subtype: "init" },
          { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } } },
          delta("so."),
          delta(" apparently"),
          { type: "assistant", message: { content: [{ type: "text", text: "so. apparently" }] } },
          { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
          { type: "result", result: "so. apparently", is_error: false },
        ]),
      ),
    );
    expect(out).toEqual(["so.", " apparently"]);
  });

  test("claude stream parser falls back to assistant blocks, then result", async () => {
    expect(await collect(parseClaudeStream(lines([{ type: "assistant", message: { content: [{ type: "text", text: "hm." }] } }, { type: "result", result: "hm." }])))).toEqual(["hm."]);
    expect(await collect(parseClaudeStream(lines([{ type: "result", result: "just this" }])))).toEqual(["just this"]);
  });

  test("claude error results throw and are never yielded", async () => {
    await expect(collect(parseClaudeStream(lines([{ type: "result", is_error: true, result: "API Error: 529" }])))).rejects.toThrow("API Error");
    await expect(collect(parseClaudeStream(lines([{ type: "result", result: "Claude AI usage limit reached|1790000000" }])))).rejects.toThrow();
  });

  test("claude cli backend: stripped flags, thinking off, stripped env", async () => {
    let argv: string[] = [];
    let env: Record<string, string> = {};
    const io = fakeIO({
      bins: ["claude"],
      spawn: (a, o) => {
        argv = a;
        env = o?.env ?? {};
        return fakeProc(a, o, [{ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "mm." } } }, { type: "result", result: "mm." }]);
      },
    });
    process.env.CLAUDECODE = "1";
    const out = await collect(claudeCliBackend(io).stream({ system: "SYS", user: "USER" }));
    delete process.env.CLAUDECODE;
    expect(out).toEqual(["mm."]);
    expect(argv.slice(0, 3)).toEqual(["/fake/bin/claude", "-p", "USER"]);
    for (const f of ["--strict-mcp-config", "--include-partial-messages", "--no-session-persistence", "--verbose"]) expect(argv).toContain(f);
    expect(argv[argv.indexOf("--model") + 1]).toBe("haiku");
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(argv[argv.indexOf("--system-prompt") + 1]).toBe("SYS");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(env.MAX_THINKING_TOKENS).toBe("0");
    expect(env.CLAUDECODE).toBeUndefined();
  });

  test("claude cli backend: non-zero exit with no output throws", async () => {
    const io = fakeIO({ bins: ["claude"], spawn: (a, o) => fakeProc(a, o, [], 1, "Not logged in") });
    await expect(collect(claudeCliBackend(io).stream({ system: "s", user: "u" }))).rejects.toThrow("claude-cli exited 1");
  });

  test("cliEnv strips auth-breaking vars and widens PATH", () => {
    const env = cliEnv({ CLAUDECODE: "1", CLAUDE_CODE_OAUTH_TOKEN: "x", GH_TOKEN: "g", HOME: "/h", PATH: "/usr/bin" });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.HOME).toBe("/h");
    expect(env.PATH).toContain("/opt/homebrew/bin");
  });

  test("persona args ask for JSON when needed", () => {
    const a = claudePersonaArgs("claude", { system: "S", user: "U" }, true);
    expect(a[a.indexOf("--system-prompt") + 1]).toContain("ONLY a JSON object");
  });
});

describe("quickJson", () => {
  test("prefers openai JSON mode, parses robustly", async () => {
    const calls: string[] = [];
    const b = brains({ personaBackends: [scriptedBackend("featherless", ['{"a":2}'], calls), scriptedBackend("openai", ['sure: {"intent":', ' "approve"}'], calls)] });
    expect(await b.quickJson<{ intent: string }>("s", "u")).toEqual({ intent: "approve" });
    expect(calls).toEqual(["openai"]);
  });
  test("falls through on unparseable output", async () => {
    const b = brains({ jsonBackends: [scriptedBackend("openai", ["no json"]), scriptedBackend("claude-cli", ['{"ok":true}'])] });
    expect(await b.quickJson<{ ok: boolean }>("s", "u")).toEqual({ ok: true });
  });
  test("hard timeout returns null", async () => {
    const slow = scriptedBackend("openai", async function* () {
      await Bun.sleep(500);
      yield '{"late":true}';
    });
    const b = brains({ jsonBackends: [slow] });
    const t0 = Date.now();
    expect(await b.quickJson("s", "u", { timeoutMs: 80 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(400);
  });
  test("null when nothing is configured", async () => {
    expect(await brains({ jsonBackends: [] }).quickJson("s", "u")).toBeNull();
  });
});

describe("frontier", () => {
  test("auto order is jabby, claude, codex, openai", async () => {
    const calls: string[] = [];
    const b = brains({
      frontierEngines: [
        scriptedEngine("jabby", { text: "" }, calls, false),
        scriptedEngine("claude", new Error("API Error: overloaded"), calls),
        scriptedEngine("codex", { text: "plan: ramen at 7:30" }, calls),
        scriptedEngine("openai", { text: "never" }, calls),
      ],
    });
    const r = await b.frontier({ goal: "figure out tonight" });
    expect(r).toMatchObject({ ok: true, engine: "codex", text: "plan: ramen at 7:30" });
    expect(calls).toEqual(["claude", "codex"]);
  });

  test("jabby is used first when it is up", async () => {
    const b = brains({ frontierEngines: [scriptedEngine("jabby", { text: "on it" }), scriptedEngine("claude", { text: "no" })] });
    expect((await b.frontier({ goal: "g" })).engine).toBe("jabby");
  });

  test("json:true extracts the object and moves on when there is none", async () => {
    const b = brains({
      frontierEngines: [scriptedEngine("jabby", { text: "i'd go with ramen honestly" }), scriptedEngine("claude", { text: 'ok:\n```json\n{"steps":["a"]}\n```' })],
    });
    const r = await b.frontier({ goal: "g", json: true });
    expect(r.engine).toBe("claude");
    expect(r.json).toEqual({ steps: ["a"] });
  });

  test("explicit engine runs only that engine", async () => {
    const calls: string[] = [];
    const b = brains({ frontierEngines: [scriptedEngine("jabby", { text: "j" }, calls), scriptedEngine("codex", { text: "c" }, calls)] });
    expect((await b.frontier({ goal: "g", engine: "codex" })).text).toBe("c");
    expect(calls).toEqual(["codex"]);
  });

  test("never throws: ok:false with the reasons", async () => {
    const b = brains({ frontierEngines: [scriptedEngine("jabby", new Error("down"))] });
    const r = await b.frontier({ goal: "g" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("jabby: down");
  });

  test("runChain skips parked engines", async () => {
    const h = new HealthBook();
    h.fail("claude", new HttpError(429, "rate limit", "x"));
    const calls: string[] = [];
    const out = await runChain([scriptedEngine("claude", { text: "a" }, calls), scriptedEngine("codex", { text: "b" }, calls)], { agent: "t", system: "", prompt: "", json: false, tools: [], timeoutMs: 1000 }, h);
    expect(out.engine).toBe("codex");
    expect(calls).toEqual(["codex"]);
  });
});

describe("jabby engine", () => {
  test("health check, then SSE chunks with tool traces split out", async () => {
    const urls: string[] = [];
    let sent = "";
    const io = fakeIO({
      fetch: async (url, init) => {
        urls.push(url);
        if (url.endsWith("/api/health")) return Response.json({ ok: true, now: 1 });
        sent = JSON.parse(String(init?.body)).message;
        return sse([
          { type: "chunk", text: "checking your calendar" },
          { type: "chunk", text: "\n_[tool: Bash -> gcal list today]_\n" },
          { type: "unblock" },
          { type: "chunk", text: " you're free after 7." },
          { type: "done" },
        ]);
      },
    });
    const e = jabbyEngine(io, "http://jabby.test/");
    expect(await e.available()).toBe(true);
    const events: BrainEvent[] = [];
    const out = await e.run({ agent: "frontier", system: "SYS", prompt: "am i free tonight?", json: false, tools: [], timeoutMs: 5000, onEvent: (ev) => events.push(ev) });
    expect(out.text).toBe("checking your calendar you're free after 7.");
    expect(urls).toEqual(["http://jabby.test/api/health", "http://jabby.test/api/chat"]);
    expect(sent).toContain("am i free tonight?");
    expect(sent).toContain("SYS");
    expect(events).toContainEqual({ kind: "tool", name: "Bash", detail: "gcal list today" });
  });

  test("down daemon is unavailable (cached)", async () => {
    let n = 0;
    const e = jabbyEngine(
      fakeIO({
        fetch: async () => {
          n++;
          throw new Error("ECONNREFUSED");
        },
      }),
      "http://x",
    );
    expect(await e.available()).toBe(false);
    expect(await e.available()).toBe(false);
    expect(n).toBe(1);
  });

  test("error events and rate-limit text throw", async () => {
    const mk = (payloads: unknown[]) => jabbyEngine(fakeIO({ fetch: async () => sse(payloads) }), "http://x");
    const r = { agent: "a", system: "", prompt: "p", json: false, tools: [], timeoutMs: 1000 };
    await expect(mk([{ type: "error", message: "boom" }]).run(r)).rejects.toThrow("jabby: boom");
    await expect(mk([{ type: "chunk", text: "You've hit your limit" }, { type: "done" }]).run(r)).rejects.toThrow();
    await expect(mk([{ type: "done" }]).run(r)).rejects.toThrow("empty");
  });

  test("tool trace splitting", () => {
    expect(splitJabbyChunk("a\n_[tool: WebSearch]_\nb")).toEqual({ text: "ab", tools: [{ name: "WebSearch" }] });
  });
});

describe("claude + codex engines", () => {
  const base = { agent: "food", system: "SYS", prompt: "P", json: true, tools: [] as string[], timeoutMs: 5000 };

  test("claude args: schema, tools allowlist, strict mcp only without tools", () => {
    const a = claudeFrontierArgs("claude", { ...base, schema: { type: "object" } });
    expect(a[a.indexOf("--json-schema") + 1]).toBe('{"type":"object"}');
    expect(a).toContain("--strict-mcp-config");
    expect(a[a.indexOf("--append-system-prompt") + 1]).toBe("SYS");
    const b = claudeFrontierArgs("claude", { ...base, tools: ["WebSearch", "WebFetch"] });
    expect(b).not.toContain("--strict-mcp-config");
    expect(b[b.indexOf("--allowedTools") + 1]).toBe("WebSearch,WebFetch");
  });

  test("claude run parse: structured output, tool events, errors", async () => {
    const events: BrainEvent[] = [];
    const r = await parseClaudeRun(
      lines([
        { type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch", input: { query: "ramen" } }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "found 3" }] } },
        { type: "assistant", message: { content: [{ type: "tool_use", name: "StructuredOutput", input: { options: [1] } }] } },
        { type: "result", result: "done", is_error: false },
      ]),
      (e) => events.push(e),
    );
    expect(r.structured).toEqual({ options: [1] });
    expect(events).toEqual([
      { kind: "tool", name: "WebSearch", detail: "ramen" },
      { kind: "text", text: "found 3" },
    ]);
    const bad = await parseClaudeRun(lines([{ type: "result", is_error: true, result: "API Error" }]));
    expect(bad.error).toBe("API Error");
  });

  test("claude engine runs in a scratch dir and returns structured json", async () => {
    let cwd = "";
    const io = fakeIO({
      bins: ["claude"],
      spawn: (a, o) => {
        cwd = o?.cwd ?? "";
        return fakeProc(a, o, [{ type: "result", result: "", structured_output: { ok: 1 } }]);
      },
    });
    const out = await claudeEngine(io).run({ ...base, schema: { type: "object" } });
    expect(out.json).toEqual({ ok: 1 });
    expect(cwd).toContain("eve-brains-test");
    expect(cwd.endsWith("/food")).toBe(true);
  });

  test("codex args and parse", async () => {
    const a = codexArgs("codex", "/w", { ...base, tools: ["WebSearch"] }, "/w/s.json");
    expect(a.slice(0, 3)).toEqual(["codex", "exec", "--json"]);
    expect(a).toContain("--ephemeral");
    expect(a).toContain("--skip-git-repo-check");
    expect(a[a.indexOf("--output-schema") + 1]).toBe("/w/s.json");
    expect(a).toContain("tools.web_search=true");
    expect(a.at(-1)).toBe("-");
    const events: BrainEvent[] = [];
    const r = await parseCodexRun(
      lines([
        "not json",
        { type: "thread.started", thread_id: "t1" },
        { type: "item.started", item: { id: "1", type: "command_execution", command: "ls" } },
        { type: "item.completed", item: { id: "2", type: "agent_message", text: "progress" } },
        { type: "item.completed", item: { id: "3", type: "agent_message", text: '{"final":true}' } },
        { type: "turn.completed", usage: {} },
      ]),
      (e) => events.push(e),
    );
    expect(r.text).toBe('{"final":true}');
    expect(events[0]).toEqual({ kind: "tool", name: "shell", detail: "ls" });
  });

  test("codex engine sends the prompt on stdin and reports failures", async () => {
    let stdin = "";
    const ok = codexEngine(
      fakeIO({
        bins: ["codex"],
        spawn: (a, o) => {
          stdin = o?.stdin ?? "";
          return fakeProc(a, o, [{ type: "item.completed", item: { type: "agent_message", text: "hi" } }]);
        },
      }),
    );
    expect((await ok.run({ ...base, json: false })).text).toBe("hi");
    expect(stdin).toContain("SYS");
    expect(stdin).toContain("P");
    const bad = codexEngine(fakeIO({ bins: ["codex"], spawn: (a, o) => fakeProc(a, o, [{ type: "turn.failed", error: { message: "usage limit" } }], 1) }));
    await expect(bad.run(base)).rejects.toThrow("usage limit");
  });
});

describe("harem adapter", () => {
  test("structured() goes claude first with the schema, streams events, respects abort", async () => {
    const calls: string[] = [];
    let seenSchema: unknown;
    const claude = scriptedEngine("claude", { text: "", json: { mode: "SPAWN_SWARM" } }, calls);
    const run = claude.run;
    claude.run = async (r) => {
      seenSchema = r.schema;
      r.onEvent?.({ kind: "tool", name: "WebSearch" });
      return run(r);
    };
    const b = brains({ frontierEngines: [scriptedEngine("jabby", { text: "{}" }, calls), claude] });
    const events: BrainEvent[] = [];
    const out = await b.harem.structured<{ mode: string }>({ agent: "planner", system: "s", prompt: "p", schema: { type: "object" }, onEvent: (e) => events.push(e) });
    expect(out.mode).toBe("SPAWN_SWARM");
    expect(calls).toEqual(["claude"]);
    expect(seenSchema).toEqual({ type: "object" });
    expect(events).toEqual([{ kind: "tool", name: "WebSearch" }]);

    const ac = new AbortController();
    ac.abort();
    await expect(b.harem.structured({ agent: "a", system: "s", prompt: "p", schema: {}, signal: ac.signal })).rejects.toThrow("aborted");
  });

  test("falls back when claude is rate limited", async () => {
    const b = brains({ frontierEngines: [scriptedEngine("claude", new Error("You've hit your limit")), scriptedEngine("codex", { text: '{"x":1}' })] });
    expect(await b.harem.structured<{ x: number }>({ agent: "a", system: "s", prompt: "p", schema: {} })).toEqual({ x: 1 });
  });
});

describe("module", () => {
  let core: RunningCore;
  const port = 17791;
  beforeAll(async () => {
    process.env.EIGEN_QUIET = "1";
    core = await startCore(
      [
        brainsModule({
          io: fakeIO(),
          personaBackends: [scriptedBackend("claude-cli", ["[mood:happy 0.7] ", "hi."])],
          frontierEngines: [scriptedEngine("jabby", { text: "plan" })],
        }),
      ],
      { port, eveHome: `${process.env.TMPDIR ?? "/tmp"}/eve-brains-test-home` },
    );
  });
  afterAll(() => core.stop());

  test("provides the brains service", async () => {
    const b = core.ctx.use("brains");
    expect((await collect(b.persona({ event: "e", behavior: "b" }))).join("")).toBe("[mood:happy 0.7] hi.");
  });

  test("GET /api/brains/status", async () => {
    const r = (await (await fetch(`http://127.0.0.1:${port}/api/brains/status`)).json()) as any;
    expect(r.ok).toBe(true);
    expect(r.live["claude-cli"]).toBe(true);
    expect(r.live.jabby).toBe(true);
    expect(r.detail["claude-cli"].live).toBe(true);
  });

  test("POST /api/brains/test persona, frontier, validation", async () => {
    const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/api/brains/test`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);
    expect((await post({ text: "thoughts?" })).text).toBe("[mood:happy 0.7] hi.");
    expect((await post({ text: "plan tonight", mode: "frontier" })).engine).toBe("jabby");
    expect((await post({})).ok).toBe(false);
  });

  test("haremBrain(ctx) routes through the same instance", async () => {
    await expect(haremBrain(core.ctx).structured({ agent: "a", system: "s", prompt: "p", schema: {} })).rejects.toThrow(/JSON/);
  });
});
