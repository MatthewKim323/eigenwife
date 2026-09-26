import type { MemoryRecord } from "@eigenwife/protocol";

const DAY = 86_400_000;

/**
 * Demo seed (config.demo): plausible things Eve already knows, spread over the
 * past few weeks so recency does real work in the score. Ids are stable, so
 * seeding twice is a no-op. Only used when the store is empty.
 */
export function seedMemories(now = Date.now()): MemoryRecord[] {
  const rows: [string, MemoryRecord["kind"], string, number, number, number, string[]][] = [
    // id, kind, content, importance, confidence, daysAgo, tags
    ["seed_spicy", "preference", "Likes spicy food, the hotter the better", 0.7, 0.9, 19, ["food", "taste"]],
    ["seed_ramen28", "episodic", "Complained that a $28 ramen bowl was overpriced", 0.62, 0.95, 6, ["food", "money"]],
    ["seed_saving", "fact", "Trying to save money this month", 0.75, 0.85, 3, ["money", "goal"]],
    ["seed_worklate", "fact", "Works late on weekdays, usually past 8pm", 0.55, 0.8, 11, ["schedule", "work"]],
    ["seed_japanese", "preference", "Likes Japanese food, especially ramen and izakaya spots", 0.6, 0.85, 24, ["food", "taste"]],
    ["seed_concise", "preference", "Hates long explanations, prefers short direct answers", 0.72, 0.9, 15, ["style"]],
    ["seed_teased", "episodic", "Laughed hard when teased about checking the dating app again", 0.5, 0.8, 2, ["humor", "relationship"]],
    ["seed_outdoors", "preference", "Not into outdoor-heavy plans like hikes or camping", 0.45, 0.75, 27, ["plans", "taste"]],
  ];
  return rows.map(([id, kind, content, importance, confidence, daysAgo, tags]) => ({
    id,
    kind,
    content,
    importance,
    confidence,
    source: "seed",
    createdAt: Math.round(now - daysAgo * DAY - (fnv(id) % 7200) * 1000),
    tags,
  }));
}

function fnv(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
