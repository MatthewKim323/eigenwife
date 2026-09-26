import { describe, expect, test } from "bun:test";
import type { SpeechMark } from "@eigenwife/protocol";
import { MarkSplitter, parseMark, splitMarks } from "../src/speech/marks";
import { SegmentStream, SentenceChunker, segmentText } from "../src/speech/chunker";
import { LINES, scriptedTexts } from "../src/speech/lines";

/** Feed chunks through a splitter and collect everything it released. */
function stream(chunks: string[]) {
  const sp = new MarkSplitter();
  let text = "";
  const marks: SpeechMark[] = [];
  const releases: string[] = [];
  for (const c of chunks) {
    const r = sp.push(c);
    releases.push(r.text);
    text += r.text;
    marks.push(...r.marks);
  }
  const f = sp.flush();
  releases.push(f.text);
  text += f.text;
  marks.push(...f.marks);
  return { text, marks, releases };
}

describe("mark splitter", () => {
  test("extracts mood and pause marks with offsets, never speaks them", () => {
    const r = splitMarks("[mood:annoyed 0.7] twenty-one dollars. [pause:0.6] for ramen?");
    expect(r.text).toBe("twenty-one dollars. for ramen?");
    expect(r.marks).toEqual([
      { at: 0, mood: "annoyed", intensity: 0.7 },
      { at: 20, pauseS: 0.6 },
    ]);
    expect(r.text.slice(r.marks[1]!.at)).toBe("for ramen?");
  });

  test("a mark split across chunks is held back, then extracted", () => {
    const r = stream(["so. [mo", "od:smu", "g 0.6] apparently", " this is [pau", "se:0.3] your type."]);
    expect(r.text).toBe("so. apparently this is your type.");
    expect(r.releases.join("|")).not.toContain("[");
    expect(r.marks).toEqual([
      { at: 4, mood: "smug", intensity: 0.6 },
      { at: 23, pauseS: 0.3 },
    ]);
  });

  test("every possible split point of a line gives the same result", () => {
    const line = "[mood:happy 0.7] seven thirty. [pause:0.3] done.";
    const want = splitMarks(line);
    for (let i = 1; i < line.length; i++) {
      const r = stream([line.slice(0, i), line.slice(i)]);
      expect(r.text).toBe(want.text);
      expect(r.marks).toEqual(want.marks);
    }
    const chars = stream(line.split(""));
    expect(chars.text).toBe(want.text);
    expect(chars.marks).toEqual(want.marks);
  });

  test("unknown marks and audio tags are dropped, not spoken", () => {
    expect(splitMarks("[laughs] okay. [gesture:wave] hi. [voice:whisper 1] there.").text).toBe("okay. hi. there.");
    expect(splitMarks("[mood:ecstatic 0.9] wow.").marks).toEqual([]);
  });

  test("brackets in normal text are kept", () => {
    expect(splitMarks("see note [1] and [sic] ok").text).toBe("see note [1] and [sic] ok");
    expect(splitMarks("a [b [mood:happy] c").text).toBe("a [b c");
  });

  test("an unclosed bracket that runs long is text; an unfinished mark at the end is dropped", () => {
    const long = "this [is not a mark at all, just a very long aside that keeps going";
    expect(stream([long]).text).toBe(long);
    expect(stream(["okay. [mood:hap"]).text).toBe("okay. ");
    expect(stream(["okay [ then"]).text).toBe("okay [ then");
  });

  test("tolerant mood syntax, synonyms, defaults, clamps", () => {
    expect(parseMark("mood: Annoyed, 0.8")).toEqual({ mood: "annoyed", intensity: 0.8 });
    expect(parseMark("mood:angry")).toEqual({ mood: "annoyed", intensity: 0.7 });
    expect(parseMark("mood:happy 7")).toEqual({ mood: "happy", intensity: 1 });
    expect(parseMark("pause:9")).toEqual({ pauseS: 3 });
    expect(parseMark("pause")).toEqual({ pauseS: 0.4 });
    expect(parseMark("smug")).toEqual({ mood: "smug", intensity: 0.7 });
    expect(parseMark("1")).toBeNull();
    expect(parseMark("laughs")).toBe("drop");
  });

  test("whitespace left by removed marks collapses, across chunks too", () => {
    expect(splitMarks("hi [pause:0.2]  there").text).toBe("hi there");
    expect(stream(["hi ", "[pause:0.2]", " there"]).text).toBe("hi there");
    expect(stream(["  [mood:sad 0.3]  ", "okay."]).text).toBe("okay.");
    expect(splitMarks("line one\nline two").text).toBe("line one line two");
  });
});

function chunk(s: string) {
  const c = new SentenceChunker();
  return [...c.push(s), ...c.flush()].map((x) => x.text);
}

describe("sentence chunker", () => {
  test("splits on . ! ? ;", () => {
    expect(chunk("seven thirty. cheap ramen! you free? good; done")).toEqual(["seven thirty.", "cheap ramen!", "you free?", "good;", "done"]);
  });
  test("punctuation runs and decimals", () => {
    expect(chunk("wait... what?! it's $21.50. fine")).toEqual(["wait...", "what?!", "it's $21.50.", "fine"]);
    expect(chunk("...seriously?")).toEqual(["...seriously?"]);
  });
  test("first two chunks also split on a comma once >= 4 words", () => {
    expect(chunk("okay so, the thing is, i think you should, maybe not, do that.")).toEqual(["okay so, the thing is,", "i think you should,", "maybe not, do that."]);
    expect(chunk("no, no, no.")).toEqual(["no, no, no."]);
  });
  test("hard cap at 12 words", () => {
    const out = chunk("one two three four five six seven eight nine ten eleven twelve thirteen fourteen");
    expect(out).toEqual(["one two three four five six seven eight nine ten eleven twelve", "thirteen fourteen"]);
  });
  test("waits for the space after a period while streaming", () => {
    const c = new SentenceChunker();
    expect(c.push("it's $21.").map((s) => s.text)).toEqual([]);
    expect(c.push("50 total. and").map((s) => s.text)).toEqual(["it's $21.50 total."]);
    expect(c.flush().map((s) => s.text)).toEqual(["and"]);
  });
  test("marks land in their segment with rebased offsets", () => {
    const segs = segmentText("[mood:smug 0.6] so. apparently [mood:happy 0.4] this is your type. [pause:0.3] done.");
    expect(segs).toEqual([
      { text: "so.", marks: [{ at: 0, mood: "smug", intensity: 0.6 }] },
      { text: "apparently this is your type.", marks: [{ at: 11, mood: "happy", intensity: 0.4 }] },
      { text: "done.", marks: [{ at: 0, pauseS: 0.3 }] },
    ]);
    expect(segs[1]!.text.slice(11)).toBe("this is your type.");
  });
  test("mark-only and punctuation-only pieces carry their marks forward", () => {
    expect(segmentText("[mood:annoyed 0.8] ... [pause:0.4] really?")).toEqual([{ text: "... really?", marks: [{ at: 0, mood: "annoyed", intensity: 0.8 }, { at: 4, pauseS: 0.4 }] }]);
    expect(segmentText("hm. [mood:happy 0.5]")).toEqual([{ text: "hm.", marks: [{ at: 3, mood: "happy", intensity: 0.5 }] }]);
    expect(segmentText("[mood:happy 0.5]")).toEqual([]);
  });
  test("token-by-token streaming gives the same segments as one shot", () => {
    const line = "[mood:annoyed 0.6] twenty-one dollars. [pause:0.3] for ramen? honestly, i've seen you eat, for less than half of that, like last week.";
    const ss = new SegmentStream();
    const out = [];
    for (const tok of line.match(/.{1,3}/gs)!) out.push(...ss.push(tok));
    out.push(...ss.flush());
    expect(out).toEqual(segmentText(line));
  });
  test("every scripted line segments to speakable text without brackets", () => {
    for (const l of scriptedTexts()) {
      const segs = segmentText(l);
      expect(segs.length).toBeGreaterThan(0);
      for (const s of segs) {
        expect(s.text).not.toContain("[");
        expect(s.text).not.toMatch(/[—–]/);
      }
    }
    expect(segmentText(LINES.done).map((s) => s.text)).toEqual(["seven thirty.", "cheap ramen.", "you're free.", "done."]);
  });
});
