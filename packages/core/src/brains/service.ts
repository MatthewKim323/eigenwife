import type { Persona, RelationshipState } from "@eigenwife/protocol";
import type { BrainService, FrontierRequest, FrontierResult, PersonaRequest } from "../services";
import { anthropicBackend, claudeCliBackend, featherlessBackend, openAiBackend, type ChatBackend } from "./chat";
import {
  claudeEngine,
  codexEngine,
  jabbyEngine,
  openAiEngine,
  READ_TOOLS,
  runChain,
  type BrainEvent,
  type FrontierEngine,
} from "./frontier";
import { describe, HealthBook, type BackendHealth } from "./health";
import type { BrainIO } from "./io";
import { buildPersonaPrompt, DEFAULT_EVE, personaMaxTokens } from "./prompt";
import { extractJson, guardSpoken, LeakError } from "./text";

export interface BrainsDeps {
  io: BrainIO;
  jabbyUrl: string;
  /** Persona card once Act I converged, else null (DEFAULT_EVE is used). */
  persona(): Persona | null;
  relationship(): RelationshipState | null;
  /** World context block (includes the user's gaze target). */
  world(): string;
  log?(...args: unknown[]): void;
  /** Override the backend lists (tests). */
  personaBackends?: ChatBackend[];
  jsonBackends?: ChatBackend[];
  frontierEngines?: FrontierEngine[];
}

/** Harem's Brain contract (packages/harem/src/types.ts), mirrored structurally so core never imports harem. */
export interface StructuredRequest {
  agent: string;
  system: string;
  prompt: string;
  schema: object;
  tools?: string[];
  model?: string;
  timeoutMs?: number;
  onEvent?: (e: BrainEvent) => void;
  signal?: AbortSignal;
}

export interface HaremBrain {
  name: string;
  structured<T>(req: StructuredRequest): Promise<T>;
}

export interface PersonaTrace {
  backend: string;
  firstTokenMs: number;
  ms: number;
  text: string;
  errors: string[];
}

export interface Brains extends BrainService {
  health: HealthBook;
  /** Details of the most recent persona line. */
  lastPersona(): PersonaTrace | null;
  /** Detailed status for /api/brains/status. */
  detail(): Record<string, BackendHealth & { live: boolean; configured: boolean }>;
  /** Frontier engines by name, in auto order. */
  engines: FrontierEngine[];
  harem: HaremBrain;
  /** Refresh async availability (jabby health). */
  refresh(): Promise<void>;
}

/** Said when every persona backend is down, so she never goes silent mid-demo. */
export const OFFLINE_LINES = [
  "[mood:thinking 0.5] hm. [pause:0.3] give me a second.",
  "[mood:smug 0.4] mm. i'm thinking about it.",
  "[mood:neutral 0.4] noted.",
];

/** Frontier engine order for engine: "auto". Jabby first: it is the brain. */
export const AUTO_ORDER = ["jabby", "claude", "codex", "openai"] as const;
/** Harem workers need schema-shaped output fast; claude's --json-schema is the best fit. */
export const HAREM_ORDER = ["claude", "codex", "jabby", "openai"] as const;

export function createBrains(deps: BrainsDeps): Brains {
  const { io } = deps;
  const log = deps.log ?? (() => {});
  const health = new HealthBook(io.now);
  const personaBackends = deps.personaBackends ?? [featherlessBackend(io), openAiBackend(io), anthropicBackend(io), claudeCliBackend(io)];
  // JSON: OpenAI JSON mode first, then the persona backends, CLI haiku last.
  const jsonBackends =
    deps.jsonBackends ?? [personaBackends.find((b) => b.name === "openai"), ...personaBackends.filter((b) => b.name !== "openai")].filter((b): b is ChatBackend => !!b);
  const engines = deps.frontierEngines ?? [jabbyEngine(io, deps.jabbyUrl, health), claudeEngine(io), codexEngine(io), openAiEngine(io)];
  const byName = (n: string) => engines.find((e) => e.name === n);
  const ordered = (names: readonly string[]) => names.map(byName).filter((e): e is FrontierEngine => !!e);
  let last: PersonaTrace | null = null;
  const engineAvail = new Map<string, boolean>();
  let offline = 0;

  const live = (b: ChatBackend) => b.configured() && !health.cooling(b.name);

  async function refresh() {
    await Promise.all(
      engines.map(async (e) => {
        try {
          engineAvail.set(e.name, await e.available());
        } catch {
          engineAvail.set(e.name, false);
        }
      }),
    );
  }

  async function* persona(req: PersonaRequest): AsyncGenerator<string> {
    const card = deps.persona() ?? DEFAULT_EVE;
    const msg = buildPersonaPrompt({ persona: card, relationship: deps.relationship(), world: deps.world(), req });
    const maxTokens = personaMaxTokens(req.maxWords);
    const errors: string[] = [];
    const t0 = io.now();
    for (const b of personaBackends) {
      if (!b.configured()) continue;
      if (health.cooling(b.name)) {
        errors.push(`${b.name}: parked`);
        continue;
      }
      const ac = new AbortController();
      let first = -1;
      let text = "";
      const start = io.now();
      try {
        for await (const chunk of guardSpoken(b.stream(msg, { maxTokens, temperature: 0.9, signal: ac.signal }), [card.name, "eve"])) {
          if (first < 0) first = io.now() - start;
          text += chunk;
          yield chunk;
        }
        if (!text.trim()) throw new Error("empty reply");
        health.ok(b.name, io.now() - start, first, b.model());
        last = { backend: b.name, firstTokenMs: first, ms: io.now() - start, text, errors };
        return;
      } catch (err) {
        health.fail(b.name, err);
        errors.push(`${b.name}: ${err instanceof LeakError ? "error text suppressed" : describe(err).slice(0, 160)}`);
        log(`persona ${b.name} failed:`, errors.at(-1));
        if (text) {
          last = { backend: b.name, firstTokenMs: first, ms: io.now() - start, text, errors };
          return; // already spoke part of it: don't restart with another voice
        }
      } finally {
        ac.abort();
      }
    }
    const line = OFFLINE_LINES[offline++ % OFFLINE_LINES.length]!;
    last = { backend: "offline", firstTokenMs: io.now() - t0, ms: io.now() - t0, text: line, errors };
    yield line;
  }

  async function quickJson<T = unknown>(system: string, user: string, opts: { timeoutMs?: number } = {}): Promise<T | null> {
    const deadline = io.now() + (opts.timeoutMs ?? 8000);
    for (const b of jsonBackends) {
      if (!live(b)) continue;
      const left = deadline - io.now();
      if (left <= 50) break;
      const ac = new AbortController();
      const start = io.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const run = (async () => {
          let out = "";
          for await (const c of b.stream({ system, user }, { json: true, maxTokens: 600, temperature: 0.2, signal: ac.signal })) out += c;
          return out;
        })();
        const text = await Promise.race([
          run,
          new Promise<never>((_, rej) => {
            timer = setTimeout(() => rej(new Error("quickJson timeout")), left);
          }),
        ]);
        const parsed = extractJson(text);
        if (parsed && typeof parsed === "object") {
          health.ok(b.name, io.now() - start, undefined, b.model());
          return parsed as T;
        }
        throw new Error("no JSON in reply");
      } catch (err) {
        health.fail(b.name, err);
        log(`quickJson ${b.name} failed:`, describe(err).slice(0, 160));
      } finally {
        if (timer) clearTimeout(timer);
        ac.abort();
      }
    }
    return null;
  }

  async function frontier(req: FrontierRequest): Promise<FrontierResult> {
    const engine = req.engine ?? "auto";
    const list = engine === "auto" ? ordered(AUTO_ORDER) : ordered([engine]);
    const context = req.context ?? deps.world();
    const t0 = io.now();
    try {
      const out = await runChain(
        list,
        {
          agent: "frontier",
          system: [
            "You are the frontal cortex of Eve, a companion who lives on the user's desktop.",
            "You plan and reason; another part of her does the talking. Be concrete and brief.",
            context.trim() ? `\n[world right now]\n${context.trim()}` : "",
          ].join("\n"),
          prompt: req.goal,
          json: !!req.json,
          tools: req.tools === "read" ? READ_TOOLS : [],
          timeoutMs: req.timeoutMs ?? 90_000,
        },
        health,
        io.now,
      );
      return { ok: true, text: out.text, ...(out.json !== undefined ? { json: out.json } : {}), engine: out.engine, ms: io.now() - t0 };
    } catch (err) {
      return { ok: false, text: "", engine: engine === "auto" ? "none" : engine, ms: io.now() - t0, error: describe(err) };
    }
  }

  const harem: HaremBrain = {
    name: "eve-frontier",
    async structured<T>(req: StructuredRequest): Promise<T> {
      const out = await runChain(
        ordered(HAREM_ORDER),
        {
          agent: req.agent,
          system: req.system,
          prompt: req.prompt,
          json: true,
          schema: req.schema,
          tools: req.tools ?? [],
          model: req.model,
          timeoutMs: req.timeoutMs ?? 120_000,
          signal: req.signal,
          onEvent: req.onEvent,
        },
        health,
        io.now,
      );
      return out.json as T;
    },
  };

  function status(): Record<string, boolean> {
    void refresh();
    const s: Record<string, boolean> = {};
    for (const b of personaBackends) s[b.name] = live(b);
    for (const e of engines) s[e.name === "claude" ? "claude-frontier" : e.name] = (engineAvail.get(e.name) ?? false) && !health.cooling(e.name);
    return s;
  }

  function detail() {
    const snap = health.snapshot();
    const out: Record<string, BackendHealth & { live: boolean; configured: boolean }> = {};
    for (const b of personaBackends)
      out[b.name] = { calls: 0, failures: 0, ...snap[b.name], ok: snap[b.name]?.ok ?? true, model: snap[b.name]?.model ?? b.model(), configured: b.configured(), live: live(b) };
    for (const e of engines) {
      const key = e.name === "claude" ? "claude-frontier" : e.name;
      const avail = engineAvail.get(e.name) ?? false;
      out[key] = { calls: 0, failures: 0, ...snap[e.name], ok: snap[e.name]?.ok ?? avail, configured: avail, live: avail && !health.cooling(e.name) };
    }
    return out;
  }

  return { persona, frontier, quickJson, status, health, lastPersona: () => last, detail, engines, harem, refresh };
}
