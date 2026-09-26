import { DEFAULT_RELATIONSHIP, type RelationshipState } from "@eigenwife/protocol";
import type { CoreContext, Module } from "../context";
import { json } from "../hub";
import { applyNudge, combine, decay, distance, HALF_LIFE_MS, readSignals, seedFromPersona } from "./relationship";

export interface RelationshipOptions {
  now?: () => number;
  halfLifeMs?: number;
  /** Decay is folded in at most this often (on timer.tick). */
  decayEveryMs?: number;
  /** Coalesce home writes. 0 writes synchronously on every change. */
  persistDebounceMs?: number;
}

interface Saved {
  state: RelationshipState;
  baseline: RelationshipState;
  persona?: string;
  savedAt: number;
}

/**
 * Relationship model service. Listens to the bus for social signals (laughs,
 * dismissals, terse replies, task outcomes), keeps five bounded scalars that
 * relax toward the persona baseline, persists through `home`, and announces
 * every change as relationship.update so the HUD and the world see it.
 */
export function relationshipModule(opts: RelationshipOptions = {}): Module {
  const now = opts.now ?? Date.now;
  const halfLife = opts.halfLifeMs ?? HALF_LIFE_MS;
  const decayEvery = opts.decayEveryMs ?? 30_000;
  const debounce = opts.persistDebounceMs ?? 500;
  let state: RelationshipState = { ...DEFAULT_RELATIONSHIP };
  let baseline: RelationshipState = { ...DEFAULT_RELATIONSHIP };
  let persona: string | undefined;
  let lastDecayAt = now();
  let lastAnnounced = { ...state };
  let herLineAt: number | undefined;
  let turns = 0;
  let writeTimer: ReturnType<typeof setTimeout> | undefined;
  let ctxRef: CoreContext | null = null;
  const offs: (() => void)[] = [];

  const persist = async () => {
    writeTimer = undefined;
    const home = ctxRef?.tryUse("home");
    if (!home) return;
    const saved: Saved = { state, baseline, persona, savedAt: now() };
    try {
      await home.write("relationship", saved);
    } catch (err) {
      ctxRef?.log("relationship", "persist failed:", err);
    }
  };
  const schedulePersist = () => {
    if (debounce <= 0) return void persist();
    if (!writeTimer) writeTimer = setTimeout(persist, debounce);
  };

  const announce = (delta: Partial<RelationshipState>, reason: string, parent?: string) => {
    lastAnnounced = { ...state };
    ctxRef?.bus.emit("relationship.update", { state: { ...state }, delta, reason }, "core", parent);
    schedulePersist();
  };

  const settle = () => {
    const t = now();
    const dt = t - lastDecayAt;
    lastDecayAt = t;
    state = decay(state, baseline, dt, halfLife);
  };

  const nudge = (delta: Partial<RelationshipState>, reason: string, parent?: string): RelationshipState => {
    settle();
    const r = applyNudge(state, delta);
    state = r.state;
    if (Object.keys(r.applied).length) {
      ctxRef?.log("relationship", reason, r.applied);
      announce(r.applied, reason, parent);
    }
    return { ...state };
  };

  return {
    name: "relationship",
    async start(ctx) {
      ctxRef = ctx;
      ctx.provide("relationship", { get: () => ({ ...state }), nudge: (d, reason) => nudge(d, reason) });

      const home = ctx.tryUse("home");
      if (!home) ctx.log("relationship", "no home service: relationship lives in memory only");
      else {
        try {
          const saved = await home.read<Saved | null>("relationship", null);
          if (saved?.state && saved.baseline) {
            baseline = { ...DEFAULT_RELATIONSHIP, ...saved.baseline };
            state = decay({ ...DEFAULT_RELATIONSHIP, ...saved.state }, baseline, Math.max(0, now() - (saved.savedAt ?? now())), halfLife);
            persona = saved.persona;
            lastDecayAt = now();
            announce({}, "restored from home");
          }
        } catch (err) {
          ctx.log("relationship", "restore failed:", err);
        }
      }

      offs.push(
        ctx.bus.on("companion.born", (e) => {
          const seeded = seedFromPersona(e.data.persona);
          baseline = seeded;
          if (persona !== e.data.persona.name) state = { ...seeded };
          persona = e.data.persona.name;
          lastDecayAt = now();
          announce({}, `seeded from ${e.data.persona.name}'s dials`, e.id);
        }),
        ctx.bus.on("speech.begin", () => (herLineAt = now())),
        ctx.bus.on("speech.end", () => (herLineAt = now())),
        ctx.bus.on("voice.final", (e) => {
          const t = now();
          const since = herLineAt !== undefined ? t - herLineAt : undefined;
          const reply = since !== undefined && since < 30_000;
          turns = reply ? turns + 1 : 0;
          const c = combine(readSignals(e.data.text, { sinceHerLineMs: since, turns }));
          if (c) nudge(c.delta, c.reason, e.id);
        }),
        ctx.bus.on("task.done", (e) =>
          nudge(e.data.ok ? { confidence: 0.03 } : { confidence: -0.03 }, e.data.ok ? "task went well" : "task failed", e.id),
        ),
        ctx.bus.on("action.approval", (e) => {
          if (e.data.by === "policy") return;
          nudge(e.data.approved ? { confidence: 0.01 } : { initiative: -0.02 }, e.data.approved ? "user approved her action" : "user declined her suggestion", e.id);
        }),
        ctx.bus.on("timer.tick", () => {
          if (now() - lastDecayAt < decayEvery) return;
          settle();
          if (distance(state, lastAnnounced) >= 0.01) {
            const delta: Partial<RelationshipState> = {};
            for (const k of Object.keys(state) as (keyof RelationshipState)[])
              if (state[k] !== lastAnnounced[k]) delta[k] = Math.round((state[k] - lastAnnounced[k]) * 1000) / 1000;
            announce(delta, "decay toward baseline");
          }
        }),
      );

      ctx.route("/api/relationship", () => json({ state, baseline, persona }));
    },
    async stop() {
      for (const off of offs.splice(0)) off();
      if (writeTimer) {
        clearTimeout(writeTimer);
        await persist();
      }
    },
  };
}
