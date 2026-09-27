import { expect, test } from "bun:test";
import { liveEngineBody, liveMenuInfo, liveMenuLabel, parseLiveStatus } from "./live";

test("tray voice engine: parse /api/live, label the submenu, explain why live is off", () => {
  expect(parseLiveStatus(null)).toBeNull();
  expect(parseLiveStatus({ engine: "turbo" })).toBeNull();
  const off = parseLiveStatus({ engine: "classic", status: "no_access", reason: "Eve Live needs OpenAI or gateway credits (gateway: http 402)", usedMin: 0, capMin: 60, providers: ["gateway"] })!;
  expect(liveMenuLabel(off)).toBe("Voice engine: Classic (Live needs credits)");
  expect(liveMenuInfo(off)).toEqual(["Eve Live needs OpenAI or gateway credits (gateway: http 402)", "Live today: 0 of 60 min"]);
  const on = parseLiveStatus({ engine: "live", status: "live", usedMin: 12.4, capMin: 60, providers: ["gateway"] })!;
  expect(liveMenuLabel(on)).toBe("Voice engine: Live (on)");
  expect(liveMenuLabel(parseLiveStatus({ engine: "live", status: "idle", providers: [] }))).toBe("Voice engine: Live (asleep)");
  expect(liveMenuInfo(parseLiveStatus({ engine: "classic", status: "off", providers: [] }))).toEqual(["Live needs AI_GATEWAY_API_KEY or OPENAI_API_KEY"]);
  expect(liveMenuLabel(null)).toBe("Voice engine (core offline)");
  expect(JSON.parse(liveEngineBody("live"))).toEqual({ engine: "live", by: "tray" });
});
