# Voice harness research: what Eve should talk through

Date: 2026-09-26. Scope: speech-to-speech and cascade voice harnesses for Eve (Live2D avatar, amplitude lipsync, mid-conversation tool calls into the agency module, Jev reflex layer, memory). All numbers are vendor-stated unless marked "measured". Sources are linked inline and collected at the bottom.

## TL;DR

- **"gpt live 1" is real.** The exact id is `gpt-live-1` (OpenAI API, GA as of 2026-09-10), and `openai/gpt-live-1` on Vercel AI Gateway. It is a separate family from the Realtime models (`gpt-realtime-2`, `gpt-realtime-2.1`, `gpt-realtime-2.1-mini`). It is full-duplex, costs a flat **$0.05/min ($3/hr) billed per second including silence**, reports **0.80s turn-taking latency** (vs 1.41s for gpt-realtime-2.1), and is built around **delegation**: the voice model talks, your backend does tools and reasoning. That shape maps almost 1:1 onto Eve's Jev + agency split.
- **The catch for Eve:** GPT-Live (and every speech-to-speech model) speaks in its own voice. No ElevenLabs voice `2bk7ULW9HfwvcIbMWod0`. OpenAI custom voices exist but need eligibility plus a consent recording from a real speaker, which does not fit a designed ElevenLabs voice.
- **Most of the current 2 to 3.5s is self-inflicted.** The persona LLM runs through a spawned `claude -p --model haiku` process, STT uses a fixed 300ms silence endpoint, and the stages run serially. Fixing those gets the cascade to roughly 0.9 to 1.3s without changing Eve's voice.
- **Recommendation:** Phase 1 (now): fix the cascade (Flux STT with eager end-of-turn, streaming Messages API instead of the CLI, Jev in parallel, prewarmed TTS socket, instant acks). Phase 2 (behind a flag): an "Eve Live" talker on `gpt-live-1` with client delegation into the existing Jev/agency/memory stack, then A/B it by ear. Details in the last section.

## 1. OpenAI

### 1a. GPT-Live (`gpt-live-1`): the thing matt asked about

| Field | Value |
| --- | --- |
| Model id | `gpt-live-1` (OpenAI), `openai/gpt-live-1` (AI Gateway) |
| Released to API | 2026-09-10 ([OpenAI community announcement](https://community.openai.com/t/introducing-gpt-live-1-in-the-api/1396471)) |
| Endpoint | Live endpoint only: `v1/live/sessions`. Not Chat Completions, Responses or Realtime ([model page](https://developers.openai.com/api/docs/models/gpt-live-1)) |
| Transports | WebRTC (browser), WebSocket (server), SIP (phone) ([guide](https://developers.openai.com/api/docs/guides/live)) |
| Price | $0.05/min, billed per second, includes silence, mute, and time waiting on backend work. Backend model and tool calls billed separately ([model page](https://developers.openai.com/api/docs/models/gpt-live-1), [Vercel GPT-Live docs](https://vercel.com/docs/ai-gateway/modalities/realtime/gpt-live)) |
| Latency | 0.798s turn-taking latency vs 1.41s for gpt-realtime-2.1 (OpenAI benchmark) |
| Other benchmarks | 80.1% Full-Duplex-Bench interactivity (vs 45.4% gpt-realtime-2.1), 87% tool-calling success (vs 60%), 83.6% Tau3 ([tbreak](https://tbreak.com/openai-gpt-live-1-api/), [community post](https://community.openai.com/t/introducing-gpt-live-1-in-the-api/1396471)) |
| Turn detection | Model-owned. It listens while speaking, backchannels ("mhmm", "yeah"), decides itself when to stop. No VAD knobs ([LiveKit plugin docs](https://docs.livekit.io/agents/models/realtime/plugins/gpt-live/)) |
| Voices | 12 built in (Quartz, Ripple, Vesper, Willow, Stone, Gleam, Meridian, Bossa, Tempo, Beacon, Delta, Cinder, plus `marin` referenced by LiveKit). Custom voices via `{"id": "voice_..."}`. Voice cannot change after session start |
| Tools | "Delegation" rather than classic function calls. Two modes: **Responses delegation** (OpenAI runs a backend model, GPT-5.5 / GPT-6 Astra class, plus your function tools) or **client delegation** (your code/agent does the work) |
| Context | Startup history max 128 messages and 8192 tokens, append-only mid-session, separate instructions for voice and backend ([LiveKit](https://docs.livekit.io/agents/models/realtime/plugins/gpt-live/)) |
| Rate limits | Concurrent sessions: Tier 1 = 25 up to Tier 5 = 500 |
| Known rough edges (dev reports) | No `session.update` or `response.cancel`, awkward conversation endings, duplicated `response.completed` events, backend context limits on long chats ([community thread](https://community.openai.com/t/introducing-gpt-live-1-in-the-api/1396471)) |

**How client delegation works (the important part for Eve).** From the [Vercel GPT-Live docs](https://vercel.com/docs/ai-gateway/modalities/realtime/gpt-live):

- Connect `wss://ai-gateway.vercel.sh/v1/live/sessions`, send `session.start` with `{ model, store: false, delegation: { type: "client" }, audio: { format: { type: "audio/pcm", rate: 24000 } }, instructions }`, wait for `session.started`.
- Stream mic as base64 PCM16 24kHz mono in 20ms chunks via `session.input_audio.append`.
- Receive `session.output_audio.delta` (base64 PCM16 24kHz), `session.output_transcript.delta` and `session.input_transcript.delta` (both with `start_ms`/`end_ms`).
- When the model decides it needs help it emits `session.delegation.created` with an id but **no task description**. You reconstruct the task from the transcript deltas plus app state.
- You answer with plain text, max 500 tokens per append:
  - `session.thinking.append`: facts/progress the model can use without speaking now (also `delegation_id: null` for session-wide context such as memory or screen state).
  - `session.commentary.append`: a result the model should say aloud.
  - `session.instructions.append`: steer behavior mid-session.
- A spoken interruption does not cancel your backend work. Cancellation and late results are your job.
- Close with `session.close`, read `session.closed.usage.seconds`.
- AI Gateway specifics: WebSocket only (no WebRTC, no sideband), client delegation only, browser auth via `POST /v1/realtime/client-secrets` with `routeKind: "live"`, token passed as subprotocols `ai-gateway-realtime.v1` and `ai-gateway-auth.<token>`. Requires a team with AI Gateway credits. `@ai-sdk/openai@4.0.67` has a native Live codec (`openai.experimental_realtime('gpt-live-1', { api: 'live' })`); `@ai-sdk/gateway@4.0.82` has no Live helper yet.

Prompting guidance from OpenAI ([Prompting GPT-Live](https://developers.openai.com/api/docs/guides/live-prompting)): describe role, tone and pace in a few sentences; write an explicit "delegate when / do not delegate when" policy; "Delegate before giving an answer that depends on backend work. Do not guess the result while waiting." You can prompt it to acknowledge while delegated work runs.

### 1b. Realtime API (`gpt-realtime-2`, `gpt-realtime-2.1`, `gpt-realtime-2.1-mini`)

| Model | Released | Audio in / out per 1M tokens | Approx per minute |
| --- | --- | --- | --- |
| `gpt-realtime-2` | 2026-05-07 | (superseded by 2.1 pricing) | |
| `gpt-realtime-2.1` | 2026-07-06 | $32 / $64 | ~$0.019/min heard, ~$0.077/min spoken, typical agent $0.06 to $0.11/min with caching |
| `gpt-realtime-2.1-mini` | 2026-07-06 | $10 / $20 | typical $0.02 to $0.05/min with caching |

Sources: [community announcement](https://community.openai.com/t/new-realtime-models-on-the-api-gpt-realtime-2-1-and-gpt-realtime-2-1-mini/1385896), [DataNorth](https://datanorth.ai/news/openai-releases-gpt-realtime-2-1-voice-models), [layer3labs cost math](https://www.layer3labs.io/guides/openai-realtime-api-pricing) (600 tokens per user minute, 1200 per assistant minute). Uncached long sessions reach $0.18 to $0.46/min because the whole conversation is re-billed each turn.

- Classic function calling, **parallel tool calls**, **preambles** ("let me check that") built in, adjustable reasoning effort (minimal to xhigh, default low), 128K context ([therundown](https://www.therundown.ai/tools/gpt-realtime-2), [buildfastwithai](https://blog.buildfastwithai.com/openai-gpt-realtime-2-voice-ai-models)).
- 2.1 claims p95 latency down 25%+, better interruption, noise and alphanumeric handling.
- Turn detection: `server_vad` (threshold, prefix_padding_ms, silence_duration_ms) or `semantic_vad` with eagerness `low | medium | high | auto`, plus `create_response` and `interrupt_response` flags ([VAD guide](https://developers.openai.com/api/docs/guides/realtime-vad)).
- Transports: WebRTC, WebSocket, SIP. Output audio is PCM you can tap for lipsync (WebRTC gives a MediaStream you can feed to an AnalyserNode).
- On AI Gateway: `openai/gpt-realtime-2` through `gateway.experimental_realtime` + AI SDK `experimental_useRealtime`. Gateway limits: 25 min max session, 5 min idle timeout, 256KB max message, no resume on reconnect ([Vercel realtime docs](https://vercel.com/docs/ai-gateway/modalities/realtime)).
- Verdict: half-duplex, 1.41s turn latency per OpenAI's own GPT-Live comparison, pricier than GPT-Live for chatty use. GPT-Live supersedes it for a companion.

## 2. Google Gemini Live API

| Field | Value |
| --- | --- |
| Model ids | `gemini-3.8-live`, `gemini-3.8-live-extended-thinking` (released 2026-09-15). On AI Gateway: `google/gemini-3.8-live`, `google/gemini-3.8-live-extended-thinking` (the latter needs `thinkingLevel` or `thinkingBudget`) |
| Price | $3 / $12 per 1M audio tokens in/out, about **$0.005/min input, $0.018/min output** ([Google blog](https://blog.google/innovation-and-ai/technology/developers-tools/build-real-time-voice-applications-gemini-audio/), [MarkTechPost](https://www.marktechpost.com/2026/09/15/google-releases-gemini-3-8-live-and-3-8-live-extended-thinking-for-production-grade-voice-agents/)). Vercel's model page lists $0.75 / $4.5 per 1M tokens (probably text tokens), verify on your bill ([Vercel](https://vercel.com/ai-gateway/models/gemini-3.8-live)) |
| Quality | Extended Thinking is #1 on the Artificial Analysis speech-to-speech index (82.6); 3.8 Live is #2 on Speech Agent Arena |
| Tools | **Asynchronous function calling**: acknowledges, keeps talking, runs tools in the background; incremental content updates to merge tool results into ongoing audio |
| Native audio | Affective dialog (adapts tone to user's expression), proactive audio (model can choose not to respond), barge-in, 97 languages with mid-conversation switching ([Live API docs](https://ai.google.dev/gemini-api/docs/live)) |
| Audio formats | In: PCM16 16kHz. Out: PCM16 24kHz. Stateful WSS |
| Sessions | Audio-only 15 min without compression, connection lifetime ~10 min, context window compression for unlimited length, session resumption handles valid 2h, `GoAway` warning with `timeLeft` ([session docs](https://ai.google.dev/gemini-api/docs/live-session)) |
| Custom voices | None documented (prebuilt voices only) |
| Latency | Not published for 3.8. Independent numbers pending |

Verdict: cheapest by a wide margin and the best benchmarked audio quality, async tools are exactly the "keep talking while the tool runs" behavior Eve wants. Downsides: preset voices only, session plumbing (10 min connection lifetime), and it is still half-duplex style turn-taking versus GPT-Live's backchannels.

## 3. ElevenLabs Agents Platform (ElevenAgents)

- **Uses matt's voice directly** (`2bk7ULW9HfwvcIbMWod0`). This is the only managed harness that keeps Eve's current voice with zero work.
- TTS options: Flash v2.5 (~75ms model TTFB) or **Eleven v3 Conversational** (~280ms TTFB, "Expressive mode" on by default: emotion and emphasis adapt to how the user sounds) ([expressive mode](https://elevenlabs.io/docs/eleven-agents/customization/voice/expressive-mode), [layer3labs](https://www.layer3labs.io/guides/elevenlabs-agents-review)).
- Turn-taking: proprietary model using Scribe v2 Realtime signals (pauses, "um", breaths, emotional cues).
- LLM: pick a hosted model (Claude Haiku 4.5 is listed and recommended for voice) or **custom LLM** endpoint (OpenAI-compatible URL you host) ([custom LLM](https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm)). A custom LLM endpoint could be Eve's own persona server, so Jev and memory stay in the loop.
- Tools: **client tools** registered in the JS/React SDK (`clientTools: { name: async (params) => ... }`), with optional "wait for response" ([client tools](https://elevenlabs.io/docs/agents-platform/customization/tools/client-tools)); server webhook tools; MCP.
- Dead air: **soft timeout** speaks a filler ("Hmm...") when the LLM is slow, with `additional_soft_timeout_messages` (up to 7), `randomize_fillers`, `max_soft_timeouts_per_generation`, or `use_llm_generated_message` ([changelog](https://elevenlabs.io/docs/changelog)).
- Context injection: `contextual_update` client event injects text without interrupting (memory, screen state, tool progress).
- **Lipsync: best in class.** WebSocket `audio` events carry `alignment` with `chars`, `char_start_times_ms`, `char_durations_ms` ([WebSocket reference](https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket)), and the SDK exposes `getOutputVolume()` / `getOutputByteFrequencyData()` (voice band 100 to 8000Hz) ([React SDK](https://elevenlabs.io/docs/eleven-agents/libraries/react)). Character timing can drive vowel shapes, not just open/close.
- Price: $0.08/min over plan (burst $0.16), LLM billed separately. Plans: Pro $99 = 1,238 min, Scale $299 = 3,738 min, Business $990 = 12,375 min ([pricing](https://elevenlabs.io/pricing/agents)).
- Not on AI Gateway.

Verdict: strongest "keep the voice, outsource turn-taking" option, but it is the most expensive at Eve's usage and the whole conversation loop lives in ElevenLabs' cloud (Jev becomes a custom-LLM proxy, not a reflex layer that sees raw partials).

## 4. Deepgram

**Voice Agent API** (one WebSocket: listen, think, speak, function calling, barge-in, BYO LLM and TTS) ([docs](https://developers.deepgram.com/docs/voice-agent)). Pricing ([deepgram.com/pricing](https://deepgram.com/pricing)), pay as you go:

| Tier | $/min |
| --- | --- |
| Standard | 0.075 |
| Standard, BYO TTS | 0.065 |
| Custom, BYO LLM + TTS | 0.050 |
| Advanced | 0.163 |

The more useful Deepgram news for Eve is component-level:

- **Flux STT** (`flux-general-en`, `flux-general-multi`, endpoint `/v2/listen`): transcription and turn detection in one model, ~260ms end-of-turn detection. Events `StartOfTurn`, `EagerEndOfTurn`, `TurnResumed`, `EndOfTurn`; params `eot_threshold` (default 0.7), `eager_eot_threshold` (off by default, 0.3 to 0.9), `eot_timeout_ms` (default 5000) ([Flux quickstart](https://developers.deepgram.com/docs/flux/quickstart)). $0.0065/min. Eager EOT raises LLM calls 50 to 70% but lets you start the LLM speculatively.
- **Flux TTS** (launched 2026-08-12): conversation-aware, "as low as 80ms", $0.045/1k chars ([Deepgram](https://deepgram.com/learn/introducing-flux-tts-conversation-native-text-to-speech-for-real-time-voice-agents)). Aura-2 stays $0.030/1k chars, sub-200ms.

Verdict: Voice Agent API is fine but gives Eve nothing her own orchestrator does not already do. **Flux STT is the single highest-leverage swap in the current cascade** (it replaces the fixed 300ms `endpointing` in `packages/core/src/ears/deepgram.ts`).

## 5. Frameworks and other options

| Option | What it is | Notes for Eve |
| --- | --- | --- |
| **LiveKit Agents** (Apache-2.0) | WebRTC voice agent framework, Python/Node | Turn detector `MultilingualModel` (Qwen2.5-0.5B fine-tune, ~25ms CPU inference, ~400MB RAM, English + 13 langs) on top of Silero VAD; "dynamic" endpointing adapts delay to your pause stats. Tuned stacks drop from 1.2 to 1.4s p95 to 500 to 650ms p95 ([LiveKit docs](https://docs.livekit.io/agents/logic/turns/turn-detector/), [futureagi](https://futureagi.com/blog/how-to-optimize-livekit-latency-2026/)). Has a first-party **GPT-Live plugin** with both delegation modes. Cloud $0.01/min. Overkill for a local desktop app with one user, but its GPT-Live adapter is a good reference implementation |
| **Pipecat** (BSD-2) | Python pipeline framework | **Smart Turn v3**: open, ~8M params (Whisper Tiny + classifier), 12ms CPU inference ([Daily](https://www.daily.co/blog/announcing-smart-turn-v3-with-cpu-inference-in-just-12ms/)). Could run locally beside Eve as an audio-level end-of-turn check. Pipecat itself is Python; Eve is TS/Bun, so borrow the model, not the framework |
| **Vercel AI SDK realtime** | `experimental_useRealtime`, `experimental_realtime.getToken`, `onToolCall`, `addToolOutput` | Experimental. Providers: OpenAI `gpt-realtime`, Google `gemini-3.1-flash-live-preview`, xAI `grok-voice-latest`, Gateway `openai/gpt-realtime-2` ([AI SDK docs](https://ai-sdk.dev/docs/ai-sdk-core/realtime)). Hook owns playback, so lipsync access is not documented. No GPT-Live helper yet |
| **xAI Grok Voice Think Fast 2.0** | Speech-to-speech on AI Gateway | $0.08/min, 0.70s to first audio, tool calls "usually before the end of the first sentence" ([Vercel](https://vercel.com/ai-gateway/models/grok-voice-think-fast-2.0), [therundown](https://www.therundown.ai/tools/grok-voice-think-fast-2-0)). Fast, but preset voices and a persona that fights Grok's defaults |
| **Hume EVI** (EVI 3, EVI 4-mini) | Empathic speech-to-speech, Octave 2 TTS + supplemental LLM of your choice | ~$0.04/min, ~1.2s practical latency, custom voices (can switch `voice_id` mid-session), tools/webhooks ([Hume changelog](https://dev.hume.ai/changelog)). Nice emotion signals for the avatar (prosody scores), but slower than GPT-Live and custom voices are Hume voices, not ElevenLabs |
| **Ultravox v0.7** | Speech-native LLM (audio in, text out) + TTS | $0.05/min on Ultravox Realtime, Pipecat integration ([Ultravox](https://www.ultravox.ai/blog/introducing-ultravox-v0-7-the-world-s-smartest-speech-understanding-model)). Half-cascade: can pair with ElevenLabs voice. Interesting, but a third LLM persona to keep in sync |
| **Cartesia** Sonic-3.6 + Line | TTS (#1 on both Artificial Analysis speech arenas, sub-90ms TTFA) + agent platform | Line agents $0.06/min, Scale plan $299 ([Cartesia](https://www.cartesia.ai/launch), [MarkTechPost](https://www.marktechpost.com/2026/08/18/cartesia-ships-sonic-3-6-a-streaming-tts-model-that-now-leads-both-artificial-analysis-speech-arenas/)). Strong TTS alternative if Eve's voice is ever rebuilt; Line is another managed loop |
| **Sesame** | Best-sounding companion voice demo | **No production API.** Only open CSM-1B (TTS, no tools) is callable ([orcarouter](https://www.orcarouter.ai/blog/sesame-preview-android-launch)). Not an option |

## 6. Hybrid patterns (thinker/talker)

The industry converged on this split in 2026, and OpenAI productized it:

1. **Fast talker, slow thinker.** A low-latency voice model owns turn-taking, backchannels and small talk; a frontier agent owns tools and reasoning. GPT-Live's delegation, Gemini's async function calling, and the research frontend/backend design with delegation tokens and "prefill-and-repeat" of results ([arXiv 2609.19334](https://arxiv.org/abs/2609.19334)) are all this pattern. Eve already has it: Jev (reflex) + agency (thinker). Only the talker is slow.
2. **Keeping a custom personality.** Speech-to-speech models take a short persona prompt. What works: (a) keep the persona prompt short and voice-focused (tone, pace, verbal tics); (b) push memory as facts, not prose, into side channels (`session.thinking.append` with `delegation_id: null` for GPT-Live, `contextual_update` for ElevenLabs, system instruction + incremental content for Gemini); (c) seed the session with a compact startup history (GPT-Live: max 128 messages / 8192 tokens); (d) let the backend (which has full memory) author anything that needs "Eve-ness", and have the talker voice it via commentary.
3. **No dead air during tools.** Four layers, cheapest first: (a) instant local ack from a pre-rendered clip bank in Eve's voice ("mm, one sec", "okay checking") triggered by Jev's ACT decision, zero network; (b) model preambles (gpt-realtime-2 preambles, GPT-Live prompted acknowledgement, ElevenLabs soft timeout fillers); (c) progress updates as the tool runs (`session.thinking.append` then `session.commentary.append` when done); (d) avatar busy state (glance at screen, typing motion) so silence reads as intentional.
4. **Interruption vs background work.** Barge-in should stop audio, not tasks. GPT-Live explicitly leaves cancellation to you. Eve's agency already has spoken approvals, so keep task lifecycle in agency and only cancel on explicit "stop"/"never mind" classified by Jev.

## 7. Lipsync compatibility

Eve's lipsync (`apps/shell/src/voice/lipsync.ts`) is an RMS envelope: `mouth = min(0.7, rms^0.7 * 4.2)`, 120ms lerp. It only needs a PCM stream it can measure, so every option works:

| Option | Output | Lipsync path |
| --- | --- | --- |
| GPT-Live | `session.output_audio.delta` PCM16 24kHz + transcript deltas with `start_ms`/`end_ms` | Decode into an AudioWorklet/AudioBuffer queue, tap RMS as today. No visemes. Transcript timings allow rough vowel hints |
| gpt-realtime-2.x | PCM over WS, MediaStream over WebRTC | AnalyserNode on the stream |
| Gemini Live | PCM16 24kHz | Same as GPT-Live |
| ElevenLabs Agents | PCM chunks + per-character timing (`alignment`) + `getOutputVolume()` | RMS today; character timing enables real vowel shapes (A/I/U/E/O params on Live2D) later |
| Cascade (current) | ElevenLabs/Aura/Flux TTS audio | Unchanged. ElevenLabs TTS WebSocket also returns alignment, so the viseme upgrade is available in the cascade too |

None of the speech-to-speech models return visemes. Character alignment from ElevenLabs is the only phoneme-ish signal on the market here.

## 8. Where Eve's 2 to 3.5s actually goes

Current (measured by matt): STT endpoint ~300ms fixed silence + final, Jev 100 to 400ms, persona first token 1.3 to 2.4s, chunker waits for a sentence, TTS 150 to 250ms TTFB.

The persona stage dominates, and most of it is process overhead: `packages/core/src/brains/chat.ts` falls back to `claude-cli` (a spawned `claude -p --model haiku`) when there is no key, and Gateway fast models are blocked on the free tier. Claude Haiku 4.5 over the streaming Messages API has ~0.7s TTFT ([softcery](https://softcery.com/lab/ai-voice-agents-choosing-the-right-llm)), and the repo already has an `anthropic` backend (`claude-haiku-4-5-20251001`) that just needs `ANTHROPIC_API_KEY`.

## 9. Recommendation for Eigenwife

### Phase 1 (do now, 1 to 2 days): fix the cascade, keep Eve's voice

1. **Kill the CLI hop.** Run the persona on the streaming Anthropic Messages API (`ANTHROPIC_API_KEY`, existing `anthropic` backend) or put credits on AI Gateway so `anthropic/claude-haiku-4.5` / `google/gemini-3-flash` unlock. Use prompt caching on the persona + memory prefix. Saves ~0.7 to 1.5s.
2. **Swap Nova-3 + 300ms endpointing for Flux** (`flux-general-en`, `/v2/listen`, `eot_threshold` 0.7, `eager_eot_threshold` ~0.5). On `EagerEndOfTurn` start Jev and the persona speculatively; on `TurnResumed` abort; on `EndOfTurn` commit. Saves ~200 to 500ms on typical turns.
3. **Run Jev in parallel with the persona**, not before it. Start persona generation immediately; if Jev returns IGNORE, abort; if ACT/ESCALATE, let agency take over and play an ack clip. Hides Jev's 100 to 400ms.
4. **Ship the first clause, not the first sentence.** Flush the chunker at the first comma/clause over ~25 chars, and keep one prewarmed ElevenLabs Flash WebSocket per session (`eleven_flash_v2_5`, voice `2bk7ULW9HfwvcIbMWod0`). Optionally request alignment for future vowel lipsync.
5. **Instant acks.** Pre-render 10 to 20 short clips in Eve's voice ("mm", "okay", "one sec", "lemme check") and fire one on Jev ACT/ESCALATE and on any turn where the persona has not produced audio by ~700ms.
6. **Barge-in**: on Flux `StartOfTurn` while `speech.begin` is active, emit `speech.stop`, duck audio in <100ms, keep agency tasks alive.

Expected: ~0.9 to 1.3s end of speech to first audio (Flux EOT ~0.26s + Haiku TTFT ~0.6s with overlap + TTS ~0.1 to 0.25s), with acks covering tool turns at ~0.3s.

### Phase 2 (behind a flag, ~1 week): "Eve Live" talker on `gpt-live-1`

Why: it is the only option that is genuinely full-duplex (backchannels, overlapping speech, 0.8s turns), its delegation contract matches Eve's existing thinker split, and $3/hr is cheap. Why not default: it replaces Eve's ElevenLabs voice with one of 12 OpenAI voices, and dev reports show v1 rough edges. Let matt decide by ear.

Integration sketch (maps to existing bus events):

| GPT-Live event | Eve side |
| --- | --- |
| mic PCM16 24kHz 20ms chunks -> `session.input_audio.append` | replaces `ears` (Deepgram) as the audio sink; keep a local Silero/Flux VAD only for UI and barge-in ducking |
| `session.input_transcript.delta` | emit `voice.partial` / `voice.final`, feed Jev and memory exactly as today |
| `session.output_audio.delta` | playback queue -> lipsync RMS; emit `speech.begin` on first chunk, `speech.end` after drain |
| `session.output_transcript.delta` | emit `speech.segment` (captions, memory log) |
| `session.delegation.created` | build a task from the last N transcript deltas + screen/app state, hand to Jev (classify) then agency (execute, spoken approvals). Immediately send `session.thinking.append` "checking calendar" so the talker has something to say |
| agency progress | `session.thinking.append` with `delegation_id` |
| agency result | `session.commentary.append` with `delegation_id` (<=500 tokens, pre-summarized in Eve's voice by the persona model) |
| memory recall, mood, screen context | `session.thinking.append` with `delegation_id: null` on session start and on change |
| Jev ESCALATE with no delegation (Jev spotted an action the talker missed) | start the agency task anyway, then `session.instructions.append` or commentary to let the talker mention it |
| wake word / idle 60s | open / `session.close` (billing includes silence; do not leave sessions open) |

Session start: persona instructions (short, voice-focused), `delegation: { type: "client" }`, `store: false`, startup history of the last ~40 turns + a memory digest within 8192 tokens. Voice: pick the closest of the 12 by ear; revisit OpenAI custom voices only if a consenting human voice is ever used. Transport: Gateway WebSocket if credits exist, else direct OpenAI WebRTC from the Electron renderer (lower jitter than WS). Reference: LiveKit's GPT-Live plugin client-mode source.

Expected: ~0.8s turn latency, continuous backchannels, tool acks immediate; tool results still bounded by agency.

### Monthly cost at ~2 hours of talk per day (~60 hr, 3,600 min)

Assumes Eve speaks ~40% and the user ~40% of session time.

| Option | Est. monthly | Basis |
| --- | --- | --- |
| **Fixed cascade (Phase 1)** | **~$80 to $200** | Flux STT 3,600 min x $0.0065 = $23; ElevenLabs Flash ~1.3M chars (Pro/Scale plan tier, ~$99 to $165); Haiku 4.5 with prompt caching ~$20 to $40 (without caching ~$150+) |
| same with Deepgram Aura-2 TTS instead | ~$60 to $100 | Aura-2 1.3M chars x $0.03/1k = $39, but loses Eve's voice |
| **GPT-Live-1 talker (Phase 2)** | **~$190 to $230** | 3,600 min x $0.05 = $180 + Claude for delegation/persona summaries ~$10 to $50. Idle-open sessions add $3/hr |
| Gemini 3.8 Live | ~$40 to $100 | audio ~$1.4/hr ($84) worst case continuous in+out, less with real talk ratios; plus context tokens |
| gpt-realtime-2.1 | ~$220 to $400 | $0.06 to $0.11/min typical |
| gpt-realtime-2.1-mini | ~$70 to $180 | $0.02 to $0.05/min |
| ElevenLabs Agents | ~$580 to $990 + LLM | Scale $299 (3,738 min, just covers 3,600) up to Business $990; overage $0.08/min |
| Deepgram Voice Agent | ~$180 to $270 | $0.050 to $0.075/min |
| Grok Voice Think Fast 2.0 | ~$290 | $0.08/min |

Bottom line: do Phase 1 first. It likely gets Eve under ~1.2s for the cost of a weekend and keeps her voice. Then build Eve Live on `gpt-live-1` as a flag and let matt compare full-duplex feel against voice identity. If voice identity wins, ElevenLabs Agents with a custom-LLM pointing at Eve's persona server is the managed fallback, at roughly 3 to 5x the cost.

## Sources

- OpenAI GPT-Live 1 model page: https://developers.openai.com/api/docs/models/gpt-live-1
- OpenAI GPT-Live guide: https://developers.openai.com/api/docs/guides/live
- OpenAI GPT-Live prompting: https://developers.openai.com/api/docs/guides/live-prompting
- OpenAI GPT-Live 1 API announcement (community): https://community.openai.com/t/introducing-gpt-live-1-in-the-api/1396471
- GPT-Live 1 coverage: https://tbreak.com/openai-gpt-live-1-api/
- Vercel AI Gateway realtime: https://vercel.com/docs/ai-gateway/modalities/realtime
- Vercel AI Gateway GPT-Live: https://vercel.com/docs/ai-gateway/modalities/realtime/gpt-live
- Vercel realtime blog: https://vercel.com/blog/realtime-voice-agents-on-ai-gateway
- LiveKit GPT-Live plugin: https://docs.livekit.io/agents/models/realtime/plugins/gpt-live/
- OpenAI gpt-realtime-2.1 announcement: https://community.openai.com/t/new-realtime-models-on-the-api-gpt-realtime-2-1-and-gpt-realtime-2-1-mini/1385896
- DataNorth on gpt-realtime-2.1: https://datanorth.ai/news/openai-releases-gpt-realtime-2-1-voice-models
- gpt-realtime-2 features: https://www.therundown.ai/tools/gpt-realtime-2 , https://blog.buildfastwithai.com/openai-gpt-realtime-2-voice-ai-models
- Realtime cost math: https://www.layer3labs.io/guides/openai-realtime-api-pricing
- OpenAI VAD guide: https://developers.openai.com/api/docs/guides/realtime-vad
- OpenAI custom voices: https://developers.openai.com/api/docs/guides/custom-voices
- Google Gemini 3.8 Live launch: https://blog.google/innovation-and-ai/technology/developers-tools/build-real-time-voice-applications-gemini-audio/
- MarkTechPost on Gemini 3.8 Live: https://www.marktechpost.com/2026/09/15/google-releases-gemini-3-8-live-and-3-8-live-extended-thinking-for-production-grade-voice-agents/
- Gemini Live API docs: https://ai.google.dev/gemini-api/docs/live , https://ai.google.dev/gemini-api/docs/live-session
- Vercel Gemini 3.8 Live page: https://vercel.com/ai-gateway/models/gemini-3.8-live
- ElevenAgents pricing: https://elevenlabs.io/pricing/agents
- ElevenLabs client tools: https://elevenlabs.io/docs/agents-platform/customization/tools/client-tools
- ElevenLabs agents WebSocket: https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket
- ElevenLabs React SDK: https://elevenlabs.io/docs/eleven-agents/libraries/react
- ElevenLabs expressive mode: https://elevenlabs.io/docs/eleven-agents/customization/voice/expressive-mode
- ElevenLabs custom LLM: https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm
- ElevenLabs changelog (soft timeout): https://elevenlabs.io/docs/changelog
- ElevenLabs agents review (latency): https://www.layer3labs.io/guides/elevenlabs-agents-review
- Deepgram pricing: https://deepgram.com/pricing
- Deepgram Voice Agent: https://developers.deepgram.com/docs/voice-agent
- Deepgram Flux: https://developers.deepgram.com/docs/flux/quickstart
- Deepgram Flux TTS: https://deepgram.com/learn/introducing-flux-tts-conversation-native-text-to-speech-for-real-time-voice-agents
- Voice AI August 2026 roundup: https://futureagi.com/blog/best-voice-ai-august-2026/
- LiveKit turn detector: https://docs.livekit.io/agents/logic/turns/turn-detector/ , https://futureagi.com/blog/how-to-optimize-livekit-latency-2026/
- Pipecat Smart Turn v3: https://www.daily.co/blog/announcing-smart-turn-v3-with-cpu-inference-in-just-12ms/
- AI SDK realtime: https://ai-sdk.dev/docs/ai-sdk-core/realtime
- Grok Voice Think Fast 2.0: https://vercel.com/ai-gateway/models/grok-voice-think-fast-2.0 , https://www.therundown.ai/tools/grok-voice-think-fast-2-0
- Hume EVI: https://dev.hume.ai/changelog , https://www.hume.ai/empathic-voice-interface
- Ultravox v0.7: https://www.ultravox.ai/blog/introducing-ultravox-v0-7-the-world-s-smartest-speech-understanding-model
- Cartesia Sonic-3.6: https://www.cartesia.ai/launch , https://www.marktechpost.com/2026/08/18/cartesia-ships-sonic-3-6-a-streaming-tts-model-that-now-leads-both-artificial-analysis-speech-arenas/
- Sesame API status: https://www.orcarouter.ai/blog/sesame-preview-android-launch
- Frontend/backend tool calls in full-duplex models: https://arxiv.org/abs/2609.19334
- LLMs for voice (Haiku 4.5 TTFT): https://softcery.com/lab/ai-voice-agents-choosing-the-right-llm
