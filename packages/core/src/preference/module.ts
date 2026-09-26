import { CANDIDATES, type Candidate, type Persona, type TraitVector } from "@eigenwife/protocol";
import { secret } from "../config";
import type { CoreContext, Module } from "../context";
import { json } from "../hub";
import type { HomeService, PreferenceService } from "../services";
import { jevReward, type FetchLike } from "./jev";
import {
  adapt,
  deltas,
  direction,
  estimate,
  focus,
  initialConvergence,
  localReward,
  population,
  round3,
  stepConvergence,
  type ConvergenceState,
  type LeaveObservation,
  type Observation,
  type RewardResult,
} from "./math";
import { synthesizePersona } from "./persona";

/**
 * Act I: dating.leave -> attention reward -> preference vector -> persona.
 * Emits dating.signal, preference.update, preference.converged, companion.born.
 * See ./math.ts for the formulas and docs/MEMORY.md for the story.
 */

export interface PreferenceModuleOptions {
  candidates?: Candidate[];
  /** Defaults to TYPESAFE_API_KEY. Empty string forces the local model. */
  jevKey?: string;
  fetch?: FetchLike;
  jevTimeoutMs?: number;
  /** Early convergence threshold and minimum observations for it. */
  convergeAt?: number;
  minObservations?: number;
  /** Fallback deck size when the shell never says `total`. */
  expectedTotal?: number;
  personaTimeoutMs?: number;
}

export interface ProfileFile {
  persona: Persona | null;
  convergedAt?: number | null;
  bornAt?: number | null;
}

export interface PreferencesFile {
  vector: TraitVector;
  deltas: TraitVector;
  progress: number;
  observations: number;
  converged: boolean;
  history: { candidateId: string; reward: number; strength: number; by: string; ts: number }[];
  adaptations?: number;
}

export type PreferenceServiceImpl = PreferenceService & {
  deltas(): TraitVector;
  observations(): number;
  converged(): boolean;
  born(): boolean;
  /** Force convergence now (operator shortcut). */
  converge(): Promise<Persona | null>;
  reset(): Promise<void>;
  /** Resolves when every queued dating.leave has been processed. */
  idle(): Promise<void>;
};

export function preferenceModule(opts: PreferenceModuleOptions = {}): Module {
  const offs: (() => void)[] = [];
  return {
    name: "preference",
    async start(ctx: CoreContext) {
      const log = (...a: unknown[]) => ctx.log("preference", ...a);
      const candidates = opts.candidates ?? CANDIDATES;
      const byId = new Map(candidates.map((c) => [c.id, c]));
      const pop = population(candidates);
      const jevKey = opts.jevKey ?? secret("TYPESAFE_API_KEY");
      const convergeAt = opts.convergeAt ?? 0.98;
      const minObs = opts.minObservations ?? 6;
      const home: Pick<HomeService, "read" | "write"> | null = ctx.tryUse("home");
      const read = <T>(n: string, f: T) => (home ? home.read<T>(n, f) : Promise.resolve(f));
      const write = (n: string, d: unknown) => (home ? home.write(n, d).catch((e) => log("write failed", n, e)) : Promise.resolve());

      // --- state ---------------------------------------------------------------
      let obs: Observation[] = [];
      let history: PreferencesFile["history"] = [];
      let conv: ConvergenceState = initialConvergence();
      let P: TraitVector = { ...pop.mean };
      let D: TraitVector = deltas(P, pop);
      let converged = false;
      let persona: Persona | null = null;
      let convergedAt: number | null = null;
      let bornAt: number | null = null;
      let bornEmitted = false;
      let wantBorn = false;
      let deckTotal = opts.expectedTotal ?? (candidates.length || 12);
      let adaptations = 0;
      let queue: Promise<void> = Promise.resolve();

      const profile = await read<ProfileFile>("profile", { persona: null });
      if (profile?.persona) {
        persona = profile.persona;
        convergedAt = profile.convergedAt ?? null;
        bornAt = profile.bornAt ?? null;
        converged = true;
        const prefs = await read<PreferencesFile | null>("preferences", null);
        if (prefs?.vector) {
          P = prefs.vector;
          D = prefs.deltas ?? deltas(P, pop);
          history = prefs.history ?? [];
          adaptations = prefs.adaptations ?? 0;
          conv = { ...initialConvergence(), progress: 1, n: prefs.observations ?? 0 };
        } else {
          P = { ...persona.vector };
          D = deltas(P, pop);
          conv = { ...initialConvergence(), progress: 1 };
        }
        if (bornAt) {
          // She was already alive before this restart. Nobody is connected yet, so this
          // only reaches the world snapshot every client gets in bus.welcome.
          bornEmitted = true;
          ctx.bus.emit("companion.born", { persona, restored: true });
          log(`restored Eve (born ${new Date(bornAt).toISOString()})`);
        } else log("restored a converged persona, waiting for emergence");
      }

      const persistPrefs = () =>
        write("preferences", {
          vector: round3(P),
          deltas: D,
          progress: conv.progress,
          observations: conv.n,
          converged,
          history,
          adaptations,
        } satisfies PreferencesFile);
      const persistProfile = () => write("profile", { persona, convergedAt, bornAt } satisfies ProfileFile);

      const emitUpdate = (parent?: string) =>
        ctx.bus.emit("preference.update", { vector: round3(P), deltas: D, progress: conv.progress, observations: conv.n }, "core", parent);

      const emitBorn = () => {
        if (!persona || bornEmitted) return;
        bornEmitted = true;
        wantBorn = false;
        bornAt = Date.now();
        ctx.bus.emit("companion.born", { persona });
        void persistProfile();
        log("Eve is born");
      };

      const converge = async (parent?: string): Promise<Persona | null> => {
        if (converged) return persona;
        converged = true;
        conv = { ...conv, progress: 1 };
        emitUpdate(parent);
        const { persona: p, by } = await synthesizePersona(P, D, conv.n, ctx.tryUse("brains"), { timeoutMs: opts.personaTimeoutMs });
        persona = p;
        convergedAt = Date.now();
        ctx.bus.emit("preference.converged", { vector: round3(P), persona: p }, "core", parent);
        log(`converged after ${conv.n} profiles, persona text by ${by}`);
        await Promise.all([persistPrefs(), persistProfile()]);
        if (wantBorn) emitBorn();
        return p;
      };

      const score = async (c: Candidate | undefined, o: LeaveObservation): Promise<RewardResult> => {
        if (jevKey) {
          try {
            return await jevReward(c, o, { apiKey: jevKey, fetch: opts.fetch, timeoutMs: opts.jevTimeoutMs ?? 400 });
          } catch (err) {
            log("jev fell back to local:", String(err));
          }
        }
        return localReward(c, o);
      };

      const handleLeave = async (o: LeaveObservation, parent: string) => {
        const c = byId.get(o.candidateId);
        if (!c) {
          log(`unknown candidate ${o.candidateId}, ignored`);
          return;
        }
        const r = await score(c, o);
        ctx.bus.emit(
          "dating.signal",
          { candidateId: c.id, interest: r.interest, strength: r.strength, reward: r.reward, by: r.by },
          "core",
          parent,
        );
        history.push({ candidateId: c.id, reward: r.reward, strength: r.strength, by: r.by, ts: Date.now() });

        if (converged) {
          // Optional adaptation after birth: only clear positives move her, slowly.
          if (r.interest.positive >= 0.5) {
            P = adapt(P, c.traits, 0.85);
            D = deltas(P, pop);
            adaptations++;
            emitUpdate(parent);
            await persistPrefs();
          }
          return;
        }

        // A second look at the same card replaces the first observation.
        obs = obs.filter((x) => x.candidateId !== c.id);
        obs.push({ candidateId: c.id, traits: c.traits, reward: r.reward, focus: focus(c, o) });
        P = estimate(obs);
        D = deltas(P, pop);
        conv = stepConvergence(conv, direction(P, pop));
        conv = { ...conv, n: obs.length };
        emitUpdate(parent);
        void persistPrefs();
        const done = (conv.progress >= convergeAt && obs.length >= minObs) || obs.length >= deckTotal;
        if (done) await converge(parent);
      };

      const service: PreferenceServiceImpl = {
        vector: () => round3(P),
        progress: () => conv.progress,
        persona: () => persona,
        deltas: () => D,
        observations: () => conv.n,
        converged: () => converged,
        born: () => bornEmitted,
        converge: async () => {
          await queue;
          if (!obs.length && !converged) return null;
          return converge();
        },
        reset: async () => {
          await queue;
          if (persona) await write("profile.prev.json", { persona, convergedAt, bornAt });
          obs = [];
          history = [];
          conv = initialConvergence();
          P = { ...pop.mean };
          D = deltas(P, pop);
          converged = false;
          persona = null;
          convergedAt = null;
          bornAt = null;
          bornEmitted = false;
          wantBorn = false;
          adaptations = 0;
          await Promise.all([persistProfile(), persistPrefs()]);
          emitUpdate();
          log("act I reset");
        },
        idle: () => queue,
      };
      ctx.provide("preference", service);

      offs.push(
        ctx.bus.on("dating.view", (e) => {
          if (e.data.total > 0) deckTotal = e.data.total;
        }),
        ctx.bus.on("dating.leave", (e) => {
          // Serialize: the math is order-dependent and Jev calls are async.
          queue = queue.then(() => handleLeave(e.data, e.id)).catch((err) => log("leave failed", err));
        }),
        ctx.bus.on("shell.scene", (e) => {
          if (e.data.scene !== "emergence") return;
          if (persona && converged) emitBorn();
          else wantBorn = true;
        }),
      );

      ctx.route("/api/preference/reset", async (req) => {
        if (req.method !== "POST") return null;
        await service.reset();
        return json({ ok: true });
      });
      ctx.route("/api/preference/converge", async (req) => {
        if (req.method !== "POST") return null;
        const p = await service.converge();
        return json({ ok: !!p, persona: p });
      });
      ctx.route("/api/preference", (_req, url) => {
        if (url.pathname !== "/api/preference" && url.pathname !== "/api/preference/") return null;
        return json({
          vector: round3(P),
          deltas: D,
          progress: conv.progress,
          observations: conv.n,
          converged,
          born: bornEmitted,
          bornAt,
          persona,
          history,
          by: jevKey ? "jev" : "local",
        });
      });

      log(`${candidates.length} candidates, scoring by ${jevKey ? "jev (local fallback)" : "local model"}`);
    },
    stop() {
      for (const off of offs.splice(0)) off();
    },
  };
}
