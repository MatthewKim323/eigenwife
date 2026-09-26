# Screen

Eve glances at your screen like a friend sitting next to you: mostly she says nothing, sometimes "that error's been there 10 minutes, want me to look?", sometimes "that jacket is mid". Two levels, both local-first, both visible, both pausable.

```
 every ~7s while you're active (keyboard/mouse in the last 90s), only when the window changed
   frontmost app (lsappinfo) ── private app? ──► "private app", nothing read
   watcher/screen-ax.swift: focused window's accessibility text (secure fields skipped, private sites stop the walk)
   redact (emails, phones, cards, SSNs, keys, tokens) ── cap 4k chars ── never leaves the machine
   local summary: "Cursor: hub.ts - eigenwife · error: TypeError: ... (hub.ts line 42)"
   Jev /v1/evaluate on the SUMMARY: mode · stuck · interesting · sensitive   (local guesses if Jev is down)
   screen.observation {app, title, summary, scores, by}  + world slot screen.on_screen  + 👀 flash on her
       │
 reflex rules ─ screen_stuck (same error 5+ min) ── HELP "want me to look?" ── "yeah" ── work mode (Claude Code)
             └ screen_interesting (>= 0.7)     ── mostly IGNORE, sometimes GLANCE / COMMENT
 "what do you think of this" in another app ── level 3 look ── the persona answers about what she saw
```

## Level 2: window text (continuous, lightweight)

What's read, every ~7s, only while you've touched the keyboard or mouse in the last 90s, only after she's born:

- the **focused window of the frontmost app**, nothing else: its title, static texts, headings, links, text areas and fields, table cells, the focused field's value and your selection, and visible web area text where the browser exposes it (elements outside the window's frame are skipped),
- capped at 2,500 accessibility nodes and ~8k chars in the helper, then 4k chars after redaction.

What's never read:

- **secure text fields** (`AXSecureTextField`, as role or subrole): the helper skips them before reading any value and never descends into them. If the focused element is secure, the selection and focused value aren't reported either.
- **private apps**: password managers (1Password, Bitwarden, LastPass, Dashlane, Keeper, Passwords), Keychain Access, System Settings, Messages, Mail, FaceTime, Signal, WhatsApp, Telegram, banks and brokerages, Wallet, Health, authenticators, crypto wallets, tax and budgeting apps. Checked with `lsappinfo` (no permissions) before a single accessibility call; the observation is `{app: "private app", private: true}` with no title and no text.
- **private sites**: banks, brokerages, payment apps, credit bureaus, the IRS, password manager web apps, Google/Apple account pages, webmail, web chat, patient portals. The helper gets the list and stops the moment it finds a web area on one of those hosts, returning nothing it read. Any host that starts with `bank`/`banking`/`creditunion` counts too. Titles like "Online Banking", "Sign in to", "verification code" make a window private.
- **your denylist** in `~/.eve/screen.json` (below).
- **Eve herself**: the overlay (Electron) and the shell tab (`:5173`, title "Eigenwife").

Then, locally:

1. **Redaction**: emails, phone numbers (10+ digits), card numbers (Luhn-checked), SSNs, IBANs, API keys and tokens (OpenAI/Anthropic `sk-`, GitHub, Slack, AWS, Google, JWTs, bearer headers, npm, GitLab, Vercel, private key blocks, `password=` style assignments), and long random-looking strings.
2. **Summary** (`screen/summarize.ts`, well under 1ms): app + title + host, the first error line with its file and line ("TypeError: ... (hub.ts line 42)"), else the first heading, prices on shopping pages, a couple of key lines, your selection. Max 300 chars. Also local guesses for mode, interest and sensitivity.
3. **Sensitive locally?** (passwords, account/routing numbers, balances, diagnoses, prescriptions, salary, tax forms, codes, seed phrases, or 4+ redactions): the window becomes "private app" and **nothing is sent anywhere**.
4. **Unchanged?** Same hash as last time: nothing is sent. While an error is on screen the summary is re-judged once a minute so "stuck" can grow.

## Jev: four typed questions on the summary

`POST {jevEndpoint}` (AI Gateway `/v1/evaluate` with `typesafe-ai/jev` when `AI_GATEWAY_API_KEY` is set, TypeSafe `systemone` with `TYPESAFE_API_KEY`), 1.5s budget, breaker after 3 failures. The state is only: the task line, app, the summary, whether an error is visible, how long the same error has been up, seconds since your last input.

| Question | Type | Criteria |
|---|---|---|
| `mode` | choice | coding, debugging, reading, writing, shopping, social, video, gaming, idle |
| `stuck` | boolean | the same error has been on screen for minutes without progress |
| `interesting` | score | boring / mildly / interesting / a friend would definitely comment (0..3, normalized to 0..1) |
| `sensitive` | boolean | banking, passwords, medical, legal, intimate messages, identity documents |

Guardrails on the answer: `stuck` needs the error on screen at least half the threshold (2.5 min); a locally sensitive window is sensitive whatever Jev says; Jev saying sensitive drops the observation (no title, no summary on the bus, nothing stored). Any failure or malformed answer uses the local guesses (`by: "local"`).

Then `screen.observation {app, title, summary, scores, by, error?, stuckMs?, focus, host?}` goes on the bus and the world slot `screen.on_screen` becomes e.g. "Cursor: hub.ts - eigenwife · error: TypeError: ... (hub.ts line 42), same error for ~6 min", so every prompt knows. `focus` means you typed in the last 4s in a code or writing app: deep focus, she stays quiet.

## Level 3: one window, on demand

`screencapture -l <windowId> -x -o` of **exactly the focused window** (its CGWindowID comes from the helper, matched by pid, title and bounds), into `~/.eve/tmp/screen-*.jpg` (0600), downscaled to 1280px with `sips`, described by a vision model, and **deleted in a `finally`** whether the model answered or threw. Leftovers from a crash are swept when the core starts. Screenshots are never stored; only the text description may be (see Memory).

When:

| Trigger | Rate limit |
|---|---|
| (a) you ask something deictic while a non-Eve app is in front: "what do you think of this", "thoughts?", "what's this", "can you see this", "look at this", "is this mid?", "should i buy this" | 8s apart. She says "hm. lemme see." first, then answers about what she saw. A fresh gaze target in the shell wins over the screen. |
| (b) she offers help on a stuck error | once per 10 min |
| (c) idle (no input 5s+) and interesting (>= 0.7) | once per 2 min, **off by default**: `EVE_SCREEN_AUTOVISION=1` |

Vision engines, in order (`EVE_SCREEN_VISION=gateway|anthropic|claude` pins one):

| Engine | Needs | How |
|---|---|---|
| gateway | `AI_GATEWAY_API_KEY` | chat completions with an `image_url` data URL: `anthropic/claude-haiku-4.5`, then `google/gemini-2.5-flash` (a model the account can't use, e.g. a free-tier 403, falls through; the working one sticks). `EVE_SCREEN_VISION_MODEL` pins one. |
| anthropic | `ANTHROPIC_API_KEY` | Messages API with a base64 image block, haiku |
| claude | the `claude` CLI, logged in | `claude -p --model haiku --tools Read --allowedTools Read --permission-mode dontAsk --add-dir ~/.eve/tmp --strict-mcp-config --no-session-persistence`, pointed at the temp file |

The prompt asks for at most two plain sentences (app/site and the thing that matters), tells the model never to repeat emails, numbers, addresses or codes, and to answer exactly `PRIVATE` for private windows (then nothing is used or stored). The description is redacted again.

## What leaves the machine, and when

| What | Where | When |
|---|---|---|
| the compact summary line (max 300 chars, redacted) + app + a few numbers | Jev (AI Gateway or TypeSafe) | when the focused window changed (and once a minute while an error is up), unless private or locally sensitive |
| one JPEG of the focused window (max 1280px) + your question + the summary | the vision engine (AI Gateway, Anthropic, or the claude CLI) | only for (a), (b), (c) above |
| the vision description | the persona brain, as prompt context | when she answers or offers help |

Raw window text never leaves the machine. Nothing is written to disk except the temp image (deleted right after use) and `~/.eve/screen.json`.

## Guardrails

- **👀 looking** on her in the overlay (top right, never hidden by her talking): a brief flash on every level 2 read, a clear held chip for the whole level 3 capture. Driven by `screen.looking {level, active}`.
- **Pause**: tray "Pause screen" or `⌘⇧P` emit `screen.pause {paused}`; the core persists it in `~/.eve/screen.json` and it survives restarts. The existing "Pause attention" (`attention.pause`) also stops all screen reads and looks (not persisted by the screen module; the overlay remembers it). While paused, `current()` is empty and "this" never means the screen.
- **Kill switch**: `EVE_SCREEN=0` and the module never polls, never reads, never looks.
- **Memory**: only non-sensitive, non-private observations with interest >= 0.6 (not coding, not idle, no redaction tags) become short-term memories ("Was looking at Chrome: Wool Jacket | SSENSE · $1,250"), at most one per 10 minutes. A vision description for your question can be kept the same way ("Showed Eve ..."). Stuck-help looks are never stored. Screenshots never are.

## `~/.eve/screen.json`

```json
{
  "paused": false,
  "denylist": { "apps": ["Figma"], "domains": ["notion.so", "*.corp.example.com"] },
  "told": { "accessibility": true }
}
```

`denylist.apps` are case-insensitive substrings of the app name; `denylist.domains` match the host and its subdomains. `told` records which permission hints she already said.

## Permissions (macOS)

| Permission | For | Where |
|---|---|---|
| Accessibility | level 2 (reading window text) | System Settings > Privacy & Security > Accessibility > turn on the app that runs the core (Terminal, iTerm, Ghostty, your editor) |
| Screen Recording | level 3 (window capture) | System Settings > Privacy & Security > Screen Recording > same app, then restart it |

The helper checks both (`AXIsProcessTrusted`, `CGPreflightScreenCaptureAccess`) and the core emits `screen.permission`. If one is missing she says once, out loud, how to grant it ("heads up, i can't read your screen yet. system settings, privacy and security, accessibility, then turn on Ghostty."), and remembers she said it.

The helper is compiled on first use with `swiftc -O` (Xcode command line tools) into `~/.eve/bin/screen-ax-<hash>`; a new source version compiles a new binary.

## The mind

| Rule | Fires when | Rate limit | Local Jev logits |
|---|---|---|---|
| `screen_stuck` | same error on screen 5+ min, stuck, not while typing | 30 min per error, 10 min between any | IGNORE 0.8, GLANCE 0.4, HELP 2.3 + 0.3 per extra 10 min + (initiative - 0.5) |
| `screen_interesting` | interest >= 0.7, mode shopping / social / video / reading / gaming, not private, not sensitive, not deep focus | 30 min per page, 8 min between any | IGNORE 2.0, GLANCE 1.2, COMMENT 1.3 + 2.5(interest - 0.7) + (banter - 0.5) |

Deep focus (`screen.focus = deep` in the world slots) subtracts 1.5 from every non-IGNORE logit of every ambient trigger except `screen_stuck`.

- **HELP on stuck**: she takes a level 3 look (if allowed), and the persona gets the error, the look, and "offer to take a look, in one short casual line ending in a question". The offer stays open 2 minutes. "yeah" / "sure" / "please" / "do it" / "fix it" hands `fix <error> in <repo>` to the work module (repo from the work context): isolated worktree, headless Claude Code, "merge it and push?" (docs/WORK.md), with its own spoken approval. "nah" / "i got it" drops it.
- **COMMENT on interesting**: the persona gets the summary and "one short, specific, opinionated remark, like a friend glancing over".
- **Deictic questions**: the look's description goes first in the persona's context, with "when they say this/that, they mean what's on their screen". If the look fails, the level 2 summary is used; if there's nothing, she says she couldn't see it.

**Ignore rate**: the simulated hour in `packages/core/test/reflex.module.test.ts` now also has a changing focused window every 1-5 min (code, shopping, a feed, video, a PDF, a private app) and a 9-minute debugging stretch with the same error. Over the 5 seeds: 83.9% to 90.1% of ambient triggers ignored, `screen_stuck` fires exactly once per hour (HELP in 4 of 5 seeds; once she had just spoken), `screen_interesting` 1-5 times, mostly ignored, occasionally a COMMENT.

## Routes and events

| Route | |
|---|---|
| `GET /api/screen/status` | enabled, polling, paused, attentionPaused, autoVision, permissions, current observation, jev status, counters, denylist |
| `POST /api/screen/pause {paused}` | same as the tray |
| `POST /api/screen/look {question?}` | a deictic level 3 look of whatever is in front (still paused/private-aware) |

| Event | What |
|---|---|
| `screen.observation` | level 2 result (summary only) |
| `screen.vision` | level 3 result: app, reason, description, engine, ms (never the image or its path) |
| `screen.looking` | drives the 👀 chip |
| `screen.pause` | pause / resume, persisted |
| `screen.permission` | accessibility / screen recording state |

## Real run (2026-09-26, matt's Mac)

Against a TextEdit document created for the test (`eve-screen-test.txt` with a fake stack trace, a fake email and a test card number), targeted by pid and exact title with `packages/core/scripts/screen-smoke.ts`; no other window was read or captured. Sanitized output:

```
permissions: {"accessibility":true,"screenRecording":true}
level 2: TextEdit "eve-screen-test.txt", 3 text nodes, 2 redactions
summary: TextEdit: eve-screen-test.txt · error: TypeError: Cannot read properties of undefined (reading 'port') (hub.ts line 42) · eve screen test (fake, safe to delete)
jev (error up 0 min): by=jev 609ms {"mode":"debugging","stuck":false,"interesting":0.61,"sensitive":false}
jev (error up 6 min): by=jev 463ms {"mode":"debugging","stuck":true,"interesting":0.63,"sensitive":false}
level 3: by=gateway (gemini-2.5-flash after a free-tier 403 on haiku) 3281ms
description: This is a TextEdit document named "eve-screen-test.txt". It displays a TypeError: Cannot read properties of undefined (reading 'port') in hub.ts line 42.
temp image deleted: true (leftovers in ~/.eve/tmp: 0)
```

The claude CLI engine on the same window: 6.0s, "TextEdit showing test code with a TypeError from hub.ts line 42: can't read 'port' property of undefined when calling startHub in main.ts." The email and card number were redacted before summarizing and never appeared in anything sent. Note: `screencapture -l` can't image a window on another Space ("could not create image from window"); in normal use the focused window is on the current Space.

```bash
bun run packages/core/scripts/screen-smoke.ts --pid <pid> --title "<exact window title>" [--look]
```

## Files

| File | What |
|---|---|
| `watcher/screen-ax.swift` | the helper: `perms`, `dump [--pid N] [--max C] [--deny-hosts a,b]` |
| `packages/core/src/screen/module.ts` | `screenModule()`, `createScreen()`: the loop, looks, pause, permissions, memory, routes, `screen` service |
| `screen/capture.ts` | helper build + run, dump parsing, window capture with guaranteed deletion, sweep |
| `screen/redact.ts` | redaction + caps |
| `screen/privacy.ts` | private apps / domains / titles, `~/.eve/screen.json` |
| `screen/summarize.ts` | the local summarizer and local guesses |
| `screen/jev.ts` | Jev questions, state, parse, fallback, breaker |
| `screen/vision.ts` | vision engines, description cleanup |
| `screen/rules.ts` | `screen_stuck`, `screen_interesting` (appended to the reflex's `DEFAULT_RULES`) |
| `screen/intent.ts` | deictic phrases |
| `screen/memory.ts` | what becomes a memory |
| `apps/shell/src/overlay/looking.ts` | the 👀 chip logic |
| `apps/overlay/src/main.ts` | tray "Pause screen", `⌘⇧P` |

## Tests

`bun test packages/core/test/screen.test.ts packages/core/test/screen.reflex.test.ts apps/shell/src/overlay/looking.test.ts apps/overlay/src/screen.test.ts`, plus the simulated hour. Hermetic (fake helper, fake capture, fake Jev, fake vision). Covered: redaction (emails, phones, Luhn cards, SSNs, keys, tokens), denylist (apps, bundle ids, domains, subdomains, titles, screen.json), secure-field skipping (parser and helper source), the summarizer (errors with file and line, shopping, caps, sensitivity), Jev request shape / parse / fallback / timeout / breaker / stuck and sensitive floors, the gateway vision fallthrough, claude CLI args, temp-file deletion (success, throw, failed capture, sweep), the level 2 loop (only-when-changed, stuck growth, private apps before any read, local and Jev sensitivity, inactive / unborn / Eve), level 3 (one window, chip on and off, rate limits, never private / Eve / paused), auto vision off by default and rate limited, pause (screen.pause persisted, attention.pause not, restored on start), the kill switch, the one-time permission line, memory policy, the rules' rate limits, the stuck offer and "yeah" into work mode, "nah", remarks, deep focus, and the ignore-rate property.
