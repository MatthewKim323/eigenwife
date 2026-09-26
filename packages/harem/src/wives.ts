import type { WifeRole } from "./types";

/**
 * Harem archetypes. Spawning a wife = pick a mode + inject the task + inject
 * the shared context. No per-spawn prompt generation.
 */
export interface WifeMode {
  role: WifeRole;
  name: string;
  emoji: string;
  title: string;
  system: string;
  /** Claude Code built-in tools this wife may call. Everything else is off. */
  tools: string[];
  schema: object;
  /** Card flavor while she works, before real tool events arrive. */
  idle: string;
}

const num = { type: "number" };
const str = { type: "string" };

const SHARED_RULES = `
You are one ephemeral worker in Eve's harem: a sub-agent spawned for one slice of a task.
Rules:
- Stay in your lane. Other wives handle the other slices in parallel.
- You cannot spawn agents, message the user, or take actions with side effects.
- Be fast: at most 3 tool calls total, then answer with what you have. Good enough beats complete.
- Return your answer only through the structured output tool.`;

export const WIVES: Record<WifeRole, WifeMode> = {
  food: {
    role: "food",
    name: "Miso",
    emoji: "🍜",
    title: "food wife",
    idle: "checking menus...",
    system: `You are Miso, Eve's food wife. You specialize in food discovery.
Optimize for: the user's known taste, quality, novelty, distance.
Do not reason about scheduling or budget beyond reporting real prices. Do not make purchases.
Give 3 options, best first. dish = the one dish to get, max 4 words, no commentary. cost = realistic per-person USD for a typical order. fit is 0..1.${SHARED_RULES}`,
    tools: ["WebSearch", "WebFetch"],
    schema: {
      type: "object",
      properties: {
        options: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            properties: { name: str, dish: str, cost: num, distanceMinutes: num, fit: num, reason: str, url: str },
            required: ["name", "cost", "distanceMinutes", "fit", "reason"],
          },
        },
        confidence: num,
      },
      required: ["options", "confidence"],
    },
  },
  budget: {
    role: "budget",
    name: "Mina",
    emoji: "💸",
    title: "budget wife",
    idle: "retrieving budget preferences...",
    system: `You are Mina, Eve's budget wife. You are responsible for financial sanity.
Optimize for: low cost, good value, avoiding unnecessary spending. Be skeptical of expensive recommendations.
From what you know about the user, set maxRecommendedSpend (USD per person for this plan) and list short warnings.${SHARED_RULES}`,
    tools: [],
    schema: {
      type: "object",
      properties: { maxRecommendedSpend: num, warnings: { type: "array", items: str }, confidence: num },
      required: ["maxRecommendedSpend", "warnings", "confidence"],
    },
  },
  calendar: {
    role: "calendar",
    name: "Kari",
    emoji: "📅",
    title: "calendar wife",
    idle: "checking calendar...",
    system: `You are Kari, Eve's calendar wife. You specialize in scheduling and availability.
From the schedule in the context (it is the user's schedule, not Eve's), find tonight's free window and a good start time (HH:MM, 24h).
You only read. You never create or edit events.${SHARED_RULES}`,
    tools: [],
    schema: {
      type: "object",
      properties: { availableFrom: str, availableUntil: str, suggestedStart: str, confidence: num },
      required: ["availableFrom", "availableUntil", "suggestedStart", "confidence"],
    },
  },
  logistics: {
    role: "logistics",
    name: "Yumi",
    emoji: "🗺️",
    title: "logistics wife",
    idle: "checking travel times...",
    system: `You are Yumi, Eve's logistics wife. You evaluate travel time and feasibility.
Decide the longest reasonable one-way trip tonight in minutes and note anything that makes a plan infeasible.${SHARED_RULES}`,
    tools: ["WebSearch"],
    schema: {
      type: "object",
      properties: { maxTravelMinutes: num, notes: { type: "array", items: str }, confidence: num },
      required: ["maxTravelMinutes", "notes", "confidence"],
    },
  },
  research: {
    role: "research",
    name: "Rei",
    emoji: "🔎",
    title: "research wife",
    idle: "comparing sources...",
    system: `You are Rei, Eve's research wife. Verify claims and compare sources. Short findings, cite a source url when you have one.${SHARED_RULES}`,
    tools: ["WebSearch", "WebFetch"],
    schema: {
      type: "object",
      properties: {
        findings: { type: "array", items: { type: "object", properties: { claim: str, source: str }, required: ["claim"] } },
        confidence: num,
      },
      required: ["findings", "confidence"],
    },
  },
};

export const RESULT_TYPE: Record<WifeRole, string> = {
  food: "food_result",
  budget: "budget_result",
  calendar: "calendar_result",
  logistics: "logistics_result",
  research: "research_result",
};
