# Voice: talker + thinker

Eve talks like a fast chat model and works like an agent. Two brains share one voice:

- **Talker**: a streaming persona model with exactly one tool, `delegate({ stall, kind, task })`. It answers anything it can on the spot (knowledge, opinions, advice, jokes, the conversation so far) in her voice, in at most three short sentences.
- **Thinker**: the frontier stack (jabby first, then `claude -p`, codex) for anything that needs tools, his stuff, fresh info or real work. The talker hands it the task and keeps talking.

When a turn needs the thinker she never goes quiet: the stall line (`"ooh, lemme look."`) is spoken first, progress updates come while it runs, and the result is spoken at a natural gap in her voice. Her ElevenLabs voice stays the default engine (Deepgram Aura when `EVE_TTS=deepgram`). The optional full-duplex `gpt-live-1` engine is separate (`packages/core/src/live`, docs/LIVE.md).

Research and the numbers behind the design: `docs/research/VOICE_HARNESS.md` (Phase 1).

```
 mic ─► ears (Deepgram Flux) ─ voice.partial ─► speech prewarms the TTS socket
            │  EagerEndOfTurn ─ voice.eager ───► talker starts speculatively (nothing spoken)
            │  TurnResumed ─── voice.resumed ─► speculation dropped
            │  EndOfTurn ───── voice.final {endOfTurn} ─► reflex turn (no merge wait)
            ▼
 reflex: utterance trigger ──┬─► Jev decides (local + typesafe-ai/jev, 400ms budget)
                             └─► talker already streaming (adopted from the eager run, or started now)
   IGNORE / GLANCE / ACT / ESCALATE ─► talker run aborted, the old paths run (scripted acks, agency, work)
   REACT / COMMENT / ASK / HELP ────► talker stream ─► speech (first clause to TTS on its own)
                                          │
                                          └─ delegate(kind, task, stall)
                                               stall spoken now (or a prerendered ack clip)
                                               answer ─► thinker: brains.frontier({tools: "read"}) jabby > claude > codex
                                                         progress narration (<= 1 per 6s) ─► result at a gap, <= 3 sentences
                                               do ─────► reflex paths: act (music, browser, apps), outfit, work.handle, agency.runTask
```

## The talker

`packages/core/src/talker`, provides the `talker` service.

| # | Backend | Needs | Tools | Model |
|---|---|---|---|---|
| 1 | anthropic | `ANTHROPIC_API_KEY` | native `tool_use`, streamed `input_json_delta` (eager input streaming) | `claude-haiku-4-5-20251001` (`EVE_TALKER_ANTHROPIC_MODEL`) |
| 2 | gateway | `AI_GATEWAY_API_KEY` (with credits) | native `tools` on chat completions | `anthropic/claude-haiku-4.5`, then `openai/gpt-6-luna-fast` (`EVE_TALKER_MODEL`) |
| 3 | openai | `OPENAI_API_KEY` | native `tools` | `gpt-6-luna`, `gpt-4.1-mini` |
| 4 | featherless | `FEATHERLESS_API_KEY` | inline protocol | `Sao10K/L3-8B-Stheno-v3.2` |
| 5 | claude-cli | `claude` logged in (no key) | inline protocol + keyword routing | `haiku` via `claude -p` (jabby's voice brain flags) |

So today, with no Anthropic key, **the gateway is the default talker**; the CLI is the no-key last resort. Backends fall through on any failure before the first word (same circuit breaker as the persona router: 10 min for auth/billing/429, 20s otherwise); a backend that already spoke is never restarted in another voice. Error chatter (`insufficient_quota`, "API Error", ...) is never spoken (`guardSpoken`).

**Prompt** = the full persona prompt (card, dials, who he is, voice and mark rules, the rolling conversation from `brains/conversation.ts`, the world block with his gaze target, memories, thinker state) + the talker rules: answer directly when you can; delegate for fresh/live info, his stuff (calendar, email, files, texts, repos), doing things, or research; never pretend to have looked something up. The talker knows when a thinker job is open ("you're already on it") and gets the last thinker result for follow-ups ("tell me more").

**The tool**: `delegate({ stall, kind: "answer" | "do", task })`. `stall` is first in the schema so it streams first: the talker speaks it the moment its JSON string closes, before the task is even written (`partialStall`). If the model said real words of its own before calling the tool, the stall is skipped (no double opener). If there's no stall and no words, a prerendered ack clip plays (`STALL_LINES`).

**Inline protocol** (backends without reliable tool calling): the whole reply is one line, `>>delegate <answer|do> | <stall> | <task>`. `InlineDelegateParser` holds back only the first couple of characters until it can tell. On top of that, obvious lookups ("weather", "news", "what's on my calendar", "who won", "look it up") skip the CLI entirely and delegate by keyword (`lookupIntent`), so the no-key path never guesses at live facts.

`EVE_TALKER=off` turns the talker off (the old persona path answers). `EVE_TALKER_BACKENDS=gateway,claude-cli` limits and orders backends.

## Routing (reflex)

`packages/core/src/talker/router.ts` (`VoiceRouter`), owned by the reflex module:

- **Jev in parallel.** When an utterance trigger is enqueued, the talker starts immediately (memories get a 150ms budget) while Jev decides. Anything but REACT/COMMENT/ASK/HELP aborts the stream: IGNORE (not addressed to her, the addressing gate is unchanged), GLANCE, and the deterministic ACT/ESCALATE intents (music, outfits, browser, apps, tasks, work asks) keep their existing fast paths and scripted acks. Those intents, approval replies, screen questions and open offers never start a talker at all.
- **Speculation.** `voice.eager` starts a run before he's finished; `voice.final` with the same words (normalized) adopts it, different words or `voice.resumed` abort it, and an unadopted run dies after 5s. Nothing is spoken until the turn is final.
- **Delegate answer** runs `brains.frontier({ tools: "read", signal, onEvent })` in the background (jabby first: his tools, gbrain, calendar, email). The result goes through the persona brain with the found text as ground truth: at most three short sentences, most useful part first, and an offer if there's more. The full result is kept 10 minutes for follow-ups.
- **Delegate do** re-reads the task with the intent reader and goes through the same paths Jev's ACT/ESCALATE use: `act()` (music, browser, apps), `outfit()`, `work.handle()` for work asks, else `agency.runTask()`. Spoken approvals are untouched. The canned "on it." is skipped because the stall already played.
- **Keep chatting.** Thinker jobs run outside the reflex slot, so he can talk to her while they run; the talker answers casual turns and knows the job is open.
- **Results at a gap.** Thinker results and task reports wait until she isn't speaking, he isn't speaking, and he's been quiet 1.2s (`waitForGap`), then take the reflex slot. After 30s they're said anyway.
- **Progress narration.** `swarm.progress`, `work.task` states and frontier tool calls (jabby tool traces, claude/codex tool events) become short spoken updates ("still on it, searching the web.", "okay, found three spots, checking hours."): none in the first 4s, at most one per 6s (the stall counts), no repeats, only while neither of them is talking, spoken as low priority so they're dropped if she's busy.
- **Cancel.** "never mind", "nvm", "forget it", "cancel that", "scratch that", "don't worry about it" while a job is open aborts it (the frontier signal kills the CLI/HTTP call; agency tasks can't be aborted mid-flight, so their report is dropped) and she says "okay, dropped it." Otherwise those words are ordinary stop words.
- **Stop words, conversation memory, addressing gate, onboarding**: unchanged, and still first.

Bus: `talker.delegate { runId, kind, task, stall?, backend? }` on every delegation. Speech utterances from the talker carry `brain: "talker:<runId>"`, thinker results `"thinker"`, narration `"narration"`.

## Latency work

| Piece | What | Where |
|---|---|---|
| Flux STT | `flux-general-en` on `/v2/listen`, `eot_threshold` 0.7, `eager_eot_threshold` 0.5 (`EVE_FLUX_EOT`, `EVE_FLUX_EAGER`), `eot_timeout_ms` 3000. TurnInfo events -> `voice.partial`, `voice.eager`, `voice.resumed`, `voice.final { endOfTurn: true }`. Raw PCM/opus clients (the overlay) get Flux; containerized webm stays on nova-3. `EVE_STT=nova` forces nova. Flux that closes twice before opening falls back to nova on its own. | `ears/flux.ts`, `ears/session.ts` |
| No merge wait | A Flux `endOfTurn` final flushes the reflex turn immediately (the 800ms "talk, pause, keep talking" window is only for nova/browser finals). | `reflex/module.ts` |
| Talker off the CLI | Streaming API (Anthropic or gateway) instead of a spawned `claude -p`. | `talker/backends.ts` |
| Jev in parallel | Talker starts at trigger time (or at EagerEndOfTurn), Jev's 100-400ms is hidden. | `talker/router.ts` |
| First clause | The chunker cuts the first two segments at a comma or colon once they have 4 words, and caps the first segment at 9 words, so TTS starts on the first clause. | `speech/chunker.ts` |
| Prewarmed TTS sockets | ElevenLabs `multi-stream-input` (one context per segment, many in flight on one socket, `eleven_flash_v2_5`, mp3) and Deepgram Aura-2 `/v1/speak` websocket (Speak + Flush, linear16 wrapped as wav). Opened at boot and again whenever he starts talking (`voice.partial`, `voice.eager`); HTTP fallback on any socket trouble. `EVE_TTS_STREAM=0` turns them off. | `speech/sockets.ts`, `speech/tts.ts` |
| Live audio | A streaming backend's segment goes out at its first bytes with a live url (`/api/audio/live/<id>.<mp3\|wav>`, `stream: true`); the shell plays it while it's synthesized. See Streaming audio. `EVE_TTS_LIVE=0` turns it off. | `speech/live.ts`, `shell/voice/engine.ts` |
| Instant clips | Fillers, stall/ack lines and cancel lines are prerendered in her current voice at boot (`EVE_PRERENDER_CLIPS=0` to skip), so a delegation's first sound is a cache hit. | `speech/lines.ts`, `speech/module.ts` |

## Streaming audio

Before, a segment's `speech.segment` went out only when its whole file was synthesized and cached, and the shell then fetched and decoded the whole file. Now:

```
 TTS socket / chunked HTTP ─ chunks ─► LiveStreams (core, in memory) ──► GET /api/audio/live/<id>.<ext>  (chunked, follows the stream)
        │  first chunk ─► speech.segment { audioUrl: live url, stream: true }   (still strictly in seq order)
        └─ done ───────► AudioCache.put(<sha256 content hash>)  (replays, prerendered lines, plain /api/audio/<sha> urls)
```

- **Core** (`speech/live.ts`, `speech/tts.ts`, `speech/service.ts`): backends take an optional `onChunk`. ElevenLabs multi-context hands out each socket audio message; Aura sends a streaming wav header (sizes `0xFFFFFFFF`) then PCM as it comes, while the cached file keeps a real header; OpenAI / Deepgram / ElevenLabs HTTP read their chunked bodies. `Tts.render(text, signal, { onLive })` opens a live stream at the first chunk and tees every byte into the cache under the normal content hash. The speech service emits a segment at whichever comes first, the live start or the finished (or cached) file, and still waits for the segment before it. Cached lines keep plain file urls. A socket that dies after it already streamed part of a segment doesn't restart it over HTTP (no second format mid-segment); the live stream just ends. A finished live url stays readable for 60s, then serves the cached file by its hash.
- **Shell** (`voice/engine.ts`, `voice/stream.ts`, `voice/player.ts`): every segment is prepared the moment it arrives, so the next one is already downloading (and, for mp3, already appended to its MediaSource) while the current one plays. Live mp3 plays through `MediaSource("audio/mpeg")` in an `<audio>` routed into the shared AudioContext with `createMediaElementSource`; live Aura wav is parsed and scheduled as back-to-back PCM buffers. Both feed the same `AnalyserNode`, so lipsync is unchanged. Cached files take the old fetch + `decodeAudioData` path. A stream that can't start (no MediaSource, `play()` refused, a bad header) decodes the whole file once it's in; no audio at all falls back to speechSynthesis. Strict FIFO, `speech.played`, and barge-in are unchanged (stop also stops prepared-but-unplayed streams and aborts their downloads). Marks fire by playback position (`TimedMarks`, polled every 25ms), against the real duration once known, else text length at a speaking rate learned from earlier segments (`SpeechRate`); a stalled stream holds its marks; leftovers fire at the end.

**Measured** (2026-09-26, matt's Mac, real network, prewarmed sockets, every line new text; `say()` of a two-clause line -> her first segment):

| TTS | Stage | whole files (before) p50 / p95 | live stream (after) p50 / p95 | n |
|---|---|---|---|---|
| ElevenLabs flash (ws) | playable at the player (`stream-bench`) | 341 / 443ms | **203 / 385ms** | 18 |
| ElevenLabs flash (ws) | **first audible sample in Chromium** (`stream-browser-bench`, shell engine) | 276 / 474ms | **202 / 646ms** | 12 |
| Deepgram Aura-2 (ws) | playable at the player | 950 / 1441ms | **209 / 480ms** | 18 |
| Deepgram Aura-2 (ws) | **first audible sample in Chromium** | 910 / 1294ms | **140 / 174ms** | 12 |

So Aura saves **~770ms p50** (the whole ~1s segment used to be synthesized before a sample played; now it's the ~130ms first byte), and ElevenLabs saves **~75 to 140ms** (flash returns a short segment nearly all at once, so there was less to win). With streaming, Aura goes from the slowest voice to the fastest at first sound.

End to end (`voice-bench gateway 8`, end of his speech -> her reply's first segment, now the first-byte moment when live): ElevenLabs 1195ms p50 before / 1430ms after, Deepgram 1567 / 1216ms. These runs are dominated by the gateway talker's first-token jitter (the same phrase swings 1.0 to 1.9s between runs, and Deepgram had two ~12s talker stalls in each run), so they don't resolve a 100ms TTS change; the isolated benches above are the real before/after. Expect roughly: ElevenLabs reply ~1.0 to 1.1s p50, Aura reply ~1.2s p50 (was ~1.7s in the table below).

## Measured

2026-09-26, matt's Mac, real network. Scripts below; "reply" = end of his speech (the `voice.final`) to the first audio segment of her actual answer being ready for the player; "first sound" includes the 700ms filler (`hm.`) when the answer isn't ready yet.

**End of speech -> first audio (whole core: reflex, Jev, talker, memory, speech, TTS)**

| Talker | TTS | reply p50 | reply p95 | first sound p50 | n |
|---|---|---|---|---|---|
| gateway `anthropic/claude-haiku-4.5` | ElevenLabs flash (ws) | **1192ms** | 1518ms | 856ms | 5 |
| gateway `anthropic/claude-haiku-4.5` | Deepgram Aura-2 (ws) | 1690ms | 2740ms | 855ms | 8 |
| gateway `openai/gpt-6-luna-fast` | ElevenLabs flash (ws) | **1006ms** | 1194ms | 896ms | 5 |
| claude CLI haiku (no key) | ElevenLabs flash (ws) | 2554ms | 3696ms | 862ms | 4 |
| talker off (old persona path, now also on the gateway) | ElevenLabs flash (ws) | 1498ms | 2589ms | 1115ms | 4 |
| Anthropic API haiku | | not measured: no `ANTHROPIC_API_KEY` yet | | | |

With ElevenLabs over the prewarmed socket the gateway talker lands at **~1.0 to 1.2s p50**, on target; `gpt-6-luna-fast` edges out haiku on speed, haiku stays the default for tool-use and in-character quality (`EVE_TALKER_MODEL` swaps). The CLI fallback is honest at ~2.5s p50, with the 700ms filler covering the silence. A thinker lookup (`--delegate`, "what's the weather in irvine tonight?"): stall audio at **839ms**, the spoken result at ~10.3s (jabby round trip + persona summary). The 700ms filler fires on most turns because the reply's first segment usually lands after it; that's the "first sound" column.

Before this work (docs/BRAINS.md, CLI persona, fixed endpointing, serial stages): first real audio 2.4 to 3.5s.

**Pieces**

| Stage | Measured |
|---|---|
| Talker first word, gateway haiku (`talker-smoke`) | 700 to 1200ms (tool definitions and the full persona prompt included) |
| Talker delegation, gateway | stall text at ~0.9 to 1.9s (the gateway returns tool arguments in one piece at the end, so the stall comes with the call); the Anthropic API streams `input_json_delta`, so there the stall can be spoken before the task is written |
| TTS segment ready, ElevenLabs flash | http p50 252 / p95 492ms; **ws p50 211 / p95 363ms** (first byte 200ms) |
| TTS segment ready, Deepgram Aura-2 | http p50 732 / p95 1321ms; **ws p50 623 / p95 890ms** (first byte 126ms) |
| End of turn, Flux (eot 0.7, eager 0.5) | EagerEndOfTurn p50 243ms, EndOfTurn p50 930 / p95 1502ms |
| End of turn, Flux (eot 0.6) | EagerEndOfTurn p50 149ms, EndOfTurn p50 700 / p95 1416ms |
| End of turn, nova-3 (endpointing 300) | speech_final p50 512 / p95 694ms, **plus** the reflex's 480 to 800ms merge wait for non-Flux finals, so ~1.0 to 1.3s before a turn |

Flux's EndOfTurn alone is not faster than nova's endpoint, but a Flux final needs no merge wait, and the talker starts at EagerEndOfTurn (~150-250ms after he stops), so by EndOfTurn the reply is usually already streaming. Default thresholds stay at the research doc's 0.7 / 0.5 (fewer premature turns); `EVE_FLUX_EOT=0.6` trades ~230ms for more early cut-ins. The STT numbers use macOS `say` audio, not a real voice.

## Keys: what unlocks what

| Key | Unlocks |
|---|---|
| none | Talker on `claude -p --model haiku` (inline delegate protocol, keyword routing for lookups). Thinker on jabby / `claude -p` / codex. Voice via macOS `say`. Works, but ~2-3s to first audio. |
| `AI_GATEWAY_API_KEY` (with credits) | **Default talker** (`anthropic/claude-haiku-4.5`, native tool calls), Jev remote, persona and quickJson on the gateway. |
| `ANTHROPIC_API_KEY` | Talker on the Anthropic Messages API directly (native streamed tool input, so the stall can be spoken before the task is written). Goes first when set. |
| `DEEPGRAM_API_KEY` | Flux STT with eager end of turn (ears), Aura-2 TTS over a prewarmed socket (`EVE_TTS=deepgram`). |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` | Her voice over the prewarmed multi-context socket (`eleven_flash_v2_5`), quota guard unchanged. |
| jabby daemon running | The thinker's first choice: matt's real tools and memory. |

## Routes

| Route | What |
|---|---|
| `GET /api/talker/status` | backends (configured, model, parked), health, end-of-speech -> first-audio p50/p95 per backend, last 20 samples |
| `POST /api/talker/test` | `{ text }` -> `{ said, delegate, backend, firstTextMs }` (no speech) |

## Scripts (real network, not part of `bun test`)

```
cd packages/core
bun --env-file=../../.env run scripts/talker-smoke.ts [backend] ["phrase" ...]   # what she says, first word ms, delegations
bun --env-file=../../.env run scripts/voice-bench.ts gateway 8                    # end of speech -> first audio on a real core
bun --env-file=../../.env run scripts/voice-bench.ts claude-cli 4
bun --env-file=../../.env run scripts/voice-bench.ts off 4                        # old persona path, for comparison
bun --env-file=../../.env run scripts/tts-bench.ts deepgram 3                     # tts http vs ws
bun run scripts/stt-bench.ts 2                                                    # flux eager/EndOfTurn vs nova-3 speech_final
bun --env-file=../../.env run scripts/stream-bench.ts deepgram 3                  # live stream vs whole files: tts + route, no talker
PLAYWRIGHT_CORE=<path>/playwright-core bun --env-file=../../.env run scripts/stream-browser-bench.ts elevenlabs 2   # first audible sample in headless chromium
EVE_TTS_LIVE=0 bun --env-file=../../.env run scripts/voice-bench.ts gateway 8     # whole-file path, for comparison ("play" column = when the player can start)
```

## Tests

`bun test packages/core/test/talker.test.ts packages/core/test/ears.test.ts packages/core/test/speech.sockets.test.ts packages/core/test/speech.text.test.ts`. Hermetic: fake backends, fake sockets, fake clock. Covered: delegate parsing for Anthropic SSE (partial JSON stall first), OpenAI/gateway `tool_calls` deltas, the inline protocol, keyword routing without spawning; backend fallthrough, stall as text, no double opener, error text never spoken, replay for late readers, abort; parallel Jev abort (IGNORE kills the run), delegate answer (stall first, frontier with tools, result through the persona), ack clip when there's no stall, delegate do through agency with no second ack, result held while she talks, chatting during a job and "never mind" cancelling it, narration rate limits (grace, 6s, no repeats), gap waiting, cancel phrases, latency percentiles; Flux URL, eager/resume/EndOfTurn state machine, dangling turns, the session on the Flux protocol, fallback to nova; eager speculation adopted by the same final, dropped by TurnResumed or a different final; clause chunking; ElevenLabs multi-context and Aura sockets, socket failure falling back to HTTP.

Streaming audio: `bun test packages/core/test/speech.live.test.ts apps/shell/src/voice/stream.test.ts`. Live route pipes chunks in order while synthesizing and tees them to the cache (then serves the cached file), late readers, expiry, early emission with strict order, cached lines on plain urls, `EVE_TTS_LIVE=0`, stop mid-stream, no HTTP restart after a partial socket stream, chunked HTTP bodies, the Aura streaming wav header; shell: chunk buffer following a download, wav parsing and split samples, mixed streamed/cached queue order with the next segment prepared early, abort mid-stream stopping prepared streams, fallback to speechSynthesis when audio can't be prepared or refuses to play, marks by playback position, learned speaking rate.

## Next

- Emit the first segment at request time instead of first byte (the shell's fetch would already be waiting): a few ms locally, more if the shell ever runs on another machine.
- Prompt caching on the Anthropic path once the stable prefix passes Haiku's minimum cacheable size.
- ElevenLabs alignment data for vowel lipsync (the socket already carries it with `sync_alignment=true`).
