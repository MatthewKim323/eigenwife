# Brains and speech

Eve thinks in three layers and speaks through one pipeline. Everything here lives in `packages/core/src/brains` and `packages/core/src/speech`, behind two services other modules use: `ctx.use("brains")` and `ctx.use("speech")`.

```
System 0  senses        gaze, voice, apps          (shell, eye, watcher)
System 1  reflex        Jev decides IGNORE..ESCALATE (mind)
System 2a social cortex  persona()   fast, cheap, in character, streams     ~1.5-2.5s first token
System 2b frontal cortex frontier()  jabby first: memory, tools, planning   ~7-10s
          quickJson()               tiny structured calls                  ~1.8s
          speech        marks -> sentences -> TTS -> ordered speech.segment
```

## The social cortex: `persona(req)`

A streaming `AsyncIterable<string>` of what Eve says, marks included. The router tries backends in order and falls through on any failure before the first word:

| # | Backend | Needs | Model |
|---|---|---|---|
| 1 | Featherless | `FEATHERLESS_API_KEY` | `Sao10K/L3-8B-Stheno-v3.2`, then `NousResearch/Hermes-3-Llama-3.1-8B` (override `FEATHERLESS_MODEL`) |
| 2 | OpenAI | `OPENAI_API_KEY` | `gpt-6-luna` with `reasoning_effort: "none"`, then `gpt-4.1-mini`, `gpt-4o-mini` on a model error (override `EVE_OPENAI_MODEL`) |
| 3 | Anthropic API | `ANTHROPIC_API_KEY` | `claude-haiku-4-5-20251001` |
| 4 | claude CLI | `claude` installed + logged in (subscription, no key) | `claude -p --model haiku --strict-mcp-config --output-format stream-json --verbose` (jabby's voice brain pattern), plus `--include-partial-messages` for token deltas, `--system-prompt` to drop the Claude Code prompt, `--tools ""`, `--no-session-persistence`, `MAX_THINKING_TOKENS=0`, and jabby's env stripping |
| 5 | offline line | nothing | a short in-character "hm. give me a second." so she never goes silent |

**Prompt** = persona card (`preference.persona()` once Act I converges, the default Eve before that) + personality dials + relationship dials (`relationship.get()`) + voice rules + mark rules + `ctx.contextBlock()` (scene, **what the user is looking at** with its metadata, last utterance, open page, slots) + `req.extra` (memories, task results) + the moment (`event`, `behavior`, `userText`) + a word cap (`maxWords`, default 14).

**Voice rules**: short, dry, teasing, warm underneath, lowercase-ish natural speech, no emoji, no markdown, no em dashes, never "as an AI".

**Marks** the model writes inline, stripped before TTS:

```
[mood:annoyed 0.7] twenty-one dollars. [pause:0.4] for ramen?
```

`[mood:<neutral|happy|annoyed|thinking|surprised|smug|sad> 0.0-1.0]` and `[pause:<seconds>]`.

**Never leaks errors.** `guardSpoken()` holds the head of every stream (until a sentence end or 48 chars) and checks it against `ERROR_RE` (jabby's voice regex plus billing/auth strings like `insufficient_quota`). A match throws `LeakError`, and the router moves on to the next backend with nothing spoken. Later in the stream, error chatter cuts the line instead of being spoken. Every chunk is also sanitized: em/en dashes become commas, emoji, markdown and quote marks are removed, and a leading `Eve:` label is stripped.

**Circuit breaker.** `HealthBook` parks a backend after a failure: 10 minutes for 401/402/403/429 or any billing/rate-limit text, 20 seconds for anything else. Parked backends are skipped, so no turn pays for a dead key's latency. At boot, `probe()` makes one tiny call per configured API backend (and the speech module renders a `hm.` filler per network TTS backend), so a key with no credits is parked before the first real turn. After the cooldown they are retried automatically. When matt tops up OpenAI or adds a Featherless key, Eve switches over on her own without a restart (keys are read at call time).

A backend that fails after it already spoke is not retried in another voice: the partial line stands.

## The frontal cortex: `frontier(req)`

Slow, rare, smart. `engine: "auto"` order:

| # | Engine | How |
|---|---|---|
| 1 | **jabby** | `GET {jabbyUrl}/api/health` (cached 10s), then `POST /api/chat {message}`. SSE `data: {type:"chunk",text}` ... `{type:"done"}`. Jabby's tool traces (`_[tool: X -> Y]_`) become tool events and are stripped from the text. This is matt's real brain: memory, gbrain, tools, playbook. |
| 2 | claude | full headless `claude -p --output-format stream-json`, `--append-system-prompt`, model `sonnet` (`EVE_FRONTIER_MODEL`), cwd `~/.eve/work/<agent>`. `tools: "read"` enables Read/Glob/Grep/WebSearch/WebFetch with MCP; `tools: "none"` adds `--strict-mcp-config`. |
| 3 | codex | `codex exec --json --skip-git-repo-check --ephemeral -C <scratch> -c sandbox_mode="read-only" -c approval_policy="never" -`, prompt on stdin. Args and event parsing reimplemented from jabby's `engines/codex.ts` (importing it would pull jabby's harness types). |
| 4 | openai | chat completion, JSON mode when asked |

`json: true` extracts the first JSON object from the reply (`extractJson`: whole text, fenced block, then the first balanced `{...}` that parses, string-aware). An engine whose reply has no JSON counts as failed and the next one gets a shot. `frontier()` never throws; it returns `{ ok: false, error }` with every engine's reason.

`jabby` is never modified. We only call its HTTP API and the same CLIs it uses.

## Harem adapter: `haremBrain(ctx)`

Implements `packages/harem`'s `Brain` interface on the same engines and the same circuit breaker:

```ts
import { haremBrain } from "../brains"; // from inside packages/core (e.g. agency)
const brain = haremBrain(ctx); // pass as deps.brain
await brain.structured<T>({ agent, system, prompt, schema, tools, model, timeoutMs, onEvent, signal });
```

Order: claude (`--json-schema`, `StructuredOutput` tool) > codex (`--output-schema`) > jabby > openai. Tool calls and text stream out through `onEvent` as `{kind:"tool",name,detail}` / `{kind:"text",text}`. The abort signal kills the CLI. The types are mirrored structurally, so core never imports harem.

## `quickJson(system, user, { timeoutMs })`

Small structured calls (classification, extraction). OpenAI JSON mode first, then the other persona backends (with a JSON-only instruction), CLI haiku last. Hard timeout (default 8s) across the whole chain, robust parse, `null` on failure.

## Speech

```
say(text | stream)
  -> MarkSplitter      holds back incomplete "[..." tails across chunks, marks -> SpeechMark{at}
  -> SentenceChunker   . ! ? ; ; first 2 segments also on "," once >= 4 words; cap 12 words
  -> TTS               up to 4 in parallel, content-hash disk cache
  -> speech.segment    strictly in seq order { utteranceId, seq, text, marks, audioUrl? }
```

Events per utterance: `speech.begin` (text is the full clean text for strings, `""` for streams), `avatar.state speaking` at the first real segment, `speech.segment` x N, `speech.end`. `avatar.state idle` when the shell reports the last `speech.played`, or after an estimated duration if it doesn't.

- **Marks** travel with their segment, `at` rebased to the segment's text, so the face changes on the right word. A mark on a boundary belongs to the next segment. Unknown marks (`[gesture:wave]`) and audio tags (`[laughs]`) are dropped; ordinary brackets (`[1]`) are kept.
- **Filler.** If a stream's first chunk hasn't arrived in 700ms, a cached `hm.` / `mm.` goes out as seq 0 with a thinking mark and `avatar.state thinking`.
- **Priority.** `high` interrupts `normal`/`low`; `interrupt: true` interrupts anything. `low` lines are dropped while she is busy (ambient chatter goes stale). Same priority queues FIFO.
- **Stop.** `stop(reason)` emits `speech.stop`, then `speech.end { interrupted: true }`, and `avatar.state idle`. Queued lines are dropped.
- **Barge-in.** `voice.partial` with 3+ words while she is speaking stops her. A `speech.stop` from the shell cuts the core side too, without echoing another stop.
- **No audio is first class.** If every TTS backend fails (or `EVE_TTS=none`), segments go out without `audioUrl` and the shell speaks them with speechSynthesis.

### TTS backends

| # | Backend | Needs | Notes |
|---|---|---|---|
| 1 | OpenAI | `OPENAI_API_KEY` | `gpt-4o-mini-tts`, voice `marin` (`EVE_TTS_VOICE`), `instructions`: soft, low, dry, slightly teasing young woman, mp3 |
| 2 | ElevenLabs | `ELEVENLABS_API_KEY` | `eleven_flash_v2_5`, `ELEVENLABS_VOICE_ID` (default Rachel) |
| 3 | macOS `say` | a Mac with ffmpeg (or afconvert) | `Samantha` at 182 wpm (`EVE_SAY_VOICE`, `EVE_SAY_RATE`), converted to mp3. Zero keys, always there. |

`EVE_TTS=openai|elevenlabs|say` pins which backend goes first; `EVE_TTS=none` turns synthesis off. Same circuit breaker as the brains.

**Cache**: `~/.eve/audio/<sha256(voiceKey + "\n" + normalized text)>.mp3`, served at `GET /api/audio/<sha>.mp3` (`audio/mpeg`, immutable, CORS from the hub). The shell resolves the relative URL against the core origin. A lookup checks every backend's voice in preference order, so a line prerendered with OpenAI keeps that voice even when OpenAI is down.

### Scripted lines and prerender

`src/speech/lines.ts` holds the golden-path lines (`LINES.birth`, `price`, `done`, `relapse`, ...) and fillers. Say them by text: `speech.say(LINES.done)`.

```
bun run --cwd packages/core prerender                   # render every line segment, skip cached
bun run --cwd packages/core prerender --backend openai  # upgrade to a better voice once it works
bun run --cwd packages/core prerender --dry             # report what's cached
```

It prints one row per line with the backend and time per segment, and skips gracefully (a failed segment still plays through speechSynthesis).

## Routes

| Route | What |
|---|---|
| `GET /api/brains/status` | `live` (bool per backend), `detail` (model, last latency, first-token ms, last error, parked-until), `lastPersona` |
| `POST /api/brains/test` | `{ text, mode?: "persona" \| "frontier" \| "json", engine?, speak?, behavior? }`. `speak: true` pipes the persona stream through speech. |
| `GET /api/speech/status` | queue state, TTS order, live backends, cache size, health |
| `POST /api/speech/say` | `{ text, priority?, interrupt? }` |
| `POST /api/speech/stop` | `{ reason? }` |
| `GET /api/audio/<sha>.mp3` | cached audio |

## Env vars

| Var | Effect |
|---|---|
| `FEATHERLESS_API_KEY`, `FEATHERLESS_MODEL` | persona backend 1 |
| `OPENAI_API_KEY`, `EVE_OPENAI_MODEL` | persona backend 2, quickJson first, frontier last, TTS first |
| `ANTHROPIC_API_KEY`, `EVE_ANTHROPIC_MODEL` | persona backend 3 |
| `EVE_PERSONA_CLI_MODEL` | CLI persona model (default `haiku`) |
| `EVE_FRONTIER_MODEL`, `EVE_FRONTIER_EFFORT` | claude frontier model (default `sonnet`) and effort (default `low`) |
| `EVE_CODEX_EFFORT` | codex reasoning effort (default `low`) |
| `JABBY_URL` | jabby daemon (default `http://127.0.0.1:4632`) |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | ElevenLabs TTS |
| `EVE_TTS`, `EVE_TTS_VOICE`, `EVE_SAY_VOICE`, `EVE_SAY_RATE` | TTS selection and voices |
| `CLAUDE_BIN`, `CODEX_BIN` | CLI paths when not in the usual spots |

## Measured (2026-09-26, matt's Mac, live calls)

| Path | Result |
|---|---|
| OpenAI chat (`gpt-6-luna`, `gpt-5.4-mini`, `gpt-4.1-mini`, `gpt-4o-mini`) | **429 `insufficient_quota`** on every model (the key has no credits), 60 to 1000ms to fail. Model ids could not be verified; the fallback chain handles a missing model. The breaker parks OpenAI for 10 min after the first 429. |
| OpenAI TTS `gpt-4o-mini-tts` | **429 `insufficient_quota`**. Falls through to `say`. |
| Persona via claude CLI haiku, thinking on (`--effort low` alone) | 26.5s wall. Haiku still thinks with a long system prompt. |
| Persona via claude CLI haiku, `MAX_THINKING_TOKENS=0` | **first token 1.3 to 2.4s, full line 2.1 to 2.8s** (5 runs) |
| quickJson via claude CLI haiku | 1.8s |
| frontier via **jabby** daemon (json) | **9.5s**, valid JSON plan |
| frontier via claude `-p` sonnet (json) | 7.3s |
| frontier via codex exec (json) | 8.5s |
| harem `structured()` via claude `--json-schema` | 3.1 to 4.0s |
| TTS via macOS `say` + ffmpeg | ~750ms per segment |
| prerender of all 21 lines + fillers (37 segments, `say`) | 28s, all cached |
| End to end "thoughts?" while looking at the $21 ramen | filler `hm.` at **700ms**, first token 1.3 to 2.2s, first real audio segment **2.4 to 3.5s**: *"twenty-one dollars for ramen? mensho's lost the plot."* |

Smoke scripts (real network, not part of `bun test`):

```
bun run --cwd packages/core smoke:brains [persona|json|frontier|harem|all] [engine]
bun run --cwd packages/core smoke:speech ["what the user says"]
```

## Tests

`bun test packages/core/test/brains*.test.ts packages/core/test/speech*.test.ts`. No network, no processes: fetch and spawn are injected (`test/brains.fakes.ts`). Covered: mark splitter at every split point, unknown marks, brackets in normal text, whitespace collapse; chunker rules, decimals, word cap, mark rebasing, stream vs one-shot equivalence; persona fallback order, error-text suppression, circuit breaker, offline line; OpenAI model fallback and quota handling; claude stream-json parsing (deltas, thinking, error results); CLI flags and env stripping; quickJson parsing and hard timeout; frontier auto order, JSON extraction fallthrough; jabby SSE and tool traces; codex args and events; harem adapter with schema, events, abort, fallback; speech event order, parallel synth with ordered emission, cache hits across restarts, filler, barge-in, stop, preemption, low-priority drops, `speech.played`, audio route with content-type and CORS.
