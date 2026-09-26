import { describe, expect, test } from "bun:test";
import { extractJson, guardSpoken, isErrorText, LeakError, sanitizeChunk, stripSpeakerLabel, wordCount } from "../src/brains/text";
import { collect } from "./brains.fakes";

async function* gen(parts: string[]) {
  for (const p of parts) yield p;
}

describe("extractJson", () => {
  test("whole text", () => expect(extractJson('{"a":1}')).toEqual({ a: 1 }));
  test("fenced block", () => expect(extractJson('here you go:\n```json\n{"steps":["a","b"]}\n```\nenjoy')).toEqual({ steps: ["a", "b"] }));
  test("first balanced object in prose", () => expect(extractJson('sure. {"x": {"y": [1, 2]}} and then {"z": 3}')).toEqual({ x: { y: [1, 2] } }));
  test("braces inside strings don't break balancing", () => expect(extractJson('ok {"s": "a } b { c", "n": 2} done')).toEqual({ s: "a } b { c", n: 2 }));
  test("skips a broken candidate and finds the next", () => expect(extractJson('{nope} then {"ok": true}')).toEqual({ ok: true }));
  test("arrays when no object", () => expect(extractJson("list: [1,2,3]")).toEqual([1, 2, 3]));
  test("nothing parseable", () => {
    expect(extractJson("no json here")).toBeUndefined();
    expect(extractJson("")).toBeUndefined();
    expect(extractJson('{"unterminated": ')).toBeUndefined();
  });
  test("bare scalars are not objects", () => expect(extractJson("42")).toBeUndefined());
});

describe("error text", () => {
  test("catches jabby's patterns and billing errors", () => {
    for (const s of [
      "API Error: 529 overloaded",
      "You've hit your limit · resets 5pm",
      "Claude AI usage limit reached",
      "You have no credits remaining. Add credits",
      "insufficient_quota",
      "Invalid API key · Please run /login",
      "Rate limit exceeded, try again in 20s",
    ])
      expect(isErrorText(s)).toBe(true);
  });
  test("lets normal speech through", () => {
    for (const s of ["slow down, cowboy.", "twenty-one dollars. for ramen?", "the api is fine, you're the problem.", "limits are for other people."])
      expect(isErrorText(s)).toBe(false);
  });
});

describe("sanitize", () => {
  test("em and en dashes, emoji, markdown, quotes", () => {
    expect(sanitizeChunk("wait—what")).toBe("wait, what");
    expect(sanitizeChunk("5–6 pm")).toBe("5-6 pm");
    expect(sanitizeChunk("nice \u{1F35C}\u{1F525}")).toBe("nice ");
    expect(sanitizeChunk("*really* **now**")).toBe("really now");
    expect(sanitizeChunk('"so. apparently"')).toBe("so. apparently");
  });
  test("keeps marks and normal punctuation", () => expect(sanitizeChunk("[mood:smug 0.6] so. $21?")).toBe("[mood:smug 0.6] so. $21?"));
  test("speaker labels", () => {
    expect(stripSpeakerLabel("Eve: hi")).toBe("hi");
    expect(stripSpeakerLabel("  eve : hi")).toBe("hi");
    expect(stripSpeakerLabel("Mina: hi", ["Mina"])).toBe("hi");
    expect(stripSpeakerLabel("everyone: hi")).toBe("everyone: hi");
  });
  test("word count ignores marks", () => expect(wordCount("[mood:happy 0.7] seven thirty. [pause:0.3] done.")).toBe(3));
});

describe("guardSpoken", () => {
  test("passes a normal stream through, sanitized", async () => {
    const out = await collect(guardSpoken(gen(["Eve: [mood:smug 0.6] so", ". apparently—", " this is your type."])));
    expect(out.join("")).toBe("[mood:smug 0.6] so. apparently,  this is your type.");
  });
  test("error text at the head throws LeakError and speaks nothing", async () => {
    const spoken: string[] = [];
    let err: unknown;
    try {
      for await (const c of guardSpoken(gen(["API Error: ", "Repeated 529 Overloaded errors"]))) spoken.push(c);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LeakError);
    expect(spoken).toEqual([]);
  });
  test("short error text that ends the stream is caught too", async () => {
    await expect(collect(guardSpoken(gen(["usage limit"])))).rejects.toBeInstanceOf(LeakError);
  });
  test("late error chatter cuts the stream instead of being spoken", async () => {
    const out = await collect(guardSpoken(gen(["fine. i'll pick the place myself.", " honestly", " API Error: overloaded", " more"])));
    expect(out.join("")).toBe("fine. i'll pick the place myself. honestly");
  });
  test("empty stream yields nothing", async () => expect(await collect(guardSpoken(gen(["", "  "])))).toEqual([]));
});
