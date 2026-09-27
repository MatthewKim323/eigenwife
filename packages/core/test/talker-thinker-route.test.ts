import { expect, test } from "bun:test";
import { isNonAnswer, thinkerEngines } from "../src/talker/router";

test("thinker engine choice: his life to jabby first, the world to claude + web first", () => {
  expect(thinkerEngines("what's the weather in irvine right now")[0]).toBe("claude");
  expect(thinkerEngines("who won the lakers game")[0]).toBe("claude");
  expect(thinkerEngines("what's due for my classes this week")[0]).toBe("jabby");
  expect(thinkerEngines("did i get any email from leo")[0]).toBe("jabby");
  expect(thinkerEngines("what did i tell you last week about tavi")[0]).toBe("jabby");
});

test("non-answers are never spoken; real answers pass", () => {
  expect(isNonAnswer("No weather tool available in this session, can't pull a live reading for Irvine right now.")).toBe(true);
  expect(isNonAnswer("I don't have real-time data for that.")).toBe(true);
  expect(isNonAnswer("It's 72°F and sunny in Irvine, light breeze.")).toBe(false);
});

test("terminal phrasing: 'open terminal and run X' runs X", async () => {
  const { readWorkIntent } = await import("../src/work/intent");
  expect(readWorkIntent("open terminal and run git log")).toMatchObject({ kind: "shell.run", command: "git log" });
});
