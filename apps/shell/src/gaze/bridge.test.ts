import { describe, expect, test } from "bun:test";
import { eyeLabel, lostReason } from "./bridge";

describe("eye-client integration", () => {
  test("lost reasons map to the bus vocabulary, target switches are not losses", () => {
    expect(lostReason("target_changed")).toBeNull();
    expect(lostReason("ambiguous_target")).toBeNull();
    expect(lostReason("face lost")).toBe("no_face");
    expect(lostReason("enter fullscreen to enable gaze mapping")).toBe("offscreen");
    expect(lostReason("geometry changed")).toBe("offscreen");
    expect(lostReason("head_pose_outside_calibration")).toBe("away");
    expect(lostReason("sample gap")).toBe("away");
  });

  test("hud label says why gaze is off", () => {
    expect(eyeLabel({ valid: true, accuracyDeg: 2.62 })).toBe("eye 2.6°");
    expect(eyeLabel({ valid: false, reason: "enter fullscreen to enable gaze mapping" })).toBe("eye: enter fullscreen");
    expect(eyeLabel({ valid: false, reason: "head_pose_outside_calibration" })).toBe("eye: sit where you calibrated");
    expect(eyeLabel(null)).toBe("eye");
  });
});
