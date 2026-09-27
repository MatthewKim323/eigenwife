import { expect, test } from "bun:test";
import { Conversation } from "../src/brains/conversation";
import { buildPersonaPrompt, DEFAULT_EVE } from "../src/brains/prompt";
import { createJev } from "../src/reflex/jev";
import { reflexModule } from "../src/reflex/module";
import { fakeContext, FakeSpeech, FakeClock, settle, startModules } from "../src/reflex/testing";

test("conversation: recent turns verbatim, marks stripped, her pieces merged", () => {
  let t = 0;
  const c = new Conversation({ now: () => t });
  c.add("user", "what should we eat");
  t += 1000;
  c.add("eve", "[mood:happy 0.6] cheap ramen.");
  t += 2000;
  c.add("eve", "you're saving money.");
  c.add("user", "no the other one");
  expect(c.turns.map((x) => x.text)).toEqual(["what should we eat", "cheap ramen. you're saving money.", "no the other one"]);
  const b = c.block("Alexia");
  expect(b).toContain("him: what should we eat");
  expect(b).toContain("Alexia: cheap ramen. you're saving money.");
});

test("conversation: old turns fold into a summary only after the summary comes back", async () => {
  const c = new Conversation({ recent: 4, foldAt: 6 });
  for (let i = 0; i < 8; i++) c.add(i % 2 ? "eve" : "user", `line ${i}`);
  expect(await c.fold(async () => null)).toBe(false);
  expect(c.turns.length).toBe(8); // nothing lost on a failed summary
  expect(await c.fold(async (_prev, turns) => `talked about ${turns.length} things`)).toBe(true);
  expect(c.summary).toBe("talked about 4 things");
  expect(c.turns.map((x) => x.text)).toEqual(["line 4", "line 5", "line 6", "line 7"]);
  expect(c.block()).toContain("earlier in this conversation: talked about 4 things");
  const round = new Conversation();
  round.load(JSON.parse(JSON.stringify(c.toJSON())));
  expect(round.block()).toBe(c.block());
});

test("every persona prompt carries the conversation", () => {
  const m = buildPersonaPrompt({ persona: DEFAULT_EVE, world: "- scene: desktop", req: { event: "x", behavior: "answer", userText: "and the other one?" }, conversation: "recent conversation (oldest first):\nhim: find me ramen" });
  expect(m.system).toContain("[this conversation]");
  expect(m.system).toContain("him: find me ramen");
});

async function rig(turnMs: number) {
  const clock = new FakeClock(Date.now());
  const ctx = fakeContext();
  ctx.config.demo = false;
  const speech = new FakeSpeech(ctx, clock);
  ctx.provide("speech", speech);
  const turns: string[] = [];
  ctx.bus.on("voice.turn", (e) => turns.push(e.data.text));
  await startModules(ctx, [reflexModule({ now: clock.now, jev: createJev({}), turnMs })]);
  return { ctx, turns, speech };
}

test("talk, pause, keep talking: pieces merge into one turn", async () => {
  const r = await rig(40);
  r.ctx.bus.emit("voice.final", { text: "yo so for dinner" });
  await Bun.sleep(15);
  r.ctx.bus.emit("voice.final", { text: "somewhere cheap" });
  await Bun.sleep(80);
  expect(r.turns).toEqual(["yo so for dinner somewhere cheap"]);
});

test("stop words never wait", async () => {
  const r = await rig(500);
  r.ctx.bus.emit("voice.final", { text: "wait" });
  await settle(5);
  expect(r.turns).toEqual(["wait"]);
});
