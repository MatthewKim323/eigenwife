import { describe, expect, test } from "bun:test";
import { MarkCursor, SegmentQueue, type Segment } from "./queue";
import { bestVoice, rankVoice, SynthMouth, wordLengthAt } from "./synth";

const seg = (utteranceId: string, seq: number, text = "hi"): Segment => ({ utteranceId, seq, text, marks: [] });

describe("segment queue: arrival order", () => {
  test("seq 1 arriving before seq 0 still plays 0 then 1", () => {
    const q = new SegmentQueue();
    q.push(seg("u", 1));
    expect(q.next(0)).toBeNull();
    q.push(seg("u", 0));
    expect(q.next(10)).toMatchObject({ seq: 0 });
    expect(q.next(10)).toMatchObject({ seq: 1 });
  });

  test("an utterance that starts at seq 1 only waits ~400ms", () => {
    const q = new SegmentQueue(1500, 400);
    q.push(seg("u", 1));
    expect(q.next(0)).toBeNull();
    expect(q.next(399)).toBeNull();
    expect(q.next(401)).toMatchObject({ seq: 1 });
  });
});

describe("mark cursor (speechSynthesis boundaries)", () => {
  test("fires each mark once as charIndex advances, rest at the end", () => {
    const c = new MarkCursor([{ at: 10, mood: "smug" }, { at: 0, mood: "happy" }, { at: 30, mood: "sad" }]);
    expect(c.advance(0).map((m) => m.mood)).toEqual(["happy"]);
    expect(c.advance(5)).toEqual([]);
    expect(c.advance(12).map((m) => m.mood)).toEqual(["smug"]);
    expect(c.advance(12)).toEqual([]);
    const sad = c.pending()[0]!;
    expect(c.take(sad)).toBe(true);
    expect(c.take(sad)).toBe(false);
    expect(c.rest()).toEqual([]);
  });
});

describe("speechSynthesis voice + fake mouth", () => {
  const v = (name: string, lang = "en-US") => ({ name, lang });

  test("prefers soft female english voices, premium first, never novelty", () => {
    expect(bestVoice([v("Albert"), v("Fred"), v("Samantha"), v("Daniel", "en-GB")])!.name).toBe("Samantha");
    expect(bestVoice([v("Samantha"), v("Ava (Premium)")])!.name).toBe("Ava (Premium)");
    expect(bestVoice([v("Google US English"), v("Google Deutsch", "de-DE")])!.name).toBe("Google US English");
    expect(bestVoice([v("Zarvox"), v("Thomas", "fr-FR")])).toBeNull();
    expect(rankVoice(v("Bad News"))).toBe(-1);
  });

  test("mouth is closed when not speaking, pulses on words, capped at 0.7", () => {
    const m = new SynthMouth();
    expect(m.value(0)).toBe(0);
    m.start(0);
    m.word(0, 5);
    let max = 0;
    for (let t = 0; t < 300; t += 5) max = Math.max(max, m.value(t));
    expect(max).toBeGreaterThan(0.4);
    expect(max).toBeLessThanOrEqual(0.7);
    const late = Math.max(...Array.from({ length: 40 }, (_, i) => m.value(900 + i * 5)));
    expect(late).toBeLessThan(0.25);
    m.end();
    expect(m.value(1000)).toBe(0);
  });

  test("voices without boundaries still chatter", () => {
    const m = new SynthMouth();
    m.start(0);
    const vals = Array.from({ length: 200 }, (_, i) => m.value(i * 10));
    expect(Math.max(...vals)).toBeGreaterThan(0.35);
    expect(Math.min(...vals)).toBeLessThan(0.3);
  });

  test("word length from char index", () => {
    expect(wordLengthAt("hey there you", 4)).toBe(5);
    expect(wordLengthAt("hey", 10)).toBe(1);
  });
});
