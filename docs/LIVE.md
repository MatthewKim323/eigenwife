# Eve Live

Eve Live is the second voice engine: one full-duplex **gpt-live-1** session instead of the classic cascade (ears STT, then brains, then speech TTS). She hears you while she talks, backchannels, and hands anything real to the same backend the cascade uses. It sits behind a toggle so matt can A/B the two by ear. Research and pricing background: `docs/research/VOICE_HARNESS.md`.

The tradeoff: Live speaks in an OpenAI voice, not her ElevenLabs voice. What you get for that is the turn-taking.

## Turn it on

1. **Credits.** Live needs one of these:
   - **AI Gateway** (`AI_GATEWAY_API_KEY`) with credits on the team. This is the default path (WebSocket, client delegation). The free tier can mint tokens, but the Live model is blocked until the team has credits.
   - **OpenAI** (`OPENAI_API_KEY`) on a paid project (Tier 1+, the free tier is unsupported). This path uses WebRTC. matt's key is at 0 credits right now (429 `insufficient_quota`).
   Either one is enough. With neither, the toggle refuses and says `Eve Live needs OpenAI or gateway credits`.
2. **Pick the engine**, any of these ways:
   - Tray: **Voice engine: Classic / Live**.
   - Say it: "switch to live mode" or "go live". To go back: "go back to classic", "use your normal voice", or "turn off live mode". Works from either engine.
   - Env: `EVE_VOICE_ENGINE=live` (overrides the saved choice at boot).
   - API: `POST /api/live/engine {"engine":"live"}`.
   The choice is saved in `~/.eve/voice.json`.
3. Keep the overlay (or the shell tab) open. The page owns the mic and the speaker. The core waits for it (`live.state: connecting`) if it isn't open yet.

| Env | Default | What |
|---|---|---|
| `EVE_VOICE_ENGINE` | saved, else `classic` | `classic` or `live` at boot |
| `EVE_LIVE_PROVIDER` | `auto` | `auto` (gateway, then OpenAI), `gateway`, or `openai` |
| `EVE_LIVE_VOICE` | `gleam` | Any gpt-live-1 voice: `gleam`, `marin`, `quartz`, `willow`, `delta`, ... |
| `EVE_LIVE_DAILY_MIN` | `60` | Live minutes per day before she falls back to classic |
| `EVE_LIVE_IDLE_MIN` | `3` | Close the session after this many quiet minutes and reopen when you talk. `0` = never |
| `EVE_LIVE_MODEL` | `gpt-live-1` | Model id. Gets the `openai/` prefix on the gateway |

**Voice.** Her ElevenLabs voice is young, soft, and playful. Of the feminine English gpt-live-1 voices, `gleam` (North American, natural) is the closest. `willow` is softer but Irish, `quartz` is Australian and generated, and `marin` is the API default. The voice is fixed once a session starts, so after changing `EVE_LIVE_VOICE` you need to restart the core or toggle Live off and on.

## How it works

```
 page (overlay/shell)                         core (packages/core/src/live)
 ───────────────────                          ─────────────────────────────
 mic ─┐   gateway: wss + PCM16 24k frames     mints the single-use client secret
      ├─► gpt-live-1 ◄─────────────────────   (or swaps the WebRTC SDP with the key)
 spk ◄┘   openai:  WebRTC tracks + "oai-events"  writes the session config
 analyser -> her mouth                        handles every non-audio event:
 events (minus audio) ── ws /live ─────────►    transcripts -> bus, delegation -> reflex/agency,
                       ◄─ send/close/teardown   usage -> cost guard
```

- **Keys never reach the page.** On the gateway, the core calls `POST /v1/realtime/client-secrets {model, routeKind:"live"}` and the page connects with the single-use token as the subprotocol `ai-gateway-auth.<token>`. On OpenAI, the page makes the SDP offer and the core posts it to `/v1/live/sessions` with the key. Relay messages are in `packages/protocol/src/live.ts`.
- **Session config.** The instructions carry her persona card (renamed if he named her), personality and relationship dials, the know-me profile with boundaries as hard rules, the rolling conversation summary, the world block, voice rules, and an explicit "delegate when / don't delegate when" policy. The recent turns go in as startup history `input` (up to 40 messages, well under the 128-message / 8192-token limit). Other settings: `delegation: {type: "client"}`, `store: false`, and on the gateway `audio.format` PCM 24 kHz. gpt-live-1 rejects `session.update` for instructions, so mid-session changes (dials, profile, world) go in as `session.thinking.append` with `delegation_id: null`, at most every 2 minutes or when something changes.
- **One STT path at a time.** While Live is on, the page disposes the classic ears (Deepgram or browser recognition) and releases their mic. When classic comes back, they start again exactly as they do at boot. `voice.engine {engine, by}` announces every switch.

### Bus parity

Everything downstream of the cascade keeps working because Live emits the same events:

| gpt-live-1 | Eve bus |
|---|---|
| `session.input_transcript.delta` | `voice.partial` (running text). After 700 ms of no new text, or when she takes the turn, `voice.final`. The reflex then makes `voice.turn`, Jev judges it, and addressed turns become `conversation.turn` (user) |
| `session.output_transcript.delta` | `speech.begin {brain:"live"}`, `avatar.state speaking`, `avatar.mood` from a keyword read of each finished sentence, then `speech.end` and `conversation.turn` (eve) after a 1.2 s gap. Backchannels ("mhm") while he talks are not saved as turns |
| session events | `avatar.state` listening / thinking (a delegation is open) / speaking / idle |
| output audio | Her mouth, from an AnalyserNode on what is actually playing, through the same lipsync envelope as classic |

Memory, the conversation summary, the HUD, the wardrobe, reflex rules, and agent-cursor pointing all see the same stream they see in classic mode.

### Delegation (the thinker)

`session.delegation.created` carries an id but no task text. The core flushes his transcript into a `voice.final` right away, so **the cascade's own paths run on his words**: Jev addressing, reflex routing (music, outfit, browser, apps, work, `agency.runTask` for real tasks), and memory recall. `packages/core/src/live/delegation.ts` feeds the results back:

| What | Live event |
|---|---|
| Memory hits for his words | `session.thinking.append` (quiet facts) |
| Her "on it." before a task | `thinking` (the voice model acks on its own) |
| Task progress (`swarm.progress`, `task.start/done`) | `thinking` |
| Her answer, the task report, a result | `session.commentary.append` (spoken) |
| Agency's approval question | `commentary` as "ask him this and wait for his yes or no: ..." |
| Deep questions (explain, why, research, long questions), or no reply from the reflex within 6 s | `brains.frontier`, then `commentary` |
| Nothing to do (Jev: IGNORE) | `thinking` "nothing to do", then the delegation closes |

This follows OpenAI's semantics: commentary is what the model says aloud, thinking is context it uses without speaking. The task brief phrased it the other way round. We went with the docs because progress spoken aloud every few seconds is noise, and results are what he wants to hear.

**Approvals** still go through the existing agency gate. She asks in the live session, his "yeah" arrives as a live `voice.final`, and the gate's usual voice classifier approves it. A spoken interruption never cancels backend work. Late results still land, as session-wide commentary once the delegation has timed out (3 minutes).

**Her other lines.** While Live is on, the core wraps the `speech` service:
- Reflex's own direct replies to his live words are dropped without pulling the persona stream, so no LLM call is made. The voice model already answered.
- The cascade talker reports itself unavailable, so it doesn't make a parallel LLM call on every turn.
- Everything else goes to the voice model as commentary: ambient remarks, touch reactions, onboarding questions, task reports, and approvals. Her `[mood:x]` marks still set her face.
- With the classic engine, the wrapper passes everything straight through.

### Cost guard

gpt-live-1 bills **$0.05/min for every second the session is open**, silence included. The core counts the larger of the provider's cumulative `usage.seconds` and the wall clock, per local day, in `~/.eve/live-usage.json`.
- **Near the cap** (2 minutes before `EVE_LIVE_DAILY_MIN`): she says she's almost out of live minutes.
- **At the cap:** the engine switches to classic (`voice.engine by:"cost"`, `live.state capped`) and Live is refused until tomorrow.
- **When idle:** after `EVE_LIVE_IDLE_MIN` quiet minutes the session closes (`live.state idle`). The page keeps a local voice-activity detector on the mic. When he talks, it reopens the session and replays his first ~1.5 s, so the first words aren't lost.

At the default 60 min/day, the cap is $3/day at most.

### Failure states

| Situation | What happens |
|---|---|
| No keys | The toggle refuses: `no_access`, "Eve Live needs OpenAI or gateway credits (no AI_GATEWAY_API_KEY or OPENAI_API_KEY)" |
| Gateway 402 / blocked model / credits error on the socket | Tries OpenAI if there's a key. Otherwise `no_access` with the provider's words, falls back to classic (`voice.engine by:"fallback"`), and she says so in her classic voice |
| OpenAI 429 `insufficient_quota` | Same |
| Connection drops mid-session | Retries with backoff. After 3 failures, falls back to classic with the reason |
| No overlay or shell open | `connecting`, "waiting for the overlay or shell". Connects when a page says hello |

The tray title shows the state (`Voice engine: Classic (Live needs credits)`), and the submenu shows the reason and today's minutes. `GET /api/live` has it all.

## A/B it

1. Talk in classic for a few minutes: interrupt her, ask her to do something, ask a real question.
2. Say "switch to live mode". She confirms in the live voice.
3. Do the same things. Things to listen for:
   - talking over her
   - backchannels
   - how fast she takes the turn
   - whether delegated answers still sound like her
   - whether approvals still work
4. Say "go back to classic".
5. Try other voices: `EVE_LIVE_VOICE=marin` (or `quartz`, `willow`), then toggle Live off and on.

## Measured (real gateway, 2026-09-26)

Setup: `smoke.ts` on AI Gateway (`openai/gpt-live-1`, voice `gleam`). The input was two questions recorded with macOS `say`, streamed at real time as 20 ms PCM frames. Two runs of about 20 s billed each.

| Step | Time |
|---|---|
| Mint client secret | 184 ms |
| WebSocket open | ~440 ms |
| `session.started` | ~1.3 s after the core started connecting (mint + socket + start) |
| Chit-chat: end of his audio to her first voiced audio | 1.40 s, 1.32 s |
| Chit-chat: end of his audio to her first transcript | 0.9 to 1.2 s |
| "Can you play our song for me": `session.delegation.created` | 1.20 s |
| First commentary back | 2.0 s (Jev, reflex ACT, `agency.act music.play`, her line) |
| Close (`session.close` to `session.closed`) | 0.7 to 0.8 s |

On the delegation turn she said "mm, one sec" herself, got the memory thinking ("his song with her is Pink + White"), and answered "Yeah, 'Pink and White,' right? Cueing it up." while `music.play` ran.

Caveats on the numbers:
- The `say` clips end with some trailing silence, and the 20 ms timer pacing adds jitter, so the true end-of-speech latency is somewhat lower than what's shown. OpenAI quotes 0.8 s turn-taking.
- The Live socket streams audio continuously, silence included, so "first audio" means the first chunk with RMS above 0.01.
- A standalone probe measured 785 ms from an instruction append to her first audio.

OpenAI direct (WebRTC) was not measured: the key is at 0 credits (429).

## Tests and smoke

- `bun test packages/core/test/live.test.ts` runs hermetically against a fake gpt-live-1 server (`packages/core/src/live/testing.ts`: client secrets, the Live WebSocket, WebRTC create, event shapes from the docs and a real probe) and a headless page (`headless.ts`). It covers:
  - session config assembly
  - the delegation round trip (music ACT, deep question through the frontier, runTask with progress and report)
  - a spoken approval through the real agency gate
  - bus parity
  - the talker standing down
  - tray toggle teardown and startup
  - the spoken switch
  - no-credits fallbacks (mint, socket, OpenAI quota)
  - the cost cap
- `bun test apps/shell/src/live apps/overlay/src/live.test.ts` covers the page half (PCM, play clock, wake detector, relay) and the tray.
- `bun run packages/core/src/live/smoke.ts --env ../../.env [--voice gleam] [--dump her.pcm]` runs against the real gateway: two spoken questions, about 30 s billed. `ffplay -f s16le -ar 24000 -ac 1 her.pcm` plays her side back.
