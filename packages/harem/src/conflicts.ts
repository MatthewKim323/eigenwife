import { newId } from "@eigenwife/protocol";
import type { BudgetResult, CalendarResult, Conflict, FoodOption, FoodResult, HaremAgent, LogisticsResult } from "./types";

export interface Findings {
  food?: { agent: HaremAgent; result: FoodResult };
  budget?: { agent: HaremAgent; result: BudgetResult };
  calendar?: { agent: HaremAgent; result: CalendarResult };
  logistics?: { agent: HaremAgent; result: LogisticsResult };
}

export function collect(agents: HaremAgent[]): Findings {
  const f: Findings = {};
  for (const a of agents) {
    const r = a.result;
    if (!r) continue;
    if (r.type === "food_result") f.food = { agent: a, result: r };
    else if (r.type === "budget_result") f.budget = { agent: a, result: r };
    else if (r.type === "calendar_result") f.calendar = { agent: a, result: r };
    else if (r.type === "logistics_result") f.logistics = { agent: a, result: r };
  }
  return f;
}

/**
 * Wives never chat with each other. Conflicts are found by comparing their
 * structured results, and each side gets exactly one quip. The illusion of a
 * catfight, for zero extra model calls.
 */
export function detectConflicts(f: Findings): Conflict[] {
  const out: Conflict[] = [];
  const top = f.food?.result.options[0];
  if (top && f.food && f.budget && top.cost > f.budget.result.maxRecommendedSpend) {
    out.push({
      id: newId("conflict"),
      topic: "restaurant_selection",
      a: f.food.agent.id,
      b: f.budget.agent.id,
      lines: [
        { agentId: f.food.agent.id, text: `${top.name}. It's worth it.` },
        { agentId: f.budget.agent.id, text: `It's ${dollars(top.cost)} for ${noun(top)}. Absolutely not.` },
      ],
    });
  }
  if (top && f.food && f.logistics && top.distanceMinutes > f.logistics.result.maxTravelMinutes) {
    out.push({
      id: newId("conflict"),
      topic: "travel_time",
      a: f.food.agent.id,
      b: f.logistics.agent.id,
      lines: [
        { agentId: f.food.agent.id, text: `${top.name} is right there.` },
        { agentId: f.logistics.agent.id, text: `${top.distanceMinutes} minutes is not "right there".` },
      ],
    });
  }
  return out;
}

/** Eve's pick: best-fit option that survives every constraint, relaxing the weakest one if nothing does. */
export function choose(f: Findings): { option: FoodOption; start: string; relaxed?: string } | null {
  const options = f.food?.result.options ?? [];
  if (!options.length) return null;
  const maxSpend = f.budget?.result.maxRecommendedSpend ?? Infinity;
  const maxTravel = f.logistics?.result.maxTravelMinutes ?? Infinity;
  const start = f.calendar?.result.suggestedStart ?? "19:30";
  const byFit = [...options].sort((a, b) => b.fit - a.fit);
  const ok = byFit.find((o) => o.cost <= maxSpend && o.distanceMinutes <= maxTravel);
  if (ok) return { option: ok, start };
  const cheapEnough = byFit.find((o) => o.cost <= maxSpend);
  if (cheapEnough) return { option: cheapEnough, start, relaxed: "travel" };
  return { option: [...options].sort((a, b) => a.cost - b.cost)[0]!, start, relaxed: "budget" };
}

export function eveResolveLine(conflicts: Conflict[]): string {
  return conflicts.length > 1 ? "Ladies. One at a time." : "Girls.";
}

/** "7:30, ramen, $18, twelve minutes away. Done." */
export function eveSummary(pick: { option: FoodOption; start: string }): string {
  const o = pick.option;
  return `${clock(pick.start)}, ${o.dish ? o.dish.toLowerCase() : o.name} at ${o.name}, ${dollars(o.cost)}, ${words(o.distanceMinutes)} minutes away.`;
}

function noun(o: FoodOption): string {
  const d = `${o.dish ?? ""} ${o.name}`.toLowerCase();
  if (/ramen|udon|soba|noodle|tantanmen|pho/.test(d)) return "noodles";
  if (/pizza/.test(d)) return "pizza";
  if (/sushi/.test(d)) return "rice and fish";
  return "dinner";
}

export function dollars(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

export function clock(hhmm: string): string {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return hhmm;
  const h = Number(m[1]) % 12 || 12;
  return `${h}:${m[2]}`;
}

const SMALL = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
function words(n: number): string {
  const r = Math.round(n);
  return SMALL[r] ?? String(r);
}
