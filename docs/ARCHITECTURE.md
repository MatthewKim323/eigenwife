# Architecture

Eve is a closed-loop agent: **observe, decide, act, observe again**. Jabby is the brain. Everything else in this repo is the body: senses, reflexes, memory, face, voice, and hands.

```
 shell (browser, :5173)            core (Bun, :7777)                      outside
 ─────────────────────             ──────────────────                     ───────
 eye-client ─ gaze bridge ──┐      hub (ws /bus + http)
 speech recognition ────────┤ ──►  world state ◄── every event
 scenes, data-gaze targets ─┘      reflex (Jev) ──► brains ──────────────► jabby daemon (:4632)
                                      │              │                    claude -p / codex exec
 avatar + lipsync ◄─ speech.* ◄───────┤           speech (TTS) ──────────► OpenAI / ElevenLabs
 swarm view ◄─────── swarm.* ◄────────┤           memory ────────────────► Moss (or local)
 hud ◄────────────── everything       │           preference, relationship
                                      └─────────► agency ────────────────► harem swarm, Calendar,
                                                  home ──────────────────► Zo, ~/.eve   browser, Firecrawl
 eye serve (Python, :8765) ── gaze ──► shell        watcher (macOS apps) ─► app.opened
```

## Rules

1. **One schema.** Every event is an `Envelope` from `packages/protocol`. Add event types there (additive only, never rename).
2. **Modules never import each other.** They talk over the bus, or call a typed service (`ctx.use("memory")`) whose interface lives in `packages/core/src/services.ts`.
3. **Gaze is attention, never input.** No blink clicks, no dwell-to-click. Gaze tells Eve what "this" is and feeds Act I preference signals. The user speaks, the operator can use arrow keys, and everything else happens on its own.
4. **Approvals are spoken.** Consequential actions (`EXTERNAL_SIDE_EFFECT`, `SENSITIVE_ACTION`) wait for `action.approval`, which the agency module derives from speech ("yeah", "do it", "lock it in" / "nah", "wait").
5. **Jabby is the brain, untouched.** We call the running jabby daemon and the same CLIs jabby uses. We never edit `~/dev/jabby`.
6. **Everything degrades.** Each sponsor adapter has a local implementation that works with zero keys, so the demo runs offline and gets better as keys appear. `/api/status` says which is live.

## Ownership

| Area | Path | Owns | Provides |
|---|---|---|---|
| protocol | `packages/protocol` | event schema, world reducer, bus client, candidate dataset | |
| core base | `packages/core/src/{bus,hub,context,config,services,index,main}.ts` | hub, module + service registry | |
| brains | `packages/core/src/brains`, `packages/core/src/speech` | jabby bridge, persona + frontier brains, mark splitter, TTS, audio cache | `brains`, `speech` |
| mind | `packages/core/src/reflex`, `packages/core/src/mind` | perception rules, Jev scoring, urgency ticker, conversation turns, relationship scalars | `reflex`, `relationship` |
| memory | `packages/core/src/memory`, `packages/core/src/preference`, `packages/core/src/home` | Moss + local memory, write policy, Act I math, persona synthesis, persistence, Zo | `memory`, `preference`, `home` |
| agency | `packages/core/src/agency`, `watcher/` | tasks, permissions, voice approvals, actions (calendar, browser, apps), Firecrawl, Claude Code hooks | `agency` |
| harem | `packages/harem` (worktree `harem` branch) | multi-agent swarm execution, Open Swarm adapter | `executeWithHarem()` |
| shell | `apps/shell/src/{scenes,components,lib,gaze,data,styles}` except Emergence | scenes, restaurant page, HUD, swarm view, theater | |
| avatar | `apps/shell/src/{avatar,voice}`, `apps/shell/src/scenes/Emergence.tsx` | Live2D Eve, emotions, lipsync, playback queue, speech recognition, subtitles | |
| eye | `eye/` | webcam gaze, `eye serve` | |

## Core flows

### Act I: preference from attention
1. Shell shows a candidate (`dating.view`). Each card region is tagged `data-gaze="cand_<id>_<region>"`.
2. Gaze bridge accumulates region stats. The card advances on its own: look away for ~1.5s, or a ~7s budget, or arrow keys (operator).
3. Shell emits `dating.leave { regions, totalMs, skipLatencyMs }`.
4. Core `preference` scores it (Jev when `TYPESAFE_API_KEY` is set, a local model otherwise), emits `dating.signal` and `preference.update`:
   `P = Σ(r_i · C_i) / Σ r_i` over candidate trait vectors `C_i` with attention rewards `r_i`, plus a convergence measure.
5. When converged (or after the last card), core emits `preference.converged { vector, persona }`, then `companion.born` when the shell reaches emergence.

### Talking
1. Shell speech recognition emits `voice.final`.
2. `mind` turns it into a trigger, and Jev decides. A direct utterance is never ignored, but "wait" is.
3. The persona brain answers with world context (gaze target!) + recalled memories. `speech` splits marks, synthesizes, emits `speech.segment { audioUrl, marks }`.
4. Shell plays segments in order. Marks fire `avatar.mood` when their segment starts. Lipsync follows the audio.
5. `memory.observe()` decides what to remember. `relationship.nudge()` tracks how it went.

### Ambient
`timer.tick` every 2s. Perception rules (repeat media, dating app relapse, long silence while staring at something, task finished) raise triggers with urgency. Jev ignores 80-95%.

### Agency
1. ESCALATE → `agency.runTask(goal)`.
2. It plans with the frontier brain, and fans out via the harem when present (built-in parallel planner otherwise). Everything is visible as `swarm.*` events in the swarm scene.
3. Actions go through `action.request`, the permission check, the spoken approval, then execution, then `action.result`.

### Home
Eve's state (`profile`, `relationship`, `preferences`, `memories`, `tasks`) persists under `~/.eve/` and mirrors to Zo when `ZO_API_KEY` is set. The core is its own process: closing the browser doesn't stop her. `home.status` reports uptime every 5s.

## Ports

| Port | What |
|---|---|
| 5173 | shell (Vite) |
| 7777 | core hub: `ws /bus`, `GET /health /world /events`, `POST /emit`, module routes under `/api/*` |
| 8765 | `eye serve` |
| 4632 | jabby daemon web API (`/api/chat` SSE) |

## Keys

All optional. Resolved from env, `eigenwife/.env(.local)`, then jabby's `.claude/jabby/.env`. See `docs/SPONSORS.md` for the APIs.

`OPENAI_API_KEY`, `FEATHERLESS_API_KEY`, `TYPESAFE_API_KEY` (Jev), `MOSS_PROJECT_ID` + `MOSS_PROJECT_KEY`, `ZO_API_KEY`, `FIRECRAWL_API_KEY`, `ELEVENLABS_API_KEY`, `ANTHROPIC_API_KEY`.
