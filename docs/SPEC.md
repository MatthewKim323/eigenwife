# EIGENWIFE

**Your type, compiled.**

A persistent AI companion that learns your latent preferences from your attention, develops a personality tailored to you, shares your visual context, remembers your life, reasons with frontier models, and can autonomously operate a real computer.

The meme is "AI girlfriend." The actual thesis:

> Persistent multimodal agents should share attention with humans, maintain long-term memory, and act continuously in the world instead of waiting for explicit prompts.


> **2026-09-26 scope change:** gaze is attention only. No blink clicks, no double-blink confirms, no gaze-driven input of any kind. Gaze tells Eve what the user is looking at (the "this") and feeds Act I preference signals. Profiles advance on their own (look away / time budget), approvals are spoken. See `docs/ARCHITECTURE.md`.

---

## 1. The four acts

```
ACT I    EIGENVECTOR    "learn me"
ACT II   EMERGENCE      "become someone"
ACT III  COMPANIONSHIP  "understand me"
ACT IV   AGENCY         "do things for me"
```

Starts as a joke dating app, ends looking like a prototype for ambient AGI.

### ACT I: Eigenvector (fake dating UI, "Eigen")

Synthetic profiles, one at a time, each with hidden structured attributes (fictional demo profiles, not claims about real people):

```ts
interface Candidate {
  appearance: { style: number; sporty: number; alternative: number; polished: number }
  personality: { humor: number; sarcasm: number; warmth: number; ambition: number; spontaneity: number; nerdiness: number; chaos: number }
  lifestyle: { nightlife: number; outdoors: number; fitness: number; travel: number; career_focus: number }
}
```

**Eye tracking.** Webcam + MediaPipe / gaze estimation. Quick calibration (LOOK LEFT / RIGHT / CENTER, then CALIBRATED). Track: fixation target, fixation duration, revisits, skip latency, prompt vs photo attention, gaze transitions.

```
PROFILE 04
photo_1       0.8s
prompt_1      4.2s
photo_2       1.1s
prompt_1      revisit
skip latency  7.3s
```

Framing: not "eye movement reveals your soul", but "attention provides implicit preference signals."

**Jev processes signals** (fast bounded judgments, no big LLM):

```json
{ "fixationMs": 4200, "revisits": 2, "region": "prompt", "candidateTraits": { "sarcasm": 0.92, "nerdiness": 0.71 } }
```
```
INTEREST  skip 0.02 | neutral 0.11 | inspect 0.29 | positive 0.58
SIGNAL_STRENGTH: 0.78
```

**Preference vector forms** on screen (`LATENT PARTNER MODEL ████░░░░ 31%`, trait deltas like `humor +0.82`). Visualize as converging nodes or a hazy silhouette forming.

**The math** (the real thing we can claim):

```
C_i ∈ R^n        candidate vector
r_i              attention reward
P = Σ(r_i * C_i) / Σ(r_i)     then normalize
P(t+1) = α * P(t) + (1-α) * new_behavior     (optional adaptation)
```

"We infer a latent preference direction from weighted attention across synthetic candidates."

After 10 to 15 profiles: `LATENT MODEL 98% ... CONVERGENCE DETECTED ... EIGENWOMAN FOUND`, then everything glitches.

### ACT II: Emergence

Dating UI falls away. The recommendation comes alive: the card expands, the avatar steps out of the frame onto the desktop.

> "Wow. So this is what your eyes have been telling on you for?"

The Act I vector sets her initial params:

```json
{ "name": "Eve", "persona": { "humor": 0.86, "sarcasm": 0.76, "warmth": 0.68, "initiative": 0.79, "verbosity": 0.31, "chaos": 0.61 } }
```

**Avatar** (Live2D / Rive / VRM+Three.js / simple 2D / VTuber-like). Needed states: idle, blink, look_left, look_right, look_at_user, annoyed, happy, thinking, speaking. Life comes from timing and contextual reactions, not Pixar graphics.

**Shared gaze / deictic interaction.** You say "thoughts?" while staring at something and she resolves the referent. "this / that / that one / over here" work.

```
WEBCAM -> GAZE COORDINATE -> SCREEN/DOM REGION -> SEMANTIC RESOLUTION -> FIRECRAWL/DOM CONTEXT -> SHARED ATTENTION TARGET

(x=812, y=443) -> DOM node restaurant-card-3 -> { Mensho Tokyo, Garlic Knockout Ramen, $21, 4.6 stars }
```

**Firecrawl = web perception.** Eye tracker knows *where*, Firecrawl provides *what* (active URL, page markdown, structured extraction, metadata, links, visible content). Only scrape when context becomes relevant.

### ACT III: Companionship

She has awareness, memory, personality, continuity, initiative.

**Jabby is the OS.** Don't build a separate agent framework.

- **Jabby = agent runtime:** event bus, brain routing, tool routing, session state, memory calls, environment state, actions, observations.
- **Eigenwife = companion config:** persona, relationship state, avatar, gaze behavior, social policies, voice, companion prompts.

**Event bus.** Everything is an event:

```ts
type Event = GazeEvent | BlinkEvent | VoiceEvent | ScreenEvent | BrowserEvent | MemoryEvent | AgentEvent | TimerEvent
```
```json
{ "type": "GAZE_FIXATION", "target": { "application": "Chrome", "semanticTarget": "ramen-card-3" }, "durationMs": 2841 }
{ "type": "APPLICATION_OPENED", "application": "Eigen Dating", "timestamp": 1727392921 }
```

**Realtime decision loop (Jev):** `IGNORE | GLANCE | REACT | COMMENT | ASK | HELP | ACT | ESCALATE`. Target 80 to 95% IGNORE. Knowing when not to talk is part of the intelligence. (Open Spotify: IGNORE 0.91. Breakup song on repeat 4x: COMMENT 0.78, "We are NOT doing this song again.")

**Featherless = social cortex.** Frequent cheap personality lines (persona + event + memory + behavior, return <= 12 words). "Oh. So we're still shopping."

**Claude Code / Codex Astra = frontal cortex.** Only when needed. Claude (headless CLI via Jabby): reasoning, planning, tool selection, workflow logic. Astra: visual tasks, computer reasoning, computer-use planning. Never for "should she laugh?".

```
System 0  sensors (gaze, events)
System 1  Jev reflex
System 2  frontier models (Claude / Astra), via Jabby router
```

**Moss = hippocampus.** Memory-write policy: `IGNORE_EVENT | STORE_SHORT_TERM | STORE_LONG_TERM | UPDATE_PREFERENCE | UPDATE_RELATIONSHIP`.

```json
{ "type": "preference", "content": "Prefers concise responses", "confidence": 0.84, "source": "behavioral_observation", "createdAt": "...", "importance": 0.71 }
{ "type": "episodic", "content": "Complained that $28 ramen was overpriced", "createdAt": "...", "importance": 0.45 }
```

Retrieval for "where should we eat?": likes spicy (0.94), complained about expensive ramen (0.89), saving money (0.83), likes Japanese (0.74). Result: "Cheap spicy ramen. I'm preventing another $28 bowl incident."

**Memory layers:**
- Working (current session, Jabby): user is looking at ramen
- Episodic (Moss): last Tuesday complained about expensive ramen
- Semantic user model (structured JSON / Moss): prefers low-cost Japanese food

**Relationship model** (separate from memory): `{ banter, warmth, initiative, verbosity, confidence }`, nudged by interactions (positive banter response: banter +0.03; dismissed suggestions: initiative -0.04).

### ACT IV: Agency

The moment she takes external action is when it becomes agentic. Otherwise it's Character.AI with eye tracking.

Flagship: "I have no idea what I'm doing tonight." Jev: ESCALATE. Frontier brain plans: inspect free time, infer preferences, search, compare, present/act per permissions.

**Open Swarm = visible cognition** (her desk / cognitive canvas). Desktop visibly branches:

```
            EVE
   ┌────────┼────────┐
 MEMORY   PLACES   CALENDAR
  Moss    browser  schedule
```

Parent agent aggregates, compares, decides, returns to Eigenwife. UI: COMPANION MODE -> THINKING MODE -> zoom out into Open Swarm workspace.

**Zo = her computer/home.** Open Swarm is the office (cognition viz), Zo is the home server (persistence + execution): files, identity, runtime state, background tasks, long-running companion process, browser sessions.

```
/eve/
  profile.json
  relationship.json
  preferences.json
  task_state.json
```

> Judge: "What happens when you close the website?"
> Us: "Nothing. She doesn't live in the website. She has her own computer."

```
EVE  STATUS ONLINE | UPTIME 05:31:14 | MEMORIES 142 | TASKS 3
```

**Computer control via Jabby abstraction:** `computer.perform({ task })`, Jabby picks Zo browser / Open Swarm agent / Codex Astra / local Playwright.

**Permissions:**

| Class | Example | Demo policy |
|---|---|---|
| READ | view page | auto |
| SAFE_ACTION | open tab | auto |
| EXTERNAL_SIDE_EFFECT | create calendar event | ask |
| SENSITIVE_ACTION | send message, purchase | ask |

---

## 2. Architecture

```
USER -> GAZE / VOICE / COMPUTER STATE
     -> PERCEPTION + FIRECRAWL (web semantics)
     -> WORLD STATE
     -> JEV (realtime reflex)
          IGNORE
          REACT     -> FEATHERLESS (personality)
          ESCALATE  -> JABBY CORE -> MOSS (memory), CLAUDE CODE, CODEX ASTRA
                                  -> TASK / PLAN
                                  -> OPEN SWARM (workspace) / ZO (computer) / LOCAL TOOLS
                                  -> REAL ACTION -> OBSERVATION -> back to event loop
```

Closed loop: observe, decide, act, observe again.

**Jabby services:** EventBus, WorldState, AttentionResolver, ReflexRouter, BrainRouter, MemoryManager, ToolRouter, CompanionState, SessionManager, ActionExecutor.

**WorldState:**

```json
{
  "user": { "speaking": false, "gazeTarget": "restaurant-card-3", "attentionConfidence": 0.87 },
  "desktop": { "activeApp": "Chrome", "activeUrl": "...", "currentSemanticObject": { "type": "restaurant", "name": "Mensho" } },
  "companion": { "mode": "idle", "lastInteraction": 1710, "relationshipState": {} }
}
```

**BrainRouter** (keep routing explicit):

```ts
if (decision === "IGNORE") return
if (decision === "SOCIAL_REACTION") return featherless.generate(...)
if (decision === "COMPLEX_REASONING") return claude.reason(...)
if (decision === "COMPUTER_TASK") return astra.reason(...)
```

**Gaze primitives** (gaze is context only, no clicking and no blink gestures; decided 2026-09-26): FIXATE = attention target, REVISIT = interest, LONG FIXATION = inspect, LOOK AWAY = lost interest. The agent uses it to know what "this" is.

**Voice:** browser speech recognition or Whisper-ish STT, browser TTS out. Don't burn 4 hours here.

**Avatar state machine:** IDLE, LISTENING, THINKING, SPEAKING, REACTING, ACTING, SLEEPING. Driven by Jabby (Claude running -> THINKING, Featherless output -> SPEAKING, gaze near avatar -> GLANCE_AT_USER).

**Ambient:** periodic TIMER_TICK, Jev asks "anything worth doing?", usually NO. Sometimes: background task finished, calendar approaching. No random autonomous chatter.

**Firecrawl triggers only:** gaze target needs semantic resolution, agent needs web content, current page needs extraction.

---

## 3. Sponsor story ("How do you build a person?")

| Faculty | Sponsor |
|---|---|
| Perception | Eye tracking + Firecrawl |
| Reflex | Jev |
| Memory | Moss |
| Personality | Featherless |
| Reasoning | Claude / GPT-6 Astra |
| Orchestration | Jabby |
| Cognitive workspace | Open Swarm |
| Persistence + action | Zo |

Beyond the hackathon: same Jabby substrate, different persona/tools/memory policy/initiative/avatar (coding partner, fitness, travel, tutor, EA, gaming, creative).

---

## 4. UI screens (six)

1. Calibration (`LOOK HERE ●`)
2. Dating / preference inference (profile + eye indicator + latent model progress)
3. Emergence (avatar birth)
4. Companion desktop (floating avatar + subtle contextual state)
5. Open Swarm thinking view (visible multi-agent fan-out)
6. Architecture / result

Visual language: soft, alive, slightly uncanny, beautiful, minimal, anime/futuristic, OS-like. No enterprise dashboard chrome. Tiny diagnostics only where theatrical (`remembered · 4ms`, `attention target: spicy miso ramen`, `EVE IS THINKING...`).

---

## 5. Golden demo (2:00)

| t | Beat |
|---|---|
| 0:00 | "Dating apps ask what your type is. We don't think you know." Profiles. |
| 0:10 | "So we watch what actually gets your attention." Eye tracking, latent model rises. No mouse. |
| 0:23 | EIGENWOMAN CONVERGED, glitch |
| 0:28 | She emerges. "Apparently I'm your type." |
| 0:38 | Browser, look at food. "Thoughts?" She knows the exact item ("Twenty-one dollars for ramen?"). |
| 0:48 | "What should we eat instead?" Memory flash (`MEMORY · 4ms` likes spicy / expensive ramen / saving money). "I'll find somewhere cheaper." |
| 1:00 | "Actually just figure out tonight." |
| 1:05 | Open Swarm expands: CALENDAR / PLACES / MEMORY / PLAN |
| 1:15 | Zo/browser visibly acts |
| 1:28 | Calendar event created. "7:30. Cheap ramen. You're free. Done." |
| 1:36 | Open dating app again. Avatar turns. Pause. "...seriously?" She closes it. |
| 1:45 | "And she doesn't live in this webpage." Zo status. "She has her own computer." |
| 1:54 | Architecture. EIGENWIFE: Your type, compiled. |

Arc: knows what you like, exists, knows what you're looking at, remembers who you are, decides when to speak, can think, can use tools, can act, persists without you.

---

## 6. Build priority

| P | Feature | Why |
|---|---|---|
| P0 | Profile UI | establishes premise |
| P0 | Eye tracking | unique interaction |
| P0 | Preference inference | proves "compiled" |
| P0 | Avatar emergence | biggest emotional moment |
| P0 | Jabby event/router | connects everything |
| P0 | One memory retrieval | proves persistence |
| P0 | One real computer task | proves agency |
| P1 | Jev live routing | technical differentiator |
| P1 | Featherless responses | sponsor + personality |
| P1 | Open Swarm visualization | judge/demo value |
| P1 | Zo persistence | killer architectural story |
| P1 | Firecrawl shared gaze | strongest HCI feature |
| P2 | Multiple computer workflows, sophisticated voice, perfect avatar rig, dozens of memories | unnecessary |
| P3 | Generalized autonomous AGI | do not build |

**Team split (3 to 4 people), integrated through one shared event schema:**
- A, frontend/theater: dating flow, avatar, transitions, Open Swarm viz
- B, perception: eye tracking, semantic gaze, Firecrawl
- C, Jabby/brains: Jev, Featherless, Moss, Claude/Codex subprocesses
- D, agency/infra: Zo, Open Swarm, browser actions, demo workflow

## 7. The five things that MUST work before judging

1. Eyes genuinely affect the inferred companion.
2. Companion genuinely remembers one earlier thing.
3. Companion genuinely understands one gaze-grounded "this."
4. Companion genuinely executes one external computer workflow.
5. Companion has one hilarious autonomous reaction.

Goal: first 30s absurd, next 60s impressive, and by the end everyone realizes the AI-girlfriend joke was a demo of shared-attention persistent personal agents with memory and computer agency.

---

## 8. Gaze reality check (from `eye/RESEARCH.md`)

The tracker lives in `eye/` (Python, MediaPipe 1.0.0, 47 tests passing). Findings that change the plan:

- **Accuracy is 2-4° (100-200pt) with a still head, 7-31° once the head moves.** Calibration must include head-motion targets. Design every gaze target big: profile regions (photo vs prompt) are fine, restaurant cards need to be large and well spaced.
- **No blink input.** Gaze is only context for the agent; nothing is clicked with the eyes.
- **Freeze the gaze point at blink onset.** Eyes roll down 1-5° during a blink, so post-onset gaze is garbage.
- **Saccade-gated averaging, not low-pass.** Fixation = mean of samples within ~2.5°. That is exactly the fixation/revisit signal Act I needs.
- **Calibration is ~90s full, ~45s `--quick`.** Demo should use quick mode or calibrate before walking on stage.
- **Snap to targets.** Gaze resolves to the nearest semantic element, not a raw pixel. Same idea as the DOM-region resolver in the attention pipeline.
- Pins: `mediapipe==1.0.0` (1.0.1 aborts on macOS), `opencv-contrib-python==4.13` (5.0 arm64 segfaults). Don't bump.
- **Integration point: `eye serve`.** Localhost websocket (`ws://127.0.0.1:8765/ws`) streaming gaze and fixations, plus `eye-client.js` which maps gaze onto `[data-gaze]` elements and keeps dwell / revisit stats per element (the Act I signal). In-app quick calibration (5 dots) is built in. Schema in `eye/README.md`.
- **Model is linear now** (2026-09-26): quadratic terms blew up with head motion. Real-session validation 3.87° -> 2.62°, head-motion error ~3x lower.
