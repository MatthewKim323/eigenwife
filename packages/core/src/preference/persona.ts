import { TRAIT_KEYS, type Persona, type TraitKey, type TraitVector } from "@eigenwife/protocol";
import type { BrainService } from "../services";

/**
 * Persona synthesis: the converged preference vector becomes Eve.
 *
 * Dials (0..1) blend the absolute level P[t] with the standardized delta
 * (how much the user preferred t relative to the pool):
 *   level(t)   = clamp01(0.55 * P[t] + 0.45 * (0.5 + 0.5 * delta[t]))
 *   humor      = level(humor)
 *   sarcasm    = level(sarcasm)
 *   warmth     = level(warmth)
 *   initiative = 0.5 level(ambition) + 0.5 level(spontaneity)
 *   verbosity  = clamp(0.15 + 0.35 level(nerdiness) + 0.2 level(warmth) - 0.25 level(sarcasm) - 0.1 level(chaos), 0.1, 0.75)
 *   chaos      = 0.6 level(chaos) + 0.25 level(spontaneity) + 0.15 level(nightlife)
 * Palette hue: circular mean of per-trait hues weighted by positive deltas.
 * Text (description, personality, scenario) comes from brains.quickJson, with
 * a deterministic template when no brain answers.
 */

const clamp = (x: number, lo = 0, hi = 1) => (x < lo ? lo : x > hi ? hi : x);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export const TRAIT_HUES: Partial<Record<TraitKey, number>> = {
  warmth: 20,
  humor: 45,
  spontaneity: 60,
  outdoors: 130,
  fitness: 150,
  sporty: 165,
  travel: 185,
  nerdiness: 205,
  polished: 225,
  career_focus: 240,
  ambition: 250,
  nightlife: 265,
  sarcasm: 285,
  alternative: 300,
  chaos: 330,
  style: 345,
};

export const TRAIT_WORDS: Record<TraitKey, string> = {
  style: "stylish",
  sporty: "sporty",
  alternative: "a little alt",
  polished: "polished",
  humor: "funny",
  sarcasm: "sarcastic",
  warmth: "warm",
  ambition: "ambitious",
  spontaneity: "spontaneous",
  nerdiness: "nerdy",
  chaos: "chaotic",
  nightlife: "a night owl",
  outdoors: "outdoorsy",
  fitness: "fit",
  travel: "a traveler",
  career_focus: "career-driven",
};

export function dials(P: TraitVector, d: TraitVector): Persona["dials"] {
  const level = (t: TraitKey) => clamp(0.55 * (P[t] ?? 0.5) + 0.45 * (0.5 + 0.5 * (d[t] ?? 0)));
  return {
    humor: r3(level("humor")),
    sarcasm: r3(level("sarcasm")),
    warmth: r3(level("warmth")),
    initiative: r3(0.5 * level("ambition") + 0.5 * level("spontaneity")),
    verbosity: r3(clamp(0.15 + 0.35 * level("nerdiness") + 0.2 * level("warmth") - 0.25 * level("sarcasm") - 0.1 * level("chaos"), 0.1, 0.75)),
    chaos: r3(clamp(0.6 * level("chaos") + 0.25 * level("spontaneity") + 0.15 * level("nightlife"))),
  };
}

export function paletteHue(d: TraitVector): number {
  let x = 0;
  let y = 0;
  for (const [t, hue] of Object.entries(TRAIT_HUES) as [TraitKey, number][]) {
    const w = Math.max(0, d[t] ?? 0);
    x += w * Math.cos((hue * Math.PI) / 180);
    y += w * Math.sin((hue * Math.PI) / 180);
  }
  if (Math.hypot(x, y) < 1e-6) return 320;
  return Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
}

export function topTraits(d: TraitVector, n = 3): TraitKey[] {
  return (TRAIT_KEYS as TraitKey[])
    .filter((t) => (d[t] ?? 0) > 0.05)
    .sort((a, b) => (d[b] ?? 0) - (d[a] ?? 0))
    .slice(0, n);
}

export function voiceStyle(k: Persona["dials"]): string {
  const bits: string[] = [];
  if (k.sarcasm > 0.6) bits.push("dry, deadpan delivery");
  else if (k.warmth > 0.6) bits.push("soft and warm");
  else bits.push("easygoing");
  if (k.humor > 0.6) bits.push("playful teasing timing");
  if (k.warmth > 0.6 && k.sarcasm > 0.6) bits.push("warm underneath");
  if (k.chaos > 0.6) bits.push("a little unhinged");
  bits.push(k.verbosity < 0.35 ? "short sentences" : "unhurried");
  return bits.join(", ");
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function templateText(k: Persona["dials"], d: TraitVector, observations: number) {
  const top = topTraits(d).map((t) => TRAIT_WORDS[t]);
  const list = top.length ? top.join(", ") : "hard to pin down";
  return {
    tagline: top.length ? `${top.slice(0, 2).join(" and ")}. Your type, compiled.` : "Your type, compiled.",
    description: `Eve is the companion your attention compiled: ${list}. She lives on your desktop, sees what you are looking at, and remembers what matters.`,
    personality: [
      `Humor ${pct(k.humor)}, sarcasm ${pct(k.sarcasm)}, warmth ${pct(k.warmth)}, initiative ${pct(k.initiative)}.`,
      k.sarcasm > 0.6 ? "Teases first, helps second, but always helps." : "Kind first, teasing second.",
      k.verbosity < 0.35 ? "Talks in short lines and never lectures." : "Explains when it matters, briefly.",
      k.chaos > 0.6 ? "Occasionally chaotic on purpose." : "",
      `She knows she was assembled from what held your gaze (${list}) and is not shy about it.`,
    ]
      .filter(Boolean)
      .join(" "),
    scenario: `She just stepped out of the Eigen dating app after ${observations} profiles. The user's eyes kept landing on ${list}; she is the result. Now she lives on their desktop and has her own computer.`,
  };
}

export const PERSONA_SYSTEM = `You write the character sheet for Eve, a desktop AI companion whose personality was inferred from what held the user's attention on a dating app.
Return JSON only: {"tagline": "<= 8 words", "description": "2 sentences", "personality": "3-4 sentences, second person never, concrete speech habits", "scenario": "2 sentences, she just emerged from the dating app onto their desktop"}.
Match the dials exactly (0..1). No em dashes. Keep it playful, a little uncanny, never explicit.`;

export async function synthesizePersona(
  P: TraitVector,
  d: TraitVector,
  observations: number,
  brains: BrainService | null,
  opts: { timeoutMs?: number; voiceId?: string } = {},
): Promise<{ persona: Persona; by: "brain" | "template" }> {
  const k = dials(P, d);
  const base = templateText(k, d, observations);
  let text = base;
  let by: "brain" | "template" = "template";
  if (brains) {
    try {
      const top = topTraits(d, 4).map((t) => `${t} ${d[t]! >= 0 ? "+" : ""}${d[t]!.toFixed(2)}`);
      const out = await brains.quickJson<Record<string, unknown>>(
        PERSONA_SYSTEM,
        JSON.stringify({ dials: k, strongestPreferences: top, observations }),
        { timeoutMs: opts.timeoutMs ?? 6000 },
      );
      const pick = (key: keyof typeof base) => {
        const v = out?.[key];
        return typeof v === "string" && v.trim() ? v.trim().replace(/[–—]/g, ",").slice(0, 600) : null;
      };
      if (out && pick("description") && pick("personality")) {
        text = { tagline: pick("tagline") ?? base.tagline, description: pick("description")!, personality: pick("personality")!, scenario: pick("scenario") ?? base.scenario };
        by = "brain";
      }
    } catch {}
  }
  return {
    by,
    persona: {
      name: "Eve",
      ...text,
      dials: k,
      voice: { provider: "openai", voiceId: opts.voiceId ?? "marin", style: voiceStyle(k) },
      palette: { hue: paletteHue(d) },
      vector: Object.fromEntries(Object.entries(P).map(([t, x]) => [t, r3(x)])),
    },
  };
}
