import { expect, test } from "bun:test";
import { DEFAULT_RELATIONSHIP, emptyWorld, type WorldSnapshot } from "@eigenwife/protocol";
import { goalFrom, readIntent } from "../src/reflex/intent";
import { createJev, jevQuestions, jevState, localScore, parseJevResponse, type JevInput } from "../src/reflex/jev";
import type { Trigger } from "../src/reflex/rules";

const NOW = 1_750_000_000_000;

function born(): WorldSnapshot {
  const w = emptyWorld();
  return { ...w, scene: "desktop", companion: { ...w.companion, born: true, state: "idle" } };
}

function trig(rule: string, data: Record<string, unknown> = {}, over: Partial<Trigger> = {}): Trigger {
  return { id: `${rule}#1`, rule, description: rule, urgency: "soon", data, at: NOW, ambient: rule !== "utterance" && rule !== "companion_born", ...over };
}

function input(t: Trigger, over: Partial<JevInput> = {}): JevInput {
  return { trigger: t, world: born(), relationship: { ...DEFAULT_RELATIONSHIP }, now: NOW, ...over };
}

// Mid-conversation by default (she answered 5s ago): the addressing gate has its own tests below.
const say = (text: string, over: Partial<JevInput> = {}) =>
  localScore(input(trig("utterance", { text }, { urgency: "immediate" }), { lastReactionAt: NOW - 5000, ...over }));

test("addressing gate: the mic hears the room, she only answers when it's for her", () => {
  const cold = { lastReactionAt: NOW - 120_000 };
  // friends talking in the room: ignored
  expect(say("hella beef", cold).decision).toBe("IGNORE");
  expect(say("why are they so serious bro", cold).decision).toBe("IGNORE");
  expect(say("hella beef", cold).reason).toBe("not talking to her");
  // her name, things she does, deictic questions, mid-conversation: answered
  expect(say("eve why are they so serious", cold).decision).not.toBe("IGNORE");
  expect(say("yo babe you up", cold).decision).not.toBe("IGNORE");
  expect(say("put your pajamas on", cold).decision).toBe("ACT");
  expect(say("let's listen to music", cold).decision).toBe("ACT");
  expect(say("thoughts?", cold).decision).not.toBe("IGNORE");
  expect(say("wait", cold).stopSpeech).toBe(true);
  expect(say("hella beef").decision).not.toBe("IGNORE");
  // opt out
  process.env.EVE_ADDRESS_MODE = "always";
  expect(say("hella beef", cold).decision).not.toBe("IGNORE");
  delete process.env.EVE_ADDRESS_MODE;
});

test("intent reader", () => {
  expect(readIntent("wait").stop).toBe(true);
  expect(readIntent("nvm").stop).toBe(true);
  expect(readIntent("stop.").stop).toBe(true);
  expect(readIntent("wait, what about the other one?").stop).toBe(true);
  expect(readIntent("i can't wait to eat").stop).toBe(false);
  expect(readIntent("can you figure out dinner tonight").task).toBe(true);
  expect(readIntent("book us a table at 8").task).toBe(true);
  expect(readIntent("I have no idea what I'm doing tonight").task).toBe(true);
  expect(readIntent("thoughts?").deictic).toBe(true);
  expect(readIntent("thoughts?").question).toBe(true);
  expect(readIntent("is this one too spicy").deictic).toBe(true);
  expect(readIntent("close spotify")?.command?.app).toBe("spotify");
  expect(readIntent("close the dating app")?.command?.app).toBe("Eigen");
  expect(readIntent("lmao").laugh).toBe(true);
  expect(goalFrom("can you figure out dinner for tonight?")).toBe("Figure out dinner for tonight");
});

test("utterances: stop -> IGNORE + stop speech, never otherwise ignored", () => {
  const s = say("wait");
  expect(s.decision).toBe("IGNORE");
  expect(s.stopSpeech).toBe(true);
  expect(say("figure out dinner for tonight").decision).toBe("ESCALATE");
  expect(say("plan my saturday").decision).toBe("ESCALATE");
  expect(say("thoughts?").decision).toBe("REACT");
  expect(say("how do i center a div").decision).toBe("HELP");
  expect(say("close spotify").decision).toBe("ACT");
  expect(say("i had a rough day").decision).toBe("COMMENT");
  expect(say("lol").decision).toBe("REACT");
  expect(say("i like this place").decision).not.toBe("IGNORE");
  expect(say("hmm").decision).not.toBe("IGNORE");
  // a bare "yeah" while an approval is pending belongs to agency
  expect(say("yeah", { pendingApproval: true }).decision).toBe("IGNORE");
  expect(say("yeah").decision).not.toBe("IGNORE");
});

test("spec examples: Spotify opened is ignored ~0.9, breakup song x4 is a COMMENT", () => {
  const spotify = localScore(input(trig("app_opened", { app: "Spotify" }, { urgency: "later" })));
  expect(spotify.decision).toBe("IGNORE");
  expect(spotify.scores.IGNORE).toBeGreaterThan(0.85);
  const x4 = localScore(input(trig("repeat_media", { track: "Someone Like You", count: 4 })));
  expect(x4.decision).toBe("COMMENT");
  const relapse = localScore(input(trig("relapse", { app: "Eigen" }, { urgency: "immediate" })));
  expect(relapse.decision).toBe("ACT");
  const first = localScore(input(trig("companion_born", {}, { urgency: "immediate" })));
  expect(first.decision).toBe("COMMENT");
});

test("don't chatter: a fresh line of hers suppresses ambient reactions", () => {
  const t = trig("repeat_media", { track: "x", count: 4 });
  const w = born();
  w.companion.lastSpokeAt = NOW - 5_000;
  expect(localScore(input(t, { world: w })).decision).toBe("IGNORE");
  expect(localScore(input(t, { lastReactionAt: NOW - 10_000 })).decision).toBe("IGNORE");
});

test("initiative scales how chatty she is", () => {
  const t = trig("face_return", { awayMs: 180_000 });
  const shy = localScore(input(t, { relationship: { ...DEFAULT_RELATIONSHIP, initiative: 0.1 } }));
  const bold = localScore(input(t, { relationship: { ...DEFAULT_RELATIONSHIP, initiative: 0.95 } }));
  expect(shy.decision).toBe("IGNORE");
  expect(bold.decision).not.toBe("IGNORE");
  expect(bold.scores.IGNORE).toBeLessThan(shy.scores.IGNORE);
});

test("nothing ambient before she is born; own escalations are not re-reported", () => {
  expect(localScore(input(trig("repeat_media", { count: 9 }), { world: emptyWorld() })).decision).toBe("IGNORE");
  expect(localScore(input(trig("task_done", { ok: true }), { ownTask: true })).decision).toBe("IGNORE");
  expect(localScore(input(trig("task_done", { ok: true }))).decision).toBe("REACT");
});

test("scores are a distribution", () => {
  const r = say("thoughts?");
  const sum = Object.values(r.scores).reduce((a, b) => a + b, 0);
  expect(Math.abs(sum - 1)).toBeLessThan(0.01);
});

// --- TypeSafe adapter --------------------------------------------------------

const ok = (choice: string, probs: Record<string, number>) =>
  new Response(JSON.stringify({ model: "jev-1.13.0", answers: { decision: { type: "choice", choice, probabilities: probs, confidence: 0.8 } } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

test("parse systemone response", () => {
  const r = parseJevResponse({ model: "jev-1.13.0", answers: { decision: { choice: "COMMENT", probabilities: { COMMENT: 0.78, IGNORE: 0.2, REACT: 0.02 } } } });
  expect(r.decision).toBe("COMMENT");
  expect(r.scores.COMMENT).toBe(0.78);
  expect(r.scores.ESCALATE).toBe(0);
  expect(() => parseJevResponse({ answers: {} })).toThrow();
  expect(() => parseJevResponse({ answers: { decision: { choice: "DANCE" } } })).toThrow();
});

test("request shape: typed choice question over all 8 decisions", () => {
  const q = jevQuestions();
  expect(q.decision.type).toBe("choice");
  expect(Object.keys(q.decision.criteria)).toHaveLength(8);
  const s = jevState(input(trig("stare", { label: "ramen" })));
  expect(s.kind).toBe("stare");
  expect(s.policy).toContain("80-95%");
});

test("jev adapter: remote verdict wins, by=jev, request carries key and model", async () => {
  let sent: { url: string; init: RequestInit } | null = null;
  const jev = createJev({
    apiKey: "k_test",
    fetchImpl: (async (url: string, init: RequestInit) => {
      sent = { url, init };
      return ok("GLANCE", { GLANCE: 0.55, IGNORE: 0.4, COMMENT: 0.05 });
    }) as unknown as typeof fetch,
  });
  const v = await jev.decide(input(trig("stare", { kind: "menu-item", ms: 5000 })));
  expect(v.by).toBe("jev");
  expect(v.decision).toBe("GLANCE");
  expect(v.scores.GLANCE).toBe(0.55);
  expect(sent!.url).toBe("https://api.typesafe.ai/v1/systemone");
  expect((sent!.init.headers as Record<string, string>).Authorization).toBe("Bearer k_test");
  const body = JSON.parse(String(sent!.init.body));
  expect(body.model).toBe("jev-latest");
  expect(body.questions.decision.type).toBe("choice");
});

test("jev adapter: 400ms timeout falls back to local", async () => {
  const jev = createJev({
    apiKey: "k",
    fetchImpl: ((_u: string, init: RequestInit) =>
      new Promise((res, rej) => {
        const t = setTimeout(() => res(ok("COMMENT", { COMMENT: 1 })), 2000);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          rej(new Error("aborted"));
        });
      })) as unknown as typeof fetch,
  });
  const t0 = performance.now();
  const v = await jev.decide(input(trig("app_opened", { app: "Spotify" })));
  const ms = performance.now() - t0;
  expect(v.by).toBe("local");
  expect(v.decision).toBe("IGNORE");
  expect(v.reason).toContain("timeout");
  expect(ms).toBeLessThan(700);
  expect(ms).toBeGreaterThanOrEqual(390);
});

test("jev adapter: http errors fall back, breaker opens after 3 failures", async () => {
  let calls = 0;
  let t = 0;
  const jev = createJev({
    apiKey: "k",
    now: () => t,
    fetchImpl: (async () => {
      calls++;
      return new Response("overloaded", { status: 529 });
    }) as unknown as typeof fetch,
  });
  for (let i = 0; i < 3; i++) expect((await jev.decide(input(trig("app_opened", { app: "x" })))).by).toBe("local");
  expect(calls).toBe(3);
  const v = await jev.decide(input(trig("app_opened", { app: "x" })));
  expect(v.reason).toContain("breaker");
  expect(calls).toBe(3);
  t += 31_000;
  await jev.decide(input(trig("app_opened", { app: "x" })));
  expect(calls).toBe(4);
  expect(jev.status().lastError).toContain("529");
});

test("jev adapter: guardrails (stop words skip the network, utterances never ignored, local pin)", async () => {
  let calls = 0;
  const jev = createJev({
    apiKey: "k",
    fetchImpl: (async () => {
      calls++;
      return ok("IGNORE", { IGNORE: 0.9, REACT: 0.1 });
    }) as unknown as typeof fetch,
  });
  const stop = await jev.decide(input(trig("utterance", { text: "wait" }, { urgency: "immediate" })));
  expect(stop.decision).toBe("IGNORE");
  expect(stop.stopSpeech).toBe(true);
  expect(calls).toBe(0);
  const q = await jev.decide(input(trig("utterance", { text: "what do you think of it" }, { urgency: "immediate" }), { lastReactionAt: NOW - 5000 }));
  expect(q.decision).not.toBe("IGNORE");
  expect(q.by).toBe("jev");
  const task = await jev.decide(input(trig("utterance", { text: "figure out dinner for tonight" }, { urgency: "immediate" })));
  expect(task.decision).toBe("ESCALATE");
  expect(task.reason).toContain("pin");
});

test("no key: local only, never touches fetch", async () => {
  const jev = createJev({ fetchImpl: (() => { throw new Error("no"); }) as unknown as typeof fetch });
  const v = await jev.decide(input(trig("utterance", { text: "thoughts?" }, { urgency: "immediate" })));
  expect(v.by).toBe("local");
  expect(v.latencyMs).toBeLessThan(50);
  expect(jev.status().remote).toBe(false);
});
