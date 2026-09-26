import { describe, expect, test } from "bun:test";
import { fakeMouth, LIPSYNC, LipsyncEnvelope, mouthTarget, rmsOfBytes } from "./lipsync";
import { estimateSpeechMs, markTimes, revealCount, SegmentQueue, type Segment } from "./queue";
import { acceptWhileSpeaking, TurnCommitter, wordCount } from "./turn";

const seg = (utteranceId: string, seq: number, text = "hi"): Segment => ({ utteranceId, seq, text, marks: [] });

describe("lipsync envelope", () => {
  test("mouth = min(0.7, rms^0.7 * gain) with a noise gate", () => {
    expect(mouthTarget(0)).toBe(0);
    expect(mouthTarget(0.01)).toBe(0);
    expect(mouthTarget(0.03)).toBeCloseTo(Math.pow(0.03, 0.7) * LIPSYNC.gain);
    expect(mouthTarget(1)).toBe(0.7);
  });

  test("lerps toward the target over ~120ms", () => {
    const e = new LipsyncEnvelope();
    e.update(1, true, 16, 0);
    expect(e.value).toBeGreaterThan(0.1);
    expect(e.value).toBeLessThan(0.7);
    for (let t = 16; t <= 140; t += 16) e.update(1, true, 16, t);
    expect(e.value).toBeGreaterThan(0.66);
  });

  test("200ms release, then held at exactly 0 for 500ms", () => {
    const e = new LipsyncEnvelope();
    for (let t = 0; t < 300; t += 16) e.update(1, true, 16, t);
    e.update(0, false, 16, 1000);
    expect(e.value).toBeGreaterThan(0.6);
    expect(e.update(0, false, 16, 1100)).toBeCloseTo(e.value);
    expect(e.update(0, false, 16, 1100)).toBeLessThan(0.4);
    expect(e.update(0, false, 16, 1200)).toBe(0);
    expect(e.holding(1650)).toBe(true);
    expect(e.holding(1701)).toBe(false);
  });

  test("fake mouth stays in 0.15..0.7", () => {
    for (let t = 0; t < 5000; t += 7) {
      const m = fakeMouth(t);
      expect(m).toBeGreaterThanOrEqual(0.15 * 0.99);
      expect(m).toBeLessThanOrEqual(0.7);
    }
  });

  test("rms of silence is 0, of full swing is ~1", () => {
    expect(rmsOfBytes(new Uint8Array(64).fill(128))).toBe(0);
    const buf = new Uint8Array(64).map((_, i) => (i % 2 ? 255 : 0));
    expect(rmsOfBytes(buf)).toBeGreaterThan(0.99);
  });
});

describe("mark timing", () => {
  test("fires at char offset proportional to playback time, sorted", () => {
    const text = "0123456789";
    const out = markTimes(text, [{ at: 5, mood: "happy" }, { at: 0, mood: "smug" }, { at: 20, mood: "sad" }], 2000);
    expect(out.map((o) => o.t)).toEqual([0, 1000, 2000]);
    expect(out[0]!.mark.mood).toBe("smug");
  });

  test("estimate and reveal", () => {
    expect(estimateSpeechMs("")).toBe(600);
    expect(revealCount(10, 0)).toBe(0);
    expect(revealCount(10, 0.5)).toBe(6);
    expect(revealCount(10, 1)).toBe(10);
  });
});

describe("segment queue", () => {
  test("strict order within and across utterances", () => {
    const q = new SegmentQueue();
    q.begin("a");
    q.push(seg("a", 0));
    q.begin("b");
    q.push(seg("b", 0));
    q.push(seg("a", 1));
    expect(q.next(0)).toMatchObject({ utteranceId: "a", seq: 0 });
    expect(q.next(0)).toMatchObject({ utteranceId: "a", seq: 1 });
    expect(q.next(0)).toBeNull(); // a not ended yet: b must wait
    q.end("a");
    expect(q.next(0)).toMatchObject({ utteranceId: "b", seq: 0 });
    expect(q.finished("a")).toBe(true);
    expect(q.finished("b")).toBe(false);
  });

  test("out-of-order seqs are reordered", () => {
    const q = new SegmentQueue();
    q.push(seg("a", 0));
    q.push(seg("a", 2));
    q.push(seg("a", 1));
    expect([q.next(0)!.seq, q.next(0)!.seq, q.next(0)!.seq]).toEqual([0, 1, 2]);
  });

  test("a missing seq is skipped after the gap timeout or on end", () => {
    const q = new SegmentQueue(1500);
    q.push(seg("a", 0));
    q.next(0);
    q.push(seg("a", 2));
    expect(q.next(100)).toBeNull();
    expect(q.next(1000)).toBeNull();
    expect(q.next(1600)).toMatchObject({ seq: 2 });
    q.push(seg("b", 0));
    q.push(seg("b", 3));
    q.next(0);
    q.end("a");
    q.end("b");
    expect(q.next(0)).toMatchObject({ utteranceId: "b", seq: 0 });
    expect(q.next(0)).toMatchObject({ utteranceId: "b", seq: 3 });
  });

  test("abort drops everything and ignores late segments of dead utterances", () => {
    const q = new SegmentQueue();
    q.push(seg("a", 0));
    q.push(seg("a", 1));
    expect(q.abort()).toEqual(["a"]);
    expect(q.next(0)).toBeNull();
    q.push(seg("a", 2));
    expect(q.size).toBe(0);
    expect(q.finished("a")).toBe(true);
    q.push(seg("c", 0));
    expect(q.next(0)).toMatchObject({ utteranceId: "c" });
  });

  test("duplicate or stale seqs are dropped", () => {
    const q = new SegmentQueue();
    q.push(seg("a", 0));
    q.next(0);
    q.push(seg("a", 0));
    expect(q.next(0)).toBeNull();
  });
});

describe("turn commit", () => {
  test("commits after 650ms of unchanged interim", () => {
    const out: string[] = [];
    const c = new TurnCommitter((t) => out.push(t));
    c.interim("what about", 0);
    c.tick(600);
    c.interim("what about this", 600);
    c.tick(1200);
    expect(out).toEqual([]);
    c.tick(1250);
    expect(out).toEqual(["what about this"]);
    c.tick(3000);
    expect(out).toHaveLength(1);
  });

  test("engine finals and push-to-talk flush commit immediately", () => {
    const out: string[] = [];
    const c = new TurnCommitter((t) => out.push(t));
    c.final("thoughts?");
    c.interim("do it", 0);
    c.flush();
    expect(out).toEqual(["thoughts?", "do it"]);
  });

  test("same text is not committed twice in a row", () => {
    const out: string[] = [];
    const c = new TurnCommitter((t) => out.push(t));
    c.interim("yeah", 0);
    c.tick(700);
    c.final("yeah");
    expect(out).toEqual(["yeah"]);
  });

  test("half duplex: ignore short speech while she talks, 3+ words barge in", () => {
    expect(wordCount("  hey  there ")).toBe(2);
    expect(acceptWhileSpeaking("yeah", false, 5000)).toBe("accept");
    expect(acceptWhileSpeaking("yeah", true, 0)).toBe("ignore");
    expect(acceptWhileSpeaking("yeah ok", false, 200)).toBe("ignore");
    expect(acceptWhileSpeaking("wait stop that", true, 0)).toBe("barge-in");
  });
});
