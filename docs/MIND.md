# Mind: reflex (Jev) + relationship

Knowing when not to talk is part of the intelligence. The mind is the layer between Eve's senses and her mouth:

```
bus events ──► perception rules ──► triggers ──► urgency queue ──► Jev ──► router
 (gaze, voice,   reflex/rules.ts     {id, rule,    drained on        reflex/jev.ts   reflex/module.ts
  apps, media,                        urgency,     timer.tick;       IGNORE ...      glance / say / act /
  ticks, tasks)                       data}        immediate jumps   ESCALATE        escalate + report
```

| File | What |
|---|---|
| `packages/core/src/reflex/rules.ts` | declarative perception rules + `PerceptionEngine` (windows, cooldowns, stare, presence, silence) |
| `packages/core/src/reflex/intent.ts` | keyword read of an utterance (stop, task, command, question, deictic, laugh, down, approval) |
| `packages/core/src/reflex/jev.ts` | Jev: TypeSafe systemone adapter + transparent local scorer, guardrails, breaker |
| `packages/core/src/reflex/module.ts` | router, provides the `reflex` service, `GET /api/reflex` |
| `packages/core/src/reflex/testing.ts` | fake speech/brains/memory/agency/home + fake clock (no network) |
| `packages/core/src/mind/relationship.ts` | pure relationship math: nudges, decay, signals, persona seeding |
| `packages/core/src/mind/module.ts` | relationship module, provides `relationship`, `GET /api/relationship` |

## Perception rules

The engine's clock is the event `ts`, so replaying a recorded or simulated stream is deterministic.

| Rule | Listens to | Fires when | Urgency | Cooldown | Ambient |
|---|---|---|---|---|---|
| `utterance` | `voice.final` | any non-empty text | immediate | none | no |
| `companion_born` | `companion.born` | always: her first words | immediate | none | no |
| `relapse` | `app.opened`, `shell.scene` | app matches Eigen/dating, or scene becomes `dating`, **after** `companion.born` | immediate | 20s | yes |
| `repeat_media` | `media.play` | same track (case-insensitive) 3+ times inside 30 min | soon | 60s per track | yes |
| `stare` | `gaze.target` | same content target (menu item, restaurant, profile, other) continuously for 4s+, nobody spoke for 6s, she isn't speaking; once per stare | soon | 45s | yes |
| `long_silence` | `timer.tick` | no `voice.*` for 3 min while a face is present, after birth | later | 10 min | yes |
| `task_done` | `task.done` | always | soon | none | yes |
| `face_return` | `eye.status`, `gaze.target` | face back after 2+ min away; once per return | soon | 60s | yes |
| `app_opened` | `app.opened` | any non-dating app | later | 5s | yes |

"Stare" continuity: a `gaze.target` on a different key, a `gaze.fixation` on a different key, a `gaze.lost`, or a gap of more than 6s between announcements breaks it. Face presence comes from `eye.status.facePresent` or a gaze target in the last 10s.

### Adding a rule

Append a `Rule` to `DEFAULT_RULES` (or pass `reflexModule({ rules })`):

```ts
{
  id: "late_night_doomscroll",
  doc: "Twitter focused 5x in 10 min after midnight.",
  on: "app.focused",
  urgency: "later",
  where: { app: /twitter|^x$/i },            // shallow payload match, RegExp allowed
  window: { count: 5, withinMs: 10 * MIN },   // sliding window; add key: (e) => ... for "$same" grouping
  after: "companion.born",                    // only once this event type has been seen
  when: (_e, rc) => new Date(rc.now).getHours() < 4,   // escape hatch; rc has silenceMs(), stare(), facePresent(), lastFired() ...
  cooldownMs: 30 * MIN,
  describe: (e, _rc, n) => `user opened ${e.data.app} ${n} times in 10 minutes after midnight`,
  data: (e, _rc, n) => ({ app: e.data.app, count: n }),
}
```

Then give it salience in `ambientSalience()` in `jev.ts` (unknown rules get a default that is ignored ~90% of the time) and, if she should speak about it with a specific tone, a case in `behaviorFor()` in `module.ts`. Other modules can also raise triggers at runtime: `ctx.use("reflex").trigger({ id, description, urgency, data, parent })`.

## Decision policy (Jev)

`IGNORE | GLANCE | REACT | COMMENT | ASK | HELP | ACT | ESCALATE`. Every decision emits `reflex.decision { trigger, decision, scores, urgency, by: "jev" | "local", latencyMs, reason }`, parented to the event that caused it.

### TypeSafe Jev (when `TYPESAFE_API_KEY` is set)

`POST https://api.typesafe.ai/v1/systemone`, model `jev-latest`, one typed `choice` question (`decision`) whose criteria describe all eight options. The state is compact: event line, rule, urgency, trigger data, scene, gaze label, seconds since she spoke / reacted, relationship scalars, and the policy ("ignore 80-95% of ambient events, never ignore the user speaking unless they say stop").

- **400ms budget.** On timeout, HTTP error, or malformed answer the local verdict is used (`by: "local"`, reason says why).
- **Breaker.** 3 consecutive failures pause remote calls for 30s.
- **Hard cases never touch the network:** stop words, approvals while an action waits for a yes/no, anything before she's born, `task.done` for a task she escalated herself.
- **Guardrails on Jev's answer:** a direct utterance is never ignored; when the local scorer is at least 0.85 confident (e.g. "figure out dinner" is ESCALATE) and Jev disagrees, the local pick stands and the reason says `local pin`.

### Local scorer (always available)

Logits per decision, softmax into scores, argmax. Everything starts at IGNORE 0, others -1.5.

**Utterances** (checked in order):

| Intent | Example | Result |
|---|---|---|
| stop | "wait", "stop", "nvm", "not now" | IGNORE + `speech.stop` right away, ambient queue flushed |
| approval while an action is pending | "yeah", "do it", "nah" | IGNORE (agency owns it) |
| task | "figure out", "plan", "book", "find me a", "I have no idea what I'm doing tonight" | ESCALATE |
| command | "close spotify", "close it" | ACT |
| help | "how do I", "help me" | HELP |
| down | "rough day", "tired", "breakup" | COMMENT (behavior `comfort`) |
| question | ends in `?` or starts with a question word; "thoughts?" | REACT (behavior `answer`) |
| filler | "ok", "hmm" | GLANCE |
| laugh | "lol", "lmao" | REACT |
| statement | anything else | COMMENT or REACT (banter decides) |

**Ambient salience** (before social modifiers):

| Rule | Logits |
|---|---|
| `companion_born` | COMMENT 6 |
| `relapse` | ACT 4, COMMENT 2.5, IGNORE -2 |
| `repeat_media` (n plays) | IGNORE 2.2, COMMENT 1.2 + 1.4(n-3) + 1.5(banter-0.5), GLANCE 0.4 |
| `task_done` | IGNORE 1.2, REACT 1.8 (IGNORE 6 if it's her own escalation) |
| `stare` (ms) | IGNORE 2.4, GLANCE 1.8 + 0.8·min(1,(ms-4000)/5000), COMMENT 0.5 for food (else -0.2) + (initiative-0.5) |
| `long_silence` | IGNORE 2, ASK 0.8 + initiative, COMMENT 0.4 + 0.5·banter |
| `face_return` | IGNORE 1.4, GLANCE 1.3, REACT 1.2 + warmth |
| `app_opened` | IGNORE 3, GLANCE -0.5, COMMENT -0.8 + (banter-0.5) |
| anything else | IGNORE 2.5, GLANCE 0.5, COMMENT 0.3 |

**Social modifiers** (added to every non-IGNORE logit, except `companion_born` and `relapse`):

| Feature | Effect |
|---|---|
| relationship.initiative | +2·(initiative - 0.5) |
| she spoke < 20s ago / < 60s ago | -2 / -1 (don't chatter) |
| she reacted out loud or acted < 30s / < 90s ago | -1.5 / -0.6 (a silent GLANCE doesn't count) |
| user is mid-sentence (`voice.partial`) | -2 |
| avatar state `speaking` | -1.5 |
| scene `swarm` / `architecture` | -0.5 |
| whim | IGNORE ± 0.5, a deterministic hash of the trigger id, so borderline cases vary but replays don't |

Before `companion.born`, every ambient trigger is IGNORE.

Spec examples, as scored: opening Spotify is IGNORE 0.9+; the breakup song on its 4th play is COMMENT; the dating app after she exists is ACT.

## Router

- **Queue.** Triggers are sorted by urgency (immediate, soon, later), then age. One pending trigger per ambient rule (newest wins), max 16. Stale after 30s (soon), 120s (later), 60s (immediate).
- **Draining.** `timer.tick` (every 2s) drains one trigger. `immediate` triggers don't wait for the tick. `later` ones wait until the user has been quiet 3s+. Non-immediate triggers wait while she's speaking.
- **One reaction in flight.** Stop words skip the slot entirely. Task reports queue for the slot ahead of ambient triggers.
- **GLANCE:** `avatar.look { targetKey }` at the trigger's target or the current gaze target. No words.
- **REACT / COMMENT / ASK / HELP:** `memory.recall(userText or event, { emit: true })` (the UI flash), then `speech.say(brains.persona({ event, behavior, userText, extra, marks: true, maxWords }), { parent })`. Behaviors: `greet, answer, react, tease, comfort, ask, help, report`. A direct utterance while she's talking interrupts her. If brains is missing or its stream throws before producing text, a scripted fallback line is spoken.
- **Deixis.** `extra` always starts with `they are looking at: <label> <meta>` when the gaze target is fresh (30s) or the utterance is deictic ("this", "that one", "thoughts?"). Deictic utterances also get `when they say "this", "that" or "thoughts?", they mean <label>`. Recalled memories and trigger facts follow.
- **ACT:** relapse says `...seriously?` (mood annoyed) then `agency.act("shell.close_app", { app: "Eigen" })`. "close X" maps to `app.quit { app }`, or to `shell.close_app` when X is the dating app.
- **ESCALATE:** a scripted ack ("on it.", ...) with mood thinking, then `agency.runTask(goal, { parent })` in the background, so the slot frees up and she can keep chatting. When it resolves she reports through persona with behavior `report` and the result summary in `extra`. The `task.done` for her own task is not narrated a second time.
- **After every exchange:** `memory.observe({ user, eve, event })`. Relationship nudges come from the bus (see below).
- **Missing services.** `speech`, `brains`, `memory` and `agency` are looked up with `tryUse` on every use. When one is missing, that step is logged and skipped.
- `GET /api/reflex`: rules, queue, jev status, stats (with the live ambient ignore rate), last 50 decisions.

## Relationship model

`{ banter, warmth, initiative, verbosity, confidence }`. Each step is clamped to ±0.1, and values stay in [0.05, 0.95]. Everything relaxes toward the baseline with a 30-minute half-life (folded in on ticks at most every 30s, announced when it has moved 0.01+). The baseline is seeded on `companion.born` from the persona dials: banter = (humor + sarcasm)/2, warmth, initiative, verbosity, confidence 0.5.

| Signal (from the bus) | Nudge |
|---|---|
| user laughs ("lol", "lmao", "haha") | banter +0.03, warmth +0.01 |
| positive reply to her line within 30s ("fair", "true", "good one") | banter +0.03 |
| dismissal ("stop", "not now", "nah", "no thanks") | initiative -0.04 |
| rude ("shut up", "go away") | warmth -0.02, banter -0.01 (on top of the dismissal) |
| sweet ("thanks", "love you") | warmth +0.03 |
| terse reply to her (1-2 words) | verbosity -0.02 |
| long reply to her (15+ words) | verbosity +0.01, warmth +0.01 |
| every 4th consecutive turn in a conversation | warmth +0.02, confidence +0.01 |
| `task.done` ok / failed | confidence +0.03 / -0.03 |
| `action.approval` yes / no (spoken or key) | confidence +0.01 / initiative -0.02 |

Every change emits `relationship.update { state, delta, reason }` (the world reducer picks it up) and persists as `home.write("relationship", { state, baseline, persona, savedAt })`. On start the module restores that record, applies the decay for the time that passed, and emits `restored from home`. If the same persona is born again, the learned state is kept and only the baseline is refreshed.

Jev reads `initiative` (how chatty), `banter` (tease vs react, media comments) and `warmth` (welcome back). The router reads `verbosity` for `maxWords`.

## Measured ignore rate

`packages/core/test/reflex.module.test.ts` simulates an hour of desktop life through the real module, the local scorer and fake services. That hour has gaze wandering over menu items, ui and the avatar with occasional long stares, 20-25 app opens, a song every 2.5-4.5 min plus the same breakup song 5 times, two 2.5-5.5 min absences, a user line every 4-10 min, and one unrelated background task.

- Over 20 seeds: **81.7% to 91.3% IGNORE, mean 86.9%** of ~85 ambient triggers per hour. That works out to about 10 unprompted reactions an hour, 5-10 of them silent glances.
- The test asserts 80% to 95% on 5 fixed seeds, that the breakup song gets a COMMENT, and that app opens stay ignored.
- `REFLEX_SIM_VERBOSE=1 bun test packages/core/test/reflex.module.test.ts` prints per-seed rates by rule. `REFLEX_SIM_TRACE=1` prints every non-trivial decision with its scores.

## Contracts other modules rely on

- `speech.say(text | stream, { parent, interrupt, priority, mood, brain })`, `speech.stop(reason)`, `speech.speaking()`. Speech should emit `speech.begin`, which is how the world knows when she last spoke (the anti-chatter feature).
- `brains.persona({ event, behavior, userText, extra, marks, maxWords })` streams text. `extra` puts the gaze line first.
- `memory.recall(query, { k: 3, emit: true, parent })` emits `memory.recall`. `memory.observe({ user, eve, event })`.
- `agency.runTask(goal, { parent })` resolves to `{ ok, summary }`. It should emit `task.start` with the same `goal` string so her own `task.done` is recognized. `agency.act("shell.close_app" | "app.quit", { app })`.
- `home.read("relationship", null)` / `home.write("relationship", {...})`.
- The shell should emit `eye.status.facePresent`, `gaze.target` (re-announced while the user keeps looking), `voice.partial`/`voice.final`. The watcher emits `app.opened` / `media.play`.
