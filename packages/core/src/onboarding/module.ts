import type { Mood } from "@eigenwife/protocol";
import { HomeStore } from "../home/store";
import type { CoreContext, Module } from "../context";
import { json } from "../hub";
import type { HomeService, OnboardingService, ProfileSource, UserProfile, UserService } from "../services";
import { ONBOARDING_LINES, type OnboardingStepId } from "../speech/lines";
import { extractAnswer, REDO, RESUME } from "./extract";
import { mergeProfile, normalizeProfile, prettyBirthday, type ProfilePatch } from "./profile";

/**
 * Getting to know him (docs/KNOW_ME.md).
 *
 *  - Owns ~/.eve/user.json and provides the `user` service (profile, merge, herName).
 *  - Runs a short spoken onboarding once: the first time she's born or woken
 *    with no name on file, or on "redo onboarding" / "let's start over".
 *    One question at a time, each skippable, answers confirmed briefly and
 *    stored in user.json plus high-importance memories.
 *  - While a question is out, the reflex routes every utterance here
 *    (`onboarding.active()`), and ambient reactions are held.
 *  - Resumable: progress lives in ~/.eve/onboarding.json. Silence gets one
 *    nudge, then she lets it go and picks it up next time she's woken.
 */

export const STEPS: OnboardingStepId[] = ["name", "herName", "work", "interests", "birthday", "boundaries"];

export interface OnboardingState {
  status: "idle" | "active" | "paused" | "done";
  index: number;
  answered: OnboardingStepId[];
  skipped: OnboardingStepId[];
  startedAt?: number;
  updatedAt: number;
  doneAt?: number;
}

export interface OnboardingOptions {
  /** Silence after a question before the nudge. */
  silenceMs?: number;
  /** Silence after the nudge before she pauses the flow. */
  giveUpMs?: number;
  /** Budget for the brain to read one answer (regex covers the rest). */
  extractTimeoutMs?: number;
  /** Gap between being born/woken and the first question. */
  startDelayMs?: number;
  now?: () => number;
}

const pick = <T>(xs: readonly T[], n: number): T => xs[Math.abs(n) % xs.length]!;
const clipWords = (s: string, n: number) => {
  const ws = s.split(/\s+/).filter(Boolean);
  return ws.length > n ? `${ws.slice(0, n).join(" ")}` : s;
};

/** The live confirmation that repeats his answer back. */
export function confirmLine(step: OnboardingStepId, p: ProfilePatch): string {
  switch (step) {
    case "name":
      return `[mood:happy 0.5] ${p.callMe ?? p.name?.toLowerCase() ?? "okay"}. got it.`;
    case "herName":
      return !p.herName || p.herName.toLowerCase() === "eve" ? "[mood:happy 0.5] eve it is." : `[mood:happy 0.6] ${p.herName.toLowerCase()}. i like it.`;
    case "work":
      return `[mood:thinking 0.4] ${clipWords((p.work ?? "").toLowerCase(), 8).replace(/[.!?]+$/, "")}. noted.`;
    case "interests": {
      const xs = (p.interests ?? []).slice(0, 2).map((x) => x.toLowerCase());
      return `[mood:happy 0.5] ${xs.join(" and ")}. noted.`;
    }
    case "birthday":
      return `[mood:smug 0.5] ${prettyBirthday(p.birthday ?? "")}. i won't forget.`;
    case "boundaries":
      return p.boundaries?.length ? "[mood:neutral 0.5] got it. i won't go there." : ONBOARDING_LINES.noRules;
  }
}

/** Third-person facts for memory, one per answer (boundaries: one per rule). */
export function answerFacts(step: OnboardingStepId, p: ProfilePatch): { content: string; tags: string[] }[] {
  switch (step) {
    case "name":
      return [{ content: p.name && p.callMe && p.name.toLowerCase() !== p.callMe ? `Their name is ${p.name}; they go by ${p.callMe}` : `Their name is ${p.callMe ?? p.name}`, tags: ["profile", "name"] }];
    case "herName":
      return p.herName ? [{ content: `They named the companion ${p.herName}`, tags: ["profile", "her-name"] }] : [];
    case "work":
      return p.work ? [{ content: `What they do: ${p.work}`, tags: ["profile", "work"] }] : [];
    case "interests":
      return p.interests?.length ? [{ content: `Into ${p.interests.join(", ")}`, tags: ["profile", "interests"] }] : [];
    case "birthday":
      return p.birthday ? [{ content: `Their birthday is ${prettyBirthday(p.birthday)}`, tags: ["profile", "birthday"] }] : [];
    case "boundaries":
      // Boundaries are private: tagged so they never leave the machine (gbrain write-back skips "private").
      return (p.boundaries ?? []).map((b) => ({ content: `Never bring up or do: ${b}`, tags: ["profile", "boundary", "private"] }));
  }
}

export function onboardingModule(opts: OnboardingOptions = {}): Module {
  const offs: (() => void)[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    (t as { unref?: () => void }).unref?.();
    timers.add(t);
    return t;
  };
  const clearAll = () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };

  return {
    name: "onboarding",
    async start(ctx: CoreContext) {
      const now = opts.now ?? Date.now;
      const log = (...a: unknown[]) => ctx.log("onboarding", ...a);
      const silenceMs = opts.silenceMs ?? 45_000;
      const giveUpMs = opts.giveUpMs ?? 60_000;
      const fallbackStore = new HomeStore(ctx.config.eveHome);
      const home: Pick<HomeService, "read" | "write"> = ctx.tryUse("home") ?? {
        read: (n, f) => fallbackStore.read(n, f),
        write: async (n, d) => {
          await fallbackStore.write(n, d);
        },
      };

      let profile: UserProfile = normalizeProfile(await home.read<unknown>("user", null));
      let state: OnboardingState = { status: "idle", index: 0, answered: [], skipped: [], updatedAt: 0, ...(await home.read<Partial<OnboardingState>>("onboarding", {})) };
      if (state.index < 0 || state.index > STEPS.length) state.index = 0;
      /** Restored after a restart mid-onboarding: resume when a client shows up or he speaks. */
      let armed = false;
      let retries = 0;
      let turn = 0;
      let chain: Promise<void> = Promise.resolve();

      const saveProfile = () => home.write("user", profile);
      const saveState = () => {
        state.updatedAt = now();
        return home.write("onboarding", state);
      };
      const emitState = () =>
        ctx.bus.emit("onboarding.state", {
          status: state.status,
          step: state.status === "active" ? (STEPS[state.index] ?? null) : null,
          index: state.index,
          total: STEPS.length,
          answered: state.answered.length,
        });

      const hasName = () => !!(profile.callMe || profile.name);
      const wants = () => state.status === "active" || state.status === "paused" || (state.status === "idle" && !hasName());

      const say = async (text: string, mood?: Mood, parent?: string) => {
        const speech = ctx.tryUse("speech");
        if (!speech) {
          log(`no speech service: would have said "${text}"`);
          return;
        }
        try {
          await speech.say(text, { priority: "high", brain: "onboarding", parent, ...(mood ? { mood } : {}) });
        } catch (err) {
          log("say failed:", err);
        }
      };

      // --- user service ------------------------------------------------------------
      const merge = async (patch: ProfilePatch, source: ProfileSource): Promise<UserProfile> => {
        const before = profile.herName;
        const next = mergeProfile(profile, patch, source, now());
        if (JSON.stringify(next) !== JSON.stringify(profile)) {
          profile = next;
          await saveProfile();
        }
        if (profile.herName !== before && profile.herName) rename(profile.herName, source === "onboarding" ? "onboarding" : "user");
        return profile;
      };
      const herName = () => {
        const n = profile.herName?.trim();
        return n && n.toLowerCase() !== "eve" ? n : null;
      };
      const rename = (name: string, by: "onboarding" | "user" | "restore") => {
        if (ctx.world().companion.persona?.name === name) return;
        ctx.bus.emit("companion.rename", { name, by });
      };
      const user: UserService = { profile: () => profile, merge, herName };
      ctx.provide("user", user);

      // --- the flow ----------------------------------------------------------------------
      const armSilence = (parent?: string) => {
        clearAll();
        const myTurn = turn;
        later(silenceMs, () => {
          if (state.status !== "active" || turn !== myTurn) return;
          void say(`${ONBOARDING_LINES.nudge} ${ONBOARDING_LINES.questions[STEPS[state.index]!]}`, "thinking", parent);
          later(giveUpMs, () => {
            if (state.status !== "active" || turn !== myTurn) return;
            void pause("silence", parent);
          });
        });
      };

      const ask = async (parent?: string) => {
        turn += 1;
        retries = 0;
        if (state.index >= STEPS.length) return finish(parent);
        emitState();
        await say(ONBOARDING_LINES.questions[STEPS[state.index]!], undefined, parent);
        armSilence(parent);
      };

      const finish = async (parent?: string) => {
        clearAll();
        state.status = "done";
        state.doneAt = now();
        await saveState();
        emitState();
        log(`done: ${state.answered.length} answered, ${state.skipped.length} skipped`);
        await say(ONBOARDING_LINES.outro, "happy", parent);
      };

      const pause = async (why: string, parent?: string) => {
        clearAll();
        turn += 1;
        state.status = "paused";
        await saveState();
        emitState();
        log(`paused (${why}) at ${STEPS[state.index] ?? "end"}`);
        await say(ONBOARDING_LINES.pause, "neutral", parent);
      };

      const begin = async (o: { redo?: boolean; parent?: string; resumed?: boolean } = {}) => {
        clearAll();
        armed = false;
        const fresh = o.redo || state.status === "done" || (state.status === "idle" && state.index === 0);
        if (o.redo || state.status === "done") state = { status: "active", index: 0, answered: [], skipped: [], startedAt: now(), updatedAt: now() };
        else state = { ...state, status: "active", startedAt: state.startedAt ?? now() };
        await saveState();
        log(o.redo ? "redo" : fresh ? "starting" : `resuming at ${STEPS[state.index]}`);
        await say(o.redo ? ONBOARDING_LINES.redo : fresh && state.index === 0 ? ONBOARDING_LINES.intro : ONBOARDING_LINES.resume, "happy", o.parent);
        await ask(o.parent);
      };

      const next = async (parent?: string) => {
        state.index += 1;
        await saveState();
        await ask(parent);
      };

      const answer = async (text: string, parent?: string) => {
        const step = STEPS[state.index];
        if (!step) return finish(parent);
        clearAll();
        const myTurn = turn;
        const r = await extractAnswer(ctx.tryUse("brains"), step, text, opts.extractTimeoutMs ?? 3000);
        if (turn !== myTurn || state.status !== "active") return;
        if (r.kind === "pause") {
          ctx.tryUse("speech")?.stop("onboarding paused");
          return pause("asked", parent);
        }
        if (r.kind === "skip") {
          state.skipped = [...new Set([...state.skipped, step])];
          await say(pick(ONBOARDING_LINES.skip, state.index + state.skipped.length), undefined, parent);
          return next(parent);
        }
        if (r.kind === "none") {
          if (retries < 1) {
            retries += 1;
            await say(`${pick(ONBOARDING_LINES.retry, state.index)} ${ONBOARDING_LINES.questions[step]}`, "thinking", parent);
            armSilence(parent);
            return;
          }
          state.skipped = [...new Set([...state.skipped, step])];
          await say(pick(ONBOARDING_LINES.skip, state.index), undefined, parent);
          return next(parent);
        }
        await merge(r.patch, "onboarding");
        state.answered = [...new Set([...state.answered, step])];
        state.skipped = state.skipped.filter((s) => s !== step);
        const memory = ctx.tryUse("memory");
        for (const f of answerFacts(step, r.patch)) {
          try {
            await memory?.write({ kind: "fact", content: f.content, importance: 0.9, confidence: 0.95, source: "onboarding", tags: f.tags }, "STORE_LONG_TERM");
          } catch (err) {
            log("memory write failed:", err);
          }
        }
        log(`${step}: ${r.by}`);
        await say(confirmLine(step, r.patch), undefined, parent);
        return next(parent);
      };

      const serial = (fn: () => Promise<void>) => {
        const p = chain.then(fn).catch((err) => log("onboarding step failed:", err));
        chain = p;
        return p;
      };

      const service: OnboardingService = {
        active: () => armed || state.status === "active",
        pending: () => wants(),
        claims: (text) => REDO.test(text) || (state.status === "paused" && RESUME.test(text)),
        hear: (text, parent) =>
          serial(async () => {
            if (REDO.test(text)) return begin({ redo: true, parent });
            if (armed) return begin({ parent, resumed: true });
            if (state.status === "active") return answer(text, parent);
            if (state.status === "paused" && RESUME.test(text)) return begin({ parent });
          }),
        begin: (o = {}) => serial(() => begin(o)),
      };
      ctx.provide("onboarding", service);

      // --- bus -------------------------------------------------------------------------
      offs.push(
        ctx.bus.on("companion.born", (e) => {
          const her = herName();
          if (her) rename(her, "restore");
          if (!wants()) return;
          if (e.data.restored) {
            // A core restart: nobody is listening yet. Pick it up when a client joins or he talks.
            armed = true;
            log("waiting for a client to resume onboarding");
            return;
          }
          later(opts.startDelayMs ?? 900, () => void service.begin());
        }),
        ctx.bus.on("bus.hello", (e) => {
          if (armed && (e.data.role === "shell" || e.data.role === "observer")) void service.begin();
        }),
      );

      // --- routes -------------------------------------------------------------------------
      ctx.route("/api/onboarding", async (req, url) => {
        const sub = url.pathname.replace(/^\/api\/onboarding\/?/, "");
        if (req.method === "GET" && !sub) return json({ ok: true, state, active: service.active(), pending: service.pending(), steps: STEPS, profile });
        if (req.method !== "POST") return null;
        const body = (await req.json().catch(() => ({}))) as { redo?: boolean; text?: string };
        if (sub === "start") {
          void service.begin({ redo: !!body.redo });
          return json({ ok: true });
        }
        if (sub === "answer") {
          if (!body.text?.trim()) return json({ ok: false, error: "text required" }, 400);
          await service.hear(body.text);
          return json({ ok: true, state, profile });
        }
        return null;
      });
      ctx.route("/api/user", async (req, url) => {
        if (url.pathname !== "/api/user" && url.pathname !== "/api/user/") return null;
        if (req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as ProfilePatch;
          return json({ ok: true, profile: await merge(body, "api") });
        }
        return json({ ok: true, profile });
      });

      if (ctx.world().companion.born && herName()) rename(herName()!, "restore");
      log(`user: ${profile.callMe ?? profile.name ?? "unknown"}${herName() ? `, she's ${herName()}` : ""}; onboarding ${state.status}${state.status !== "done" ? ` at ${STEPS[state.index] ?? "end"}` : ""}`);
    },
    stop() {
      clearAll();
      for (const off of offs.splice(0)) off();
    },
  };
}
