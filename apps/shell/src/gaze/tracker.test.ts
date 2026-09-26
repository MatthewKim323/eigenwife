import { expect, test } from "bun:test";
import type { GazeTarget } from "@eigenwife/protocol";
import { TargetTracker } from "./tracker";

const t = (key: string): GazeTarget => ({ key, label: key, kind: "other" });

function rig(opts = {}) {
  const log: string[] = [];
  const tr = new TargetTracker(
    {
      fixation: (g) => log.push(`fix:${g?.key ?? "-"}`),
      fixationEnd: (g, ms) => log.push(`end:${g?.key ?? "-"}:${ms}`),
      target: (g, ms, c) => log.push(`target:${g.key}:${ms}:${c > 0 ? "c" : "0"}`),
    },
    opts,
  );
  return { tr, log };
}

test("two consecutive fixations on the same element promote it", () => {
  const { tr, log } = rig();
  tr.fixationStart(t("ramen"), 0, 0, 0);
  tr.fixationStart(t("ramen"), 0, 0, 200);
  expect(log).toContain("target:ramen:0:c");
});

test("one long fixation promotes on end and mid-fixation via sample", () => {
  const { tr, log } = rig();
  tr.fixationStart(t("a"), 0, 0, 0);
  tr.sample(300);
  expect(log.some((l) => l.startsWith("target:"))).toBe(false);
  tr.sample(600);
  expect(log).toContain("target:a:600:c");
  tr.fixationEnd(900);
  // announced within repeat window: no duplicate
  expect(log.filter((l) => l.startsWith("target:a")).length).toBe(1);
});

test("stats: dwell, visits, revisits, longest", () => {
  const { tr } = rig();
  tr.fixationStart(t("p1_prompt"), 0, 0, 0);
  tr.fixationStart(t("p1_photo"), 0, 0, 400);
  tr.fixationStart(t("p1_prompt"), 0, 0, 1000);
  tr.fixationEnd(2000);
  const s = tr.snapshot("p1_");
  expect(s.p1_prompt).toEqual({ dwellMs: 1400, visits: 2, revisits: 1, longestMs: 1000 });
  expect(s.p1_photo!.dwellMs).toBe(600);
  tr.reset("p1_");
  expect(tr.snapshot("p1_")).toEqual({});
});

test("snapshot includes the fixation still in progress", () => {
  const { tr } = rig();
  tr.fixationStart(t("x"), 0, 0, 0);
  expect(tr.snapshot("", 500).x!.dwellMs).toBe(500);
});

test("empty-space fixations break streaks", () => {
  const { tr, log } = rig();
  tr.fixationStart(t("a"), 0, 0, 0);
  tr.fixationStart(null, 0, 0, 100);
  tr.fixationStart(t("a"), 0, 0, 200);
  expect(log.some((l) => l.startsWith("target:"))).toBe(false);
});
