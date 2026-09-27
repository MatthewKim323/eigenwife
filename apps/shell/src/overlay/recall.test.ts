import { expect, test } from "bun:test";
import { ago, recallFlash } from "./status";

const NOW = Date.parse("2026-09-26T12:00:00Z");

test("gbrain memories say where they came from", () => {
  const hits = [{ record: { content: "Leo Park (friend): climbing partner", source: "gbrain", provenance: { system: "gbrain", slug: "people/leo-park", title: "Leo Park", at: Date.parse("2026-07-26T12:00:00Z") } } }];
  expect(recallFlash(hits, 3.6, NOW)).toBe("remembered from gbrain · 4ms · Leo Park · 2mo ago");
  expect(recallFlash(hits, 0.2, NOW)).toBe("remembered from gbrain · 1ms · Leo Park · 2mo ago");
});

test("everything else keeps the old flash", () => {
  expect(recallFlash([{ record: { content: "likes spicy food", source: "observation" } }], 2, NOW)).toBe("remembered · 2ms · likes spicy food");
  expect(recallFlash([], 2, NOW)).toBeNull();
});

test("ago", () => {
  expect(ago(20_000)).toBe("just now");
  expect(ago(5 * 60_000)).toBe("5m ago");
  expect(ago(30 * 3600_000)).toBe("30h ago");
  expect(ago(10 * 86_400_000)).toBe("10d ago");
  expect(ago(800 * 86_400_000)).toBe("2y ago");
});
