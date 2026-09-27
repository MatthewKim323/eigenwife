# EIGENWIFE

**Your type, compiled.**

A fake dating app watches what your eyes linger on, compiles your latent preferences into a companion, and she steps out of the profile card. She knows what you're looking at, remembers your life, decides when to speak (mostly: not), and does things on your real computer.

The meme is "AI girlfriend." The thesis is **persistent multimodal agents that share attention with you, remember, and act continuously in the world instead of waiting for prompts.**

## Run it

```bash
bun install
bun run dev              # core (:7777) + shell (:5173)
bun run dev --all        # + webcam gaze (eye serve :8765) + macOS app watcher
```

Open http://127.0.0.1:5173 fullscreen. Add `?gaze=mouse` to fake gaze with the pointer (dev and backup). Use headphones: she listens while she talks. `?stt=deepgram|browser|auto` picks the ears (Deepgram via the core, or Chrome Web Speech).

Once she's born, let her live on your real desktop while you work:

```bash
bun run overlay          # with `bun run dev` running: Eve floats bottom-right, click-through except her pixels
```

`⌘⇧E` show/hide, `⌘⇧M` mute, drag her anywhere, the menu bar heart has the rest. Mic goes through Deepgram (`DEEPGRAM_API_KEY`). See [OVERLAY](docs/OVERLAY.md).

Before a demo:

```bash
cd eye && uv run eye calibrate          # once per seat, ~90s
bun run --cwd packages/core prerender   # cache every scripted line's audio
bun run scripts/e2e.ts                  # headless golden path, 6 steps, ~40s
```

`bun run --cwd packages/core eve status` prints Eve's status from `~/.eve` even with the browser closed.

## How it works

```
 eyes (webcam) ─► shell ─► bus ─► reflex (Jev) ─► brains ─► jabby / claude / codex
 voice ─────────►        (:7777)   ignores ~87%     │
                                                    ├─► speech ─► avatar (Live2D, lipsync)
                                                    ├─► memory (Moss) + relationship
                                                    └─► agency ─► harem swarm ─► Calendar, web, apps
```

- **Perception.** Webcam gaze (`eye/`, MediaPipe) gives attention, never input. It tells Eve what "this" is, and in Act I it's the preference signal. Firecrawl gives the page semantics.
- **Reflex (Jev).** Declarative perception rules raise triggers. Jev picks IGNORE / GLANCE / REACT / COMMENT / ASK / HELP / ACT / ESCALATE. In a simulated hour of ambient life she ignores 82-91% of what happens.
- **Personality (Featherless).** A fast social cortex for short in-character lines with inline `[mood:x]` marks that drive her face.
- **Reasoning (Jabby → Claude / Codex).** Jabby is the brain: the live jabby daemon first, then headless `claude -p` and `codex exec`.
- **Memory (Moss).** Episodic + semantic records, a write policy, retrieval scored by similarity + recency + importance. "What should we eat?" recalls the $28 ramen complaint in under a millisecond.
- **Workspace (Open Swarm / harem).** Hard asks fan out into visible sub-agents that argue and merge.
- **Hands + home (Zo).** Real actions behind spoken approvals (a real macOS Calendar event), with state persisted to `~/.eve` and mirrored to Zo. She doesn't live in the web page.
- **Coworker (work).** She knows which repo you're in (frontmost app + git, never the screen), finds and reads your files (Spotlight, secrets denied and redacted), ships code ("fix the flaky test in eigenwife": isolated worktree, headless Claude Code, progress in the swarm view, then "merge it and push?"), hands email / classes / reminders / sends to jabby with the draft read back first, runs a shell command only after reading it back, and says one line when your Claude Code session finishes, never while you type. See [WORK](docs/WORK.md).

## Repo

| Path | What |
|---|---|
| `packages/protocol` | the one event schema, world reducer, bus client, Act I candidates |
| `packages/core` | the body's nervous system: hub + modules (brains, speech, reflex, mind, memory, preference, home, agency) |
| `packages/harem` | multi-agent swarm execution |
| `apps/shell` | the stage: scenes, gaze bridge, Live2D Eve, voice |
| `eye` | webcam gaze tracker + `eye serve` |
| `watcher` | macOS app / now-playing watcher, Claude Code hook |
| `scripts` | `dev` launcher, `e2e` golden path |

Docs: [ARCHITECTURE](docs/ARCHITECTURE.md) · [SPEC](docs/SPEC.md) · [BRAINS](docs/BRAINS.md) · [MIND](docs/MIND.md) · [MEMORY](docs/MEMORY.md) · [KNOW ME](docs/KNOW_ME.md) · [AGENCY](docs/AGENCY.md) · [WORK](docs/WORK.md) · [SCREEN](docs/SCREEN.md) · [AGENT CURSOR](docs/AGENT_CURSOR.md) · [AVATAR](docs/AVATAR.md) · [SPONSORS](docs/SPONSORS.md) · [PLAYBOOK](docs/PLAYBOOK.md)

## Keys

Every sponsor slot has a real adapter and a local fallback, so it runs with zero keys and gets better as keys appear. Put them in `.env` at the repo root (jabby's `.claude/jabby/.env` is read too). `GET :7777/api/brains/status` shows what's live.

`OPENAI_API_KEY` · `FEATHERLESS_API_KEY` · `TYPESAFE_API_KEY` (Jev) · `MOSS_PROJECT_ID` + `MOSS_PROJECT_KEY` · `ZO_API_KEY` · `FIRECRAWL_API_KEY` · `ELEVENLABS_API_KEY` · `ANTHROPIC_API_KEY`

## Tests

```bash
bun test packages apps/shell/src   # unit + integration, no network
bun run scripts/e2e.ts             # the golden path against real brains
```
