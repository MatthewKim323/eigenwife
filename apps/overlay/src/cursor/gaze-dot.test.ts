import { expect, test } from "bun:test";
import { GazeDot, pillText } from "./gaze-dot";

test("rejection reasons become short, actionable pills", () => {
  expect(pillText("head_pose_outside_calibration", "return to the position and distance used during calibration (vertical_position -0.45; calibrated range -0.4 to -0.2)")).toBe("sit a little higher (where you calibrated)");
  expect(pillText("head_pose_outside_calibration", "face the laptop camera and return to your calibration posture (roll 16.9; calibrated range -7.7 to 13.0)")).toBe("straighten your head (where you calibrated)");
  expect(pillText("face_lost", null)).toBe("can't see your face");
  expect(pillText("outside_display", null)).toBe("looking off screen");
});

test("the dot fades in on valid samples and the pill only after a second of rejection", () => {
  const d = new GazeDot();
  d.feed({ x: 100, y: 100, valid: true, fixMs: 500, radius: 120, t: Date.now() });
  let t = 1000;
  for (; t < 1400; t += 16) d.step(t);
  expect((d as any).alpha).toBeGreaterThan(0.8);
  d.feed({ x: 0, y: 0, valid: false, fixMs: null, radius: 120, t: Date.now(), reason: "face_lost" });
  d.step(t + 500);
  expect((d as any).pillAlpha).toBeLessThan(0.05);
  for (let k = t + 500; k < t + 2500; k += 16) d.step(k);
  expect((d as any).pillAlpha).toBeGreaterThan(0.5);
});
