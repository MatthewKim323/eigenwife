import { expect, test } from "bun:test";
import { emptyWorld, envelope, type AnyEnvelope, type EventMap, type EventType, type GazeTarget, type WorldSnapshot } from "@eigenwife/protocol";
import { MIN, PerceptionEngine, type Trigger } from "../src/reflex/rules";

function harness(world: Partial<WorldSnapshot> = {}) {
  let t = 1_000_000;
  const w: WorldSnapshot = { ...emptyWorld(), ...world };
  const engine = new PerceptionEngine(() => w);
  const fired: Trigger[] = [];
  const feed = <K extends EventType>(type: K, data: EventMap[K]) => {
    const got = engine.feed({ ...envelope(type, data, "test"), ts: t } as AnyEnvelope);
    fired.push(...got);
    return got;
  };
  return {
    w,
    engine,
    fired,
    feed,
    at: (ms: number) => (t += ms),
    rules: () => fired.map((f) => f.rule),
  };
}

const persona = { name: "Eve", dials: { humor: 0.7, sarcasm: 0.6, warmth: 0.5, initiative: 0.5, verbosity: 0.3, chaos: 0.2 } } as any;
const ramen: GazeTarget = { key: "menu_ramen", label: "Garlic Knockout Ramen, $21", kind: "menu-item", meta: { price: 21 } };

test("every utterance is an immediate trigger", () => {
  const h = harness();
  // voice.turn is the merged turn (reflex/module.ts coalesces voice.final pieces into it)
  const [t] = h.feed("voice.turn", { text: "thoughts?", parts: 1 });
  expect(t!.rule).toBe("utterance");
  expect(t!.urgency).toBe("immediate");
  expect(t!.ambient).toBe(false);
  expect(t!.data.text).toBe("thoughts?");
  expect(h.feed("voice.turn", { text: "   ", parts: 1 })).toEqual([]);
});

test("repeat media: same track 3x inside 30 minutes, keyed per track, cooldown", () => {
  const h = harness();
  h.feed("media.play", { track: "Someone Like You", artist: "Adele" });
  h.at(4 * MIN);
  h.feed("media.play", { track: "Other Song" });
  h.feed("media.play", { track: "someone like you" });
  expect(h.rules()).toEqual([]);
  h.at(4 * MIN);
  const [t] = h.feed("media.play", { track: "Someone Like You" });
  expect(t!.rule).toBe("repeat_media");
  expect(t!.data.count).toBe(3);
  expect(t!.description).toContain("3 times");
  // 4th play 30s later is inside the 60s cooldown
  h.at(30_000);
  expect(h.feed("media.play", { track: "Someone Like You" })).toEqual([]);
  h.at(4 * MIN);
  const [t5] = h.feed("media.play", { track: "Someone Like You" });
  expect(t5!.data.count).toBe(5);
});

test("repeat media window slides: plays older than 30 minutes fall out", () => {
  const h = harness();
  h.feed("media.play", { track: "A" });
  h.at(20 * MIN);
  h.feed("media.play", { track: "A" });
  h.at(15 * MIN); // first play is now 35m old
  expect(h.feed("media.play", { track: "A" })).toEqual([]);
  h.at(1 * MIN);
  expect(h.feed("media.play", { track: "A" })[0]!.data.count).toBe(3);
});

test("relapse only fires after companion.born, for the dating app or dating scene", () => {
  const h = harness();
  expect(h.feed("app.opened", { app: "Eigen" })).toEqual([]);
  h.feed("companion.born", { persona });
  h.at(1000);
  const [r] = h.feed("app.opened", { app: "Eigen" });
  expect(r!.rule).toBe("relapse");
  expect(r!.urgency).toBe("immediate");
  // cooldown swallows the scene change that comes right after
  h.at(1000);
  expect(h.feed("shell.scene", { scene: "dating" }).map((x) => x.rule)).toEqual([]);
  h.at(60_000);
  expect(h.feed("shell.scene", { scene: "dating" }).map((x) => x.rule)).toEqual(["relapse"]);
});

test("other apps raise a low-urgency app_opened trigger", () => {
  const h = harness();
  const [t] = h.feed("app.opened", { app: "Spotify" });
  expect(t!.rule).toBe("app_opened");
  expect(t!.urgency).toBe("later");
  h.at(1000);
  expect(h.feed("app.opened", { app: "Slack" })).toEqual([]); // 5s cooldown
});

test("stare: 4s+ on the same content target while silent, once per stare, 45s cooldown", () => {
  const h = harness();
  h.feed("timer.tick", { n: 0 });
  h.at(10_000); // long enough since engine start to count as silent
  h.feed("gaze.target", { target: ramen, dwellMs: 600, confidence: 0.8 });
  h.at(2500);
  expect(h.feed("gaze.target", { target: ramen, dwellMs: 0, confidence: 0.8 })).toEqual([]);
  h.at(2500);
  const [s] = h.feed("gaze.target", { target: ramen, dwellMs: 0, confidence: 0.8 });
  expect(s!.rule).toBe("stare");
  expect(s!.data.targetKey).toBe("menu_ramen");
  expect(s!.data.ms as number).toBeGreaterThanOrEqual(4000);
  h.at(2500);
  expect(h.feed("gaze.target", { target: ramen, dwellMs: 0, confidence: 0.8 })).toEqual([]); // same stare
  // new stare on something else inside 45s: cooldown
  const other: GazeTarget = { ...ramen, key: "menu_gyoza", label: "Gyoza" };
  h.feed("gaze.target", { target: other, dwellMs: 600, confidence: 0.8 });
  h.at(5000);
  expect(h.feed("gaze.target", { target: other, dwellMs: 0, confidence: 0.8 })).toEqual([]);
  h.at(45_000);
  h.feed("gaze.target", { target: ramen, dwellMs: 600, confidence: 0.8 });
  h.at(4000);
  expect(h.feed("gaze.target", { target: ramen, dwellMs: 0, confidence: 0.8 }).map((x) => x.rule)).toEqual(["stare"]);
});

test("stare needs silence, content, and continuity", () => {
  const h = harness();
  h.at(10_000);
  h.feed("voice.final", { text: "hmm" });
  h.feed("gaze.target", { target: ramen, dwellMs: 600, confidence: 0.8 });
  h.at(4500);
  expect(h.feed("gaze.target", { target: ramen, dwellMs: 0, confidence: 0.8 }).map((x) => x.rule)).toEqual([]); // user just spoke
  const ui: GazeTarget = { key: "hud", label: "HUD", kind: "ui" };
  h.at(20_000);
  h.feed("gaze.target", { target: ui, dwellMs: 600, confidence: 0.8 });
  h.at(5000);
  expect(h.feed("gaze.target", { target: ui, dwellMs: 0, confidence: 0.8 })).toEqual([]); // not content
  h.feed("gaze.target", { target: ramen, dwellMs: 600, confidence: 0.8 });
  h.at(2000);
  h.feed("gaze.fixation", { target: ui, x: 0, y: 0 }); // looked away: stare broken
  h.at(2500);
  expect(h.feed("gaze.target", { target: ramen, dwellMs: 0, confidence: 0.8 })).toEqual([]);
});

test("long silence: 3 minutes with a face present, after birth, 10 minute cooldown", () => {
  const h = harness();
  h.feed("companion.born", { persona });
  h.feed("eye.status", { connected: true, calibrated: true, facePresent: true });
  h.at(2 * MIN);
  expect(h.feed("timer.tick", { n: 1 })).toEqual([]);
  h.at(1 * MIN + 1000);
  const [s] = h.feed("timer.tick", { n: 2 });
  expect(s!.rule).toBe("long_silence");
  expect(s!.urgency).toBe("later");
  h.at(5 * MIN);
  expect(h.feed("timer.tick", { n: 3 })).toEqual([]);
  h.at(6 * MIN);
  expect(h.feed("timer.tick", { n: 4 }).map((x) => x.rule)).toEqual(["long_silence"]);
});

test("long silence needs a face", () => {
  const h = harness();
  h.feed("companion.born", { persona });
  h.feed("eye.status", { connected: true, calibrated: true, facePresent: false });
  h.at(5 * MIN);
  expect(h.feed("timer.tick", { n: 1 })).toEqual([]);
});

test("face return after 2+ minutes away, once per return", () => {
  const h = harness();
  h.feed("companion.born", { persona });
  h.feed("gaze.target", { target: ramen, dwellMs: 0, confidence: 0.8 });
  h.feed("gaze.lost", { reason: "away" });
  h.at(60_000);
  expect(h.feed("eye.status", { connected: true, calibrated: true, facePresent: true })).toEqual([]); // 1 min only
  h.feed("gaze.lost", { reason: "no_face" });
  h.at(3 * MIN);
  const [r] = h.feed("eye.status", { connected: true, calibrated: true, facePresent: true });
  expect(r!.rule).toBe("face_return");
  expect(r!.urgency).toBe("soon");
  expect(h.feed("gaze.target", { target: ramen, dwellMs: 0, confidence: 0.8 }).map((x) => x.rule)).not.toContain("face_return");
});

test("task.done is a soon trigger; companion.born is immediate", () => {
  const h = harness();
  expect(h.feed("companion.born", { persona })[0]!.urgency).toBe("immediate");
  const [t] = h.feed("task.done", { taskId: "t1", ok: true, summary: "found 3 ramen spots", ms: 100 });
  expect(t!.rule).toBe("task_done");
  expect(t!.urgency).toBe("soon");
  expect(t!.parent).toBeDefined();
});

test("custom declarative rule with where + window", () => {
  let t = 0;
  const engine = new PerceptionEngine(emptyWorld, [
    {
      id: "spotify_spam",
      doc: "spotify focused 2x in a minute",
      on: "app.focused",
      urgency: "later",
      where: { app: /spotify/i },
      window: { count: 2, withinMs: 60_000 },
      describe: (_e, _rc, n) => `spotify ${n}x`,
    },
  ]);
  const feed = (app: string) => engine.feed({ ...envelope("app.focused", { app }, "t"), ts: (t += 1000) } as AnyEnvelope);
  expect(feed("Spotify")).toEqual([]);
  expect(feed("Slack")).toEqual([]);
  expect(feed("spotify")[0]!.description).toBe("spotify 2x");
});
