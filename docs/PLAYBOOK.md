# Build playbook

Concrete recipes for every layer of Eigenwife: what to build, the numbers to use, the traps, and rough hours. Companion to `SPEC.md`.

---

## 0. Decisions

| Question | Answer |
|---|---|
| Main stage | Fullscreen web shell we own (Vite + React). No Electron overlay unless there's spare time. |
| Avatar | Live2D, sample model **Haru** (adult receptionist; Hiyori was dropped, see AVATAR.md), via `pixi-live2d-display@0.4.0` on `pixi.js@6.5.10`. Tachie (PNG per emotion) as the safety net. |
| Voice out | ElevenLabs `eleven_flash_v2_5` for live lines, `eleven_v3` pre-renders for scripted demo lines. `kokoro-js` in-browser as fallback. |
| Voice in | Chrome Web Speech API. No VAD model today. |
| Bus | One websocket hub inside jabby (`Bun.serve`), port **7777**. `eye serve` stays on 8765. |
| Gaze to element | `elementFromPoint` + snap resolver (section 4). |
| Headphones | Mandatory for the demo (Web Speech ignores echo cancellation, she will hear herself). |

---

## 1. Event bus (jabby) · 2-3h · P0

Jabby has a turn engine, streaming voice, fact extraction, and memory lookup, but no bus. Add one.

**Envelope** (plain JSON so the Python tracker can speak it with zero deps):

```ts
interface Envelope<T = unknown> {
  type: string            // "gaze.fixation", "voice.final", "app.opened", "avatar.mood", ...
  ts: number              // ms epoch
  source: string          // "eye", "shell", "jabby", "swarm", "zo"
  id: string
  parent?: string         // causal link: reaction -> the event that caused it
  data: T
}
```

- Hub rebroadcasts everything to every client. Clients filter by `type` prefix.
- `parent` lets the diagnostics overlay draw "this reaction came from that fixation" lines for free.

**WorldState as context slots.** Each source owns named slots it can replace or append:

```ts
ctx.set("eye", "target", { id: "ramen-card-3", label: "Garlic Knockout Ramen $21" })   // replaces
ctx.push("voice", "recent", "that looks pretty good")                                   // appends, ring buffer
```

When prompting any LLM, render slots as bullets under a `Context` header. Keeps prompts small and every sensor pluggable.

---

## 2. Reflex layer (Jev) · 2-3.5h · P1

Nothing gates by default. The gate is ours:

1. **Perception rules** (declarative) turn raw events into candidate triggers with sliding windows:
   ```yaml
   - id: breakup-song-loop
     when: { type: media.play, match: { track: "$same" } }
     window: { count: 4, within: 30m }
     emit: { trigger: repeat_media, urgency: soon }
   - id: dating-app-relapse
     when: { type: app.opened, match: { app: "Eigen" } }
     after: companion.born
     emit: { trigger: relapse, urgency: immediate }
   ```
2. **Jev** scores the trigger plus context into `IGNORE | GLANCE | REACT | COMMENT | ASK | HELP | ACT | ESCALATE`.
3. **Urgency ticker**: queue of pending triggers, drained every 2s. `immediate` jumps the queue, `later` waits until the user is idle (no voice, gaze not on content for >3s).
4. **Silence as a tool.** When a persona model is asked to speak, give it a `stay_silent` tool. Two gates (Jev + model) keep her from being unbearable. Target 80-95% ignore.

---

## 3. Persona + speech stream · 2h · P0/P1

**Persona card** (JSON, generated from the Act I vector):

```json
{
  "name": "Eve",
  "description": "...", "personality": "...", "scenario": "...",
  "system": "...",
  "eigen": { "vector": {...}, "relationship": { "banter": 0.82, "warmth": 0.64, "initiative": 0.78, "verbosity": 0.28 } }
}
```

System prompt = `system + description + personality + scenario + Context bullets + retrieved memories`.

**Inline control marks** the model writes into its reply:

```
[mood:annoyed 0.7] Twenty-one dollars. [pause:0.6] For ramen?
```

- Allowed moods: `neutral, happy, annoyed, thinking, surprised`.
- **Streaming splitter**: scan chunks for `[`, hold back an incomplete tail so a mark split across chunks never gets spoken. ~50 lines.
- Marks travel **in the TTS queue alongside text chunks**, and fire when that chunk starts playing. Face changes land on the right word instead of before the audio.

**TTS chunking** (only matters for >1 sentence): split on `. ! ?`; for the first 2 chunks also split on `,` once there are >= 4 words; hard cap 12 words. Synthesize up to 4 chunks in parallel, play strictly in order.

---

## 4. Gaze to "this" · 1.5h · P0

The eye tracker gives ~100-200pt error, so never resolve a raw pixel.

**Snap resolver**:
1. Candidates = elements with `data-gaze` (we tag every card, dish, button).
2. If any candidate *contains* the point, pick the **smallest** one.
3. Else pick the nearest edge within **20px** (raise to ~80px for our big cards).
4. Require the same target on 2 consecutive fixations before emitting `gaze.target`.

**Give LLMs IDs, not coordinates.** Render visible targets as a numbered list (`[3] Garlic Knockout Ramen, $21, 4.6★`). The model answers with `target: 3`, and the shell does the pixel work. Same trick for computer-use: ranked target lists beat screenshots + coordinates.

Firecrawl fills the label text for each `data-gaze` element on page load, not per fixation.

---

## 5. Memory (Moss) · 1.5-2h · P0

**Record**:

```ts
{ id, kind: "episodic" | "preference" | "fact", content, embedding,
  importance: 0..1, confidence: 0..1, source, createdAt, lastRecalledAt }
```

**Retrieval score**:

```
score = 1.2 * cosine + 0.2 * recency + 0.3 * importance
recency = max(0, 1 - ageDays / 30)
keep score > 0.5, top 3-5
```

Update `lastRecalledAt` on hit, and flash `MEMORY · 4ms` with the recalled lines in the UI (the demo beat).

**Write policy**: only Jev or the fact extractor writes. Seed 6-10 memories for the demo (spicy food, saving money, $28 ramen complaint, works late) so recall is guaranteed.

---

## 6. Avatar · ~9h total, split across people · P0

**Setup (1h).** Load Cubism core as a global `<script>` *before* `pixi-live2d-display`. Pixi **v6 only** (v7/v8 break it). Load by URL to `*.model3.json`. Wrap `app.render` in try/catch and stop the ticker on error so one bad frame doesn't spam.

**Per-frame param pipeline (0.5h).** Every frame, in this order:
`motion -> emotion pose -> blink (multiplier) -> look-at -> mouth -> breath`.
Before starting: null the SDK's expression manager and eye blink, `delete internalModel.breath`, so the built-ins don't fight ours.

**Blink (0.5h).**
- Interval random **3-8s**. Close **75ms** ease-out, open **150-300ms** ease-in.
- It *multiplies* the current eye-open value from the emotion pose.
- Only write during a blink, and restore the exact pre-blink value after. Otherwise the multiply feeds back and eyes decay to closed.
- Occasional double blink (~15%) reads as alive.

**Saccades (0.5h).**
- Idle eye darts every **0.8-4.8s** (weighted toward ~2s), small random target.
- Head follows at **0.5x** the eye amplitude.
- Eyes lerp **0.3/frame** toward target.
- Pause saccades during `thinking`.

**Look-at (1h).**
- Spring toward the target: stiffness `k = 30 + 190 * follow`, damping ratio `zeta = 1 - 0.75 * inertia`.
- Or exponential smoothing `alpha = 1 - exp(-10 * dt)`.
- Don't use the library's `focus()`: it normalizes to direction and always turns the head fully. Drive the focus controller directly so glances can be small.
- `look_at_user` = top-center of viewport (where the webcam is).
- **Shared attention**: when `gaze.target` changes, she glances at the same element for ~800ms, then back to the user. Cheap, uncanny, huge.

**Breath.** `ParamBreath` 0 to 0.5, 2s cosine cycle, then 1.2s pause.

**Emotion poses (1.5h).** Poses are param overrides (with Haru, blended over her own expressions, see AVATAR.md):

| Mood | Params |
|---|---|
| happy | `EyeLSmile/RSmile 1`, `MouthForm 1`, `Cheek 1`, `EyeOpen 0.9`, slight `AngleZ` tilt + spring bob |
| annoyed | `EyeOpen 0.55`, `BrowLForm/RForm -1`, `MouthForm -0.6`, `AngleX` 15 away, eyes still on user |
| thinking | `EyeBallX 0.6`, `EyeBallY 0.7`, `AngleZ 8`, `MouthForm -0.2`, saccades paused |
| surprised | `EyeOpen 1.2`, `BrowY` up, `MouthOpenY 0.4` |

- Blend in over 0.3-0.6s (`easeInOutCubic` or the look-at spring).
- Cap weights at **0.7-0.8**, since full weight looks deranged.
- Auto-return to neutral after ~3s.

**Lipsync (1h).**
- Tap the same `AudioBufferSourceNode` that plays TTS with an `AnalyserNode`. `mouth = min(0.7, rms^0.7 * gain)`, 120ms lerp.
- After speech ends: 200ms release, then **hold mouth at 0 for 500ms**. Idle motions otherwise reopen the mouth.
- Browser `speechSynthesis` can't be tapped. Fallback: `0.15 + 0.55 * |sin(18t)| * noise` gated by `onstart/onend`.

**Emergence (2h).** Covered in section 8.

**Assets.**
- Haru comes from the official Live2D sample page (Free Material License). It covers individuals and small orgs.
- Tachie fallback: 5 PNGs (neutral/happy/annoyed/thinking/surprised), CSS bob + blink overlay.

---

## 7. Voice · ~3.25h · P1

1. **Wake click (0.25h).** Gaze doesn't count as a user gesture. The calibration screen's "start" click resumes the `AudioContext` and primes Web Speech.
2. **Playback queue (0.5h).** A single `AudioContext` and a FIFO of buffers, each started with an `AbortSignal`. New user speech aborts all.
3. **ElevenLabs proxy (0.5h).** Route through jabby (it has the key). Use `eleven_flash_v2_5` and stream MP3 chunks.
4. **Cache + pre-renders (0.5h).** Hash `(voice, text)` to a file. Pre-render every scripted line with `eleven_v3` audio tags (`[sighs]`, `[laughs]`). The demo should hit zero live TTS on the golden path.
5. **Lipsync tap (0.5h).** See section 6.
6. **STT (0.75h).**
   - Chrome `SpeechRecognition`, continuous + interim, with an auto-restart loop.
   - **Commit the turn when interim text is unchanged for 650ms.** Don't wait 1.2s for silence.
7. **Filler (0.25h).** If the brain hasn't answered in 700ms, play a cached `"hm."` / `"mm"` and switch the avatar to `thinking`.
8. *(optional)* **Barge-in.** Mute STT while she talks. If the user says 3+ words anyway, abort playback.

---

## 8. Theater (shell UI) · P0/P1

Stack: Vite + React, Framer Motion, a CSS glitch layer.

**Palette.** Everything runs off one OKLCH hue: `--hue: 220` (soft periwinkle), every color is `oklch(L C var(--hue))` mixed toward gray. Animate `--hue` during convergence (drift from cool to Eve's color) and the whole UI shifts mood with one variable.

**Fonts** (all OFL):
- Departure Mono for diagnostics.
- DM Sans for UI.
- Quicksand or Nunito for her subtitles.

| # | Effect | Recipe | Hours | Screen |
|---|---|---|---|---|
| 1 | Glitch text + boot log | RGB split via two `::before/::after` copies (`content: attr(data-text)`, red/cyan offset ±2px). ~20ms `skewX(20deg)` twitch every 2s, 0.06s opacity flicker. Log lines type out with `[ .. ]` flipping to `[ OK ]`, plus a scanline overlay (repeating-linear-gradient 2px). | 2-3 | calibration, convergence, "EVE IS THINKING..." |
| 2 | **Card art bleeds out of frame** | Portrait sits ~5rem above the card top, masked by an 11deg linear gradient + radial fade so it spills over the border. For emergence: animate the mask away, then Framer `layoutId` hands the figure from the card to the desktop canvas. | 3-4 | emergence (P0) |
| 3 | Holo tilt, driven by gaze | Perspective tilt toward the gaze point + two `mix-blend-mode: color-dodge` gradient layers (foil sheen) that track it. The card physically reacts to being looked at. | 1.5 | Act I |
| 4 | Shutter transition | Full-screen panels sweep in with `cubic-bezier(0.87, 0.05, 0.02, 0.97)`. Swap the underlying view at **duration / 3**, while covered. | 1.5 | dating UI falls away, companion to thinking mode |
| 5 | Radial ripple stagger | Each item's delay = `hypot(row - r0, col - c0) * 80ms`. | 1 | agent fan-out, latent-model nodes |
| 6 | Streaming stroked subtitles | Grapheme-by-grapheme pop-in (`Intl.Segmenter`), anime caption style: white fill, thick dark `-webkit-text-stroke` / `paint-order: stroke`. | 2 | companion desktop |
| 7 | Hue shift | Animate `--hue` (see Palette). | 1 | convergence |
| 8 | Delayed status pill | Status chips appear only if a state lasts >400ms (no flashing), then a lamp-flicker in (opacity 0, 1, 0.3, 1 over 180ms). | 1 | diagnostics |
| 9 | Tachie fallback | Swap emotion PNGs + bob, in case Live2D fights us. | 2 | emergence safety net |

**Act I cards** use the persona card format from section 3. Each synthetic candidate is a card, and Eve is literally the card that gets generated at the end. This is a nice symmetry for the pitch.

---

## 9. Computer use + permissions · P0/P1

- **Observe as targets.** Merge accessibility tree + page elements into a ranked list of `{id, role, label, bbox}`. The LLM picks IDs. Same snap resolver as gaze.
- **Policy check before every action**:
  - Per-session action budget.
  - App deny list (Terminal, System Settings, password managers).
  - Blocked shortcuts (cmd+q on shell, cmd+w on Zo).
  - Map to our classes: READ, SAFE_ACTION auto; EXTERNAL_SIDE_EFFECT, SENSITIVE_ACTION queue for approval.
- **Approval queue as a beat.** Eve *says* what she's about to do ("making a 7:30 calendar event, yeah?") and a held blink approves. Trace every step to the swarm view.
- **"...seriously?"**:
  1. A tiny pyobjc watcher (`NSWorkspace` app-activate notifications) emits `app.opened`.
  2. The rule `dating-app-relapse` fires, and Eve turns + says it.
  3. `ACT` closes the window.
  4. Pre-render the line.
- **Claude Code hooks to her state.** Wire `PreToolUse/PostToolUse/Stop` hooks to POST to the bus, then map tool runs to `thinking` and Stop to `happy`. When the frontier brain is working, her face shows it.

---

## 10. What's ours

None of the following exists in open companion stacks today. Lead the pitch with it:

- **Shared attention**: she knows what you're looking at and resolves "this."
- **Preference inference from attention**: the Act I vector math births the persona.
- **Reflex router**: explicit ignore-by-default with a cheap/frontier brain split.
- **Memory write policy + decay** feeding **relationship scalars** that evolve.
- **Visible cognition**: swarm fan-out on the desktop.
- **Persistence off-device**: Zo.

---

## Build order (critical path)

1. Bus + envelope in jabby, then the shell connecting to it and to `eye serve`.
2. Snap resolver + `data-gaze` tagging, emitting `gaze.target`.
3. Live2D setup + param pipeline + blink/saccade/breath (she looks alive).
4. Persona card from vector, then the mark splitter, then pre-rendered TTS + lipsync.
5. Emergence (card bleed + mask + layoutId) + glitch/convergence.
6. Memory seed + retrieval flash.
7. Rules + ticker ("seriously?" beat) + approval queue + one real computer task.
8. Swarm fan-out + Claude Code hooks + Zo status.
