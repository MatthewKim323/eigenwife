# Avatar + voice

Eve's face, body, voice and ears in the shell. Owner paths: `apps/shell/src/avatar/**`, `apps/shell/src/voice/**`, `apps/shell/src/scenes/Emergence.tsx`, `apps/shell/public/avatar/**`.

![emergence](screens/avatar-emergence-card.png)

| | |
|---|---|
| ![idle](screens/avatar-idle.png) | ![happy](screens/avatar-happy.png) |
| ![annoyed](screens/avatar-annoyed.png) | ![speaking](screens/avatar-speaking.png) |
| ![thinking](screens/avatar-thinking.png) | ![listening](screens/avatar-listening.png) |

## Live2D Eve

- **Stack:** `pixi.js@6.5.10` + `pixi-live2d-display@0.4.0` (pinned exactly, v7/v8 break it). Only the `cubism4` entry is imported.
- **Cubism core** (`public/avatar/live2dcubismcore.min.js`, 5.1.0) is fetched from the official distribution (`cubism.live2d.com/sdk-web/cubismcore/`) and injected as a global `<script>` *before* `pixi-live2d-display` is dynamically imported (`avatar/live2d.ts`).
- **Model:** Hiyori from the official `Live2D/CubismWebSamples` repo (`Samples/Resources/Hiyori`), in `public/avatar/hiyori/`. License: Live2D Open Software License + the Free Material License for sample data. Free for individuals and small orgs (annual revenue under 10M JPY); larger businesses need a Cubism SDK Release License. Fine for a hackathon demo, check before commercial use.
- **One canvas for her whole life.** `AvatarLayer` renders a fixed 560x840 transparent WebGL box above every scene and moves it with a transform spring (card, center stage, right column). The canvas is never re-laid out or re-created.
- **Built-ins off:** expression manager and eye blink nulled, `internalModel.breath` deleted, `updateNaturalMovements` no-op. `internalModel.updateFocus` is replaced by our rig, so it runs after motions and *before* physics: hair and ribbons react to our head turns in the same frame. `model.focus()` is never used.
- **Errors:** `app.render` and `model.update` are wrapped; on a throw the ticker stops and the tachie takes over.

### Per-frame pipeline (`avatar/rig.ts`)

`motion -> emotion pose -> blink -> look-at -> mouth -> breath`, every frame:

| Stage | Numbers |
|---|---|
| Blink (`motion-math.ts`) | interval 3-8s, close 75ms ease-out, open 150-300ms ease-in, 15% double blink. Multiplies the pose's eye-open value and only writes during a blink, so it can't feed back. Forced blink on waking and on "surprised". |
| Saccades | every 0.8-4.8s (triangular, mode 2s), small targets (0.16 x 0.1), head follows at 0.5x, eyes lerp 0.3/frame (frame-rate corrected). Paused while thinking/asleep. |
| Look-at | spring per axis, `k = 30 + 190 * follow`, `zeta = 1 - 0.75 * inertia` (follow 0.5, inertia 0.4). Head 30deg, body 10deg, 4ms substeps. Plus incommensurate-sine idle sway. |
| Emotion (`emotion.ts`) | pose table below, blended with easeInOutCubic over 450ms, weights capped at 0.78, transient moods auto-return after 3s (or `holdMs`), state moods (thinking) sustain. Happy adds a decaying head bob. |
| Mouth | `max(pose mouth, lipsync)`; forced to 0 during the post-speech hold and while asleep. |
| Breath | `ParamBreath` 0..0.5, 2s cosine then 1.2s rest (1.8x slower asleep). |

Emotion poses (Hiyori has no expressions). Absolute values lerp, `+` values add:

| Mood | Params |
|---|---|
| happy | EyeSmile 1, MouthForm 1, Cheek 1, EyeOpen 0.7, MouthOpenY 0.18, BrowY 0.3, AngleZ +6, bob |
| annoyed | EyeOpen 0.55, BrowForm -1, BrowAngle -0.6, MouthForm -0.6, AngleX +15 (away), EyeBallX -0.45 (eyes stay on you) |
| thinking | EyeBallX 0.6, EyeBallY 0.7, AngleZ +8, AngleY +4, MouthForm -0.2 |
| surprised | EyeOpen 1.2, BrowY 1, MouthOpenY 0.4, AngleY +5 |
| smug | EyeOpen 0.62, EyeSmile 0.6, MouthForm 0.7, one brow up, AngleZ -7, AngleY -4 |
| sad | EyeOpen 0.65, BrowForm 0.8, BrowAngle 0.7, MouthForm -0.8, AngleY -8, EyeBallY -0.4 |

### States (`avatar.state`, resolved in `AvatarLayer`)

Effective state = emergence override > `speaking` (while audio plays) > world `companion.state`.

- **sleeping** (before birth): eyes shut, head down, slow breath, desaturated.
- **idle / reacting:** look at the user, saccades, blinks.
- **listening:** head tilt + lean, a soft glow at her ear.
- **thinking:** thinking pose sustained, eyes up-side, saccades paused, three dots orbit above her head.
- **speaking:** lipsync + tiny nods on loud syllables.
- **acting:** eyes held on the swarm: `[data-eve-look="swarm"]`, else the first `[data-gaze^="swarm"]`, else left-center.

### Shared attention (the hook)

She looks at the user by default: out of the screen toward the webcam (top-center), leaning toward screen center. When `gaze.target` changes she glances at that element's on-screen center (`document.querySelector([data-gaze="key"])`) for 800ms, then back to you (min 1.1s between glances so she doesn't twitch). `avatar.look { targetKey, ms }` does the same on request (`targetKey: null` cancels).

### Tachie fallback

If Live2D hasn't rendered within 4s (or throws), `Tachie` shows stills: `public/avatar/tachie/{mood}.webp` plus `{mood}-blink.webp` and `{mood}-talk.webp` for all 7 moods, with a CSS bob, a blink overlay driven by the same blink scheduler, and the talk frame when the mouth is open. If Live2D finishes loading late, she upgrades to it. Force it with `?eve=tachie`.

The stills are rendered from the live rig so she looks identical: open `?scene=emergence&mic=0` in a GPU Chromium, call `__eve.hush()`, then per mood `__eve.state("idle"); __eve.still(true, eyesClosed, mouth); __eve.mood(m, 1, 600000)` and take an element screenshot of `.eve-box` with a transparent background, then `cwebp -q 86 -alpha_q 90`.

## Emergence (`scenes/Emergence.tsx`)

Timeline from mount (`T` in the file):

| ms | Beat |
|---|---|
| 0 | Card fades up (persona from `world.companion.persona` / `preference.converged`, fallback Eve). She is asleep *in* the card, her box docked so her head bleeds ~5rem above the frame: mask = `linear-gradient(11deg)` + radial fade. Her voice is gated. |
| 1500 | Wakes: eyes open with a blink, brief surprise. |
| 1900 | Mask dissolves (950ms easeInOutCubic). |
| 2700 | Glitch: RGB split, skew twitch, flicker (460ms). |
| 3160 | She springs from the card to center stage (bounce 0.22, the only overshoot in her life), the card shatters into 24 shards rippling out from her, happy. |
| 4000 | Voice un-gated: her birth line plays with subtitles. Offline (no core), she is born locally and says the fallback line through speechSynthesis. |
| end | When the birth line (first `speech.begin` after mount) finishes playing, +900ms, `go("desktop")` and she glides into the right column. No line within 6s: go anyway. Hard cap 20s. |

## Voice playback (`voice/`)

- **One AudioContext** (`voice/audio.ts`: `getAudioContext`, `unlockAudio`, `wireAudioUnlock`), stored on `globalThis.__eveAudioCtx`. The first pointerdown/keydown anywhere unlocks it and starts the mic. Anyone else needing audio should import from here (or re-export it from `lib/audio.ts`).
- **Queue** (`queue.ts`): strict FIFO by `(utteranceId, seq)`. Utterances play in arrival order, seqs in order. **seq starts at 0.** A missing seq is skipped after 400ms (first segment) / 1.5s (later), or immediately once `speech.end` arrived. Late segments of aborted utterances are dropped.
- **Audio path:** `audioUrl` fetched the moment the segment arrives (prefetch), relative URLs are prefixed with `CORE_HTTP`, decoded, played through an `AnalyserNode` (the lipsync tap). `speech.played` per segment.
- **speechSynthesis path** (segments without `audioUrl`, currently most of them): first-class. Voice ranking in `synth.ts`: Samantha > Google US English > Microsoft Aria/Jenny/Ava > Ava/Zoe/Allison/Susan..., `(Premium)/(Enhanced)/Natural` variants first, novelty voices never. Override with `?voice=<name>`. Rate 1.04, pitch 1.15. Mouth = word-boundary pulses (sized by `charLength`) times a 5.6Hz syllable oscillator, gated by onstart/onend; voices that report no boundaries get steady chatter. Marks fire by boundary `charIndex` (time-based fallback after 700ms without boundaries, leftovers at the end). Subtitles follow the boundaries.
- **Abort:** `speech.stop`, `speech.end {interrupted}`, or a barge-in cancels the current source / synth, clears the queue and all mark timers.
- **Marks:** `SpeechMark.at` is a char offset; with audio they fire at `at / text.length * duration`. Mood marks are dispatched locally as `avatar.mood` (not sent to the core).
- **Lipsync:** `mouth = min(0.7, rms^0.7 * 4.2)`, ~120ms smoothing, noise gate 0.012; after speech a 200ms release, then the mouth is held at 0 for 500ms.
- **Subtitles** (`Subtitles.tsx`): grapheme pop-in (Intl.Segmenter), words never break mid-line, white Quicksand with a thick dark stroke (`paint-order: stroke fill`). Earlier segments of the same utterance stay dimmed; fades 2.2s after she stops.

## Speech recognition (`voice/recognition.ts`, `turn.ts`)

- Chrome `webkitSpeechRecognition`, continuous + interim, auto-restarts on end/no-speech/network errors.
- Emits `voice.partial` on every change and `voice.final` when the interim text has been stable for **650ms** (or the engine finalizes first). Results already committed are never re-sent.
- **Half-duplex:** while she's speaking (and 600ms after), speech under 3 words is dropped. **3+ words = barge-in:** she stops locally at once and the shell emits `speech.stop {reason: "barge-in"}` plus the partial.
- **Push-to-talk:** hold **Space** (ignored while typing in inputs). Forces listening even while she talks; releasing commits immediately. Operator fallback when the room is noisy.
- **Mic lamp** under her: green pulse = listening, accent = PTT, orange = unsupported/blocked/off. Shows what it's hearing.
- Unsupported browsers (Safari/Firefox) degrade to a lamp that says so; everything else works. `?mic=0` disables the mic.
- **Use headphones for the demo.** Speaker output bleeds into the mic; the half-duplex gate hides most of it, but without headphones her own voice can trip a barge-in.

## Contracts for other builders

- Tag anything she might glance at with `data-gaze="<key>"` (the gaze bridge already requires this). `data-eve-look="swarm"` marks where she watches while `acting`.
- `AvatarLayer` is `position: fixed; z-index: 40; pointer-events: none`. On desktop/swarm/architecture she occupies the right ~440px column (box bottom ~70px above the viewport bottom, subtitles + mic lamp in the bottom 70px): keep that column free of important UI.
- She only renders once `world.companion.born` (or on the emergence scene).
- Core `speech` module: emit `speech.begin`, then `speech.segment` with seq from 0, then `speech.end`. `audioUrl` may be absolute or a core-relative path.
- `voice.final` comes from the shell; `speech.stop` may come from the shell (barge-in).
- Emergence owns the scene change to desktop; the core should just emit `companion.born` and her line.

## Debug handle

`window.__eve`: `mood(m, intensity, holdMs)`, `state(s | null)`, `look(x, y, ms)`, `blink()`, `say(text, mood?)` (local, speechSynthesis), `hush()`, `still(on, eyesClosed, mouth)`, `runtime`.

## Tests

`bun test apps/shell/src`: blink scheduler, saccade scheduler, spring, emotion blend/cap/auto-return, breath, attention glances, lipsync envelope, fake mouth, mark timing + mark cursor, segment queue ordering/gaps/abort, turn-commit debounce, half-duplex gate, voice ranking.
