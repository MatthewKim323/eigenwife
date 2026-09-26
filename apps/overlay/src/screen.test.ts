import { expect, test } from "bun:test";
import { isEnvelope } from "@eigenwife/protocol";
import { parseScreenStatus, screenPauseEnvelope } from "./state";

test("screen.pause is a valid bus envelope (tray 'Pause screen' and cmd+shift+P)", () => {
  const e = screenPauseEnvelope(true, 1000);
  expect(isEnvelope(e)).toBe(true);
  expect(e.type).toBe("screen.pause");
  expect(e.data).toEqual({ paused: true, by: "overlay" });
});

test("tray reads the core's screen status; anything else means 'no screen module'", () => {
  expect(parseScreenStatus({ enabled: true, paused: true, stats: {} })).toEqual({ enabled: true, paused: true });
  expect(parseScreenStatus({ enabled: false })).toEqual({ enabled: false, paused: false });
  expect(parseScreenStatus(null)).toBeNull();
  expect(parseScreenStatus({ error: "not found" })).toBeNull();
});
