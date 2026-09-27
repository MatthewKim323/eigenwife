# Agency

Act IV: Eve does things. `packages/core/src/agency` provides the `agency` service (`runTask`, `act`), owns every side effect on the machine, and makes consequential ones a spoken beat: she says what she's about to do, you say "yeah", it happens.

```
agency.runTask("just figure out tonight")
  task.start
  ├─ @eigenwife/harem present? ── executeWithHarem(...)  (wives, conflicts, merge; emits task.done itself)
  └─ else built-in swarm:
       swarm.plan  (frontier brain picks 3-4 roles, default plan if it can't)
       MEMORY ─┐   recall prefs          swarm.spawn / status / progress / done
       CALENDAR├── calendar.free_busy    (all three in parallel; PLACES visibly
       PLACES ─┘   places.search          waits on MEMORY for your taste)
       PLAN        aggregate, pick one, swarm.merge
       calendar.create_event ── action.request ─ Eve asks out loud ─ "yeah" ─ action.approval ─ Calendar ─ action.result
       task.done { summary: "7:30 at Tsuki Ramen, $12 spicy tonkotsu, you're free. On your calendar." }
```

`runTask` resolves `{ ok, summary }`. The mind speaks the summary; agency only speaks the approval question.

## Files

| File | What |
|---|---|
| `module.ts` | `agencyModule()`, `createAgency()` (testable core), harem delegation, HTTP routes, optional watcher spawn |
| `gate.ts` | the one door: registry, policy, approvals, execution, trace |
| `policy.ts` | permission classes, deny list, budget |
| `approval.ts` | spoken yes/no classifier + quickJson fallback, operator keys |
| `planner.ts` | built-in parallel planner, demo fallback |
| `osa.ts` | osascript runner, AppleScript/JXA escaping |
| `actions/calendar.ts` | `calendar.create_event` (+ `calendar.create` alias), `calendar.free_busy`, `calendar.delete_event` |
| `actions/web.ts` | `web.search`, `web.scrape` (Firecrawl v2, DuckDuckGo, frontier, plain fetch) |
| `actions/places.ts` | `places.search`: search, extract, rank |
| `actions/apps.ts` | `browser.open`, `app.quit`, `shell.close_app`, `shell.open` |
| `actions/browser.ts`, `browser/`, `cursor.ts`, `pointer.ts` | her visible browser (`browser.task`, `browser.submit`, `browser.close`), her own cursor, pointing while she talks. See [AGENT_CURSOR](AGENT_CURSOR.md) |
| `actions/messages.ts`, `contacts.ts` | `contacts.find`, `messages.send` (iMessage/SMS from matt's Messages app) and the which-one / read-back / edit conversation. See [MESSAGES](MESSAGES.md) |

## Permissions

| Class | Actions | Policy |
|---|---|---|
| `READ` | `web.search`, `web.scrape`, `places.search`, `calendar.free_busy`, `contacts.find` | auto, `action.approval {by:"policy"}`, no budget |
| `SAFE_ACTION` | `browser.open`, `app.quit`, `shell.close_app`, `shell.open` | auto, spends budget |
| `EXTERNAL_SIDE_EFFECT` | `calendar.create_event`, `calendar.create`, `calendar.delete_event` | asks, waits |
| `SENSITIVE_ACTION` | any kind matching send/message/email/sms/post/purchase/buy/pay/order/transfer | asks, waits, never auto even if registered lower |

Before every action:

- **Deny list** (checked for every class): Terminal, iTerm, Warp, System Settings/Preferences, Keychain Access, 1Password, Bitwarden, LastPass, Dashlane, Passwords, Activity Monitor, Disk Utility. Denied means `action.approval {approved:false, by:"policy"}` + a failed `action.result`.
- **Budget**: `EIGEN_ACTION_BUDGET` (default 25) non-READ actions per session.
- **App quit allowlist**: Spotify, Music, Podcasts, TV, Tinder, Hinge, Bumble, Discord, Messages. Browsers are excluded so she can't kill the shell.
- **URLs**: only `http(s)` opens or scrapes.
- **Trace**: every request, decision and result, `GET /api/agency/trace`.

### Approvals

For `EXTERNAL_SIDE_EFFECT` / `SENSITIVE_ACTION` the gate:

1. emits `action.request {needsApproval:true}` and sets world slot `agency.pending_approval` (so the persona brain knows she's waiting on an answer),
2. asks out loud: `speech.say(brains.persona({behavior:"confirm", ...}))`, or `"<description>, yeah?"` without a brain,
3. settles on the first of:
   - `voice.final`: keyword pass (yes: yeah, yes, yep, do it, lock it in, bet, go, sure, ok, sounds good... / no: nah, no, wait, stop, hold on, cancel, not now, don't...). Mixed or unknown ("no wait do it", "i guess that works") goes to `brains.quickJson`; still unclear keeps waiting. Emits `action.approval {by:"voice"}`.
   - `shell.key`: `Enter`/`y` approve, `Escape`/`n` deny (`by:"key"`). Arrows are left to the dating cards.
   - an `action.approval` for this `actionId` from another source (a shell button): adopted, not echoed.
   - 30s of silence: `action.approval {approved:false, by:"policy"}`.
4. Approvals are serialized: she asks one thing at a time.
5. `voiceOnly` actions (`messages.send`): only the spoken yes counts. `Enter`/`y` and another source's `approved:true` are ignored; any no (voice, key, button) still denies.

### Messages

`messages.send` texts people from matt's own Messages app: `SENSITIVE_ACTION` + `voiceOnly`, exact read-back (`text to stephen hung: "yo you up". send it?`), recipient must be a Contacts card and the handle must still be on it at send time (no raw numbers), 5 sends per 10 min, iMessage first with an SMS fallback for phone numbers, her cursor glides to Messages before the send, `EVE_MESSAGES_DRY_RUN=1` stops short of `send`. `contacts.find` (READ) matches the address book inside osascript and returns only the candidates. Edits spoken while she waits ("make it shorter", "add that...") deny that draft and start a fresh request for the new one. Voice phrases, the which-one question, drafting and first-run permissions: [MESSAGES.md](MESSAGES.md).

## Contracts for other modules

- **Harem** emits `action.request` for side effects and never executes them. Agency picks up every `action.request` whose `source !== "agency"`, runs it through the same gate under the requester's `actionId`, and emits `action.approval` + `action.result` with that id. The requester's permission can raise the class, never lower it; if it was understated, agency re-emits a corrected `action.request` (same id, `source:"agency"`) so the shell prompts correctly. Harem's `calendar.create {title, start:"19:30", durationMin, location}` is registered as an alias of `calendar.create_event`.
- **runTask with harem**: agency emits `task.start {brain:"harem"}`, calls `executeWithHarem({taskId, goal, context}, {bus, world, brain, schedule, approvalTimeoutMs})`, and does not emit `task.done` (harem does). `brain` is harem's `ScriptedBrain(DEMO_SCRIPTS)` in demo mode, else the core frontier brain adapted to harem's `structured()` interface. `schedule` is a real `calendar.free_busy` read (cached, 4s cap). If harem throws, the built-in planner runs under the same `taskId`. Harem resolves on approval, so its `task.done` can land a few hundred ms before the calendar `action.result`.
- **Harem loading**: `import("@eigenwife/harem")`, then `packages/harem/src/index.ts` directly (core can't declare harem as a dependency: harem dev-depends on core).
- **Shell**: render `action.request` with `needsApproval` as the pending question, send `shell.key` or `action.approval {actionId, approved, by:"key"}` for operator overrides. `shell.close_app` switches the scene to `desktop`.
- **Mind**: call `ctx.use("agency").runTask(goal, {parent})` on ESCALATE and speak the summary. `agency.pending_approval` in the context block means her last line was a question.

## Actions in detail

**Calendar** (JXA via `osascript -l JavaScript`). Scripts are constants; all user data arrives as one JSON `argv[0]`, so titles like `x" & (do shell script "rm -rf ~") & "` are stored literally. Events go in a calendar named **Eigenwife** (created on first use, falls back to the first writable calendar). `start` accepts `"19:30"`, `"7:30pm"`, ISO, or epoch ms. Calendar.app is slow (1-10s per call; read-only holiday feeds take 10-35s to query), so `free_busy` lists writable calendars, skips holidays/birthdays/Siri suggestions, reads each one in its own `osascript` in parallel with a 20s cap, and reports any calendar it couldn't finish. `EIGEN_CALENDARS=Home,Work` restricts it. First run pops a macOS prompt to let your terminal control Calendar.

**Web**. `web.search`: Firecrawl `/v2/search` when `FIRECRAWL_API_KEY` is set, else DuckDuckGo's HTML endpoint (keyless), else the frontier brain with `tools:"read"`. `web.scrape`: Firecrawl `/v2/scrape` (markdown + optional json schema), else a plain fetch with readability-ish extraction and `quickJson` for the schema.

**Google Calendar via Zo**. With `ZO_API_KEY`, `calendar.create_event` / `calendar.create` book on matt's real Google Calendar (primary, America/Los_Angeles, description notes "booked by Eve") after the same spoken approval, returning the event id + `htmlLink`; `calendar.free_busy` reads Google first; `calendar.delete_event {id}` deletes a Google event. Any Zo failure, or no answer within 8s, falls back to the Calendar.app path above, and a late Google event is deleted so there is no duplicate. Details in [ZO.md](ZO.md).

**Places**. With `ZO_API_KEY`, `places.search` asks Google Maps through Zo first (open now, inexpensive when prefs or memories say saving money, 10 min cache, prefetched once she is born), `source:"zo"`. Otherwise, or when Maps comes back empty, `places.search {prefs:{cuisine, budget, likes, avoid}, location}` searches, extracts `{name, price, cost, rating, address, url, why, dish}` with `quickJson` (frontier as backup), falls back to asking the frontier brain directly, then (demo mode only) a short list marked `source:"demo"`. Ranked by rating, budget fit, and preference words. Location: `EIGEN_LOCATION`, default `Irvine, CA`.

**Degradation**. With only `OPENAI_API_KEY` + local Calendar, the whole flow works (DuckDuckGo + OpenAI extraction). With nothing at all in demo mode (`EIGEN_DEMO` not `0`), the plan still completes: default roles, keyword preference reading, canned places, real Calendar write. Outside demo mode a dead search is an honest `ok:false`.

## HTTP

| Route | |
|---|---|
| `GET /api/page/scrape?url=` | `{ok, url, title, description, markdown, via}`, 10 min cache. For enriching gaze targets. |
| `GET /api/agency/trace` | budget, spent, pending approvals, full trace |
| `GET /api/agency/actions` | registry with effective permission classes |
| `POST /api/agency/task {goal}` | starts `runTask`, returns immediately |
| `POST /api/agency/act {kind, args}` | runs one action through the gate (approvals still apply) |

## Watcher

`watcher/watch.py` posts desktop events to `POST /emit` as `source:"watcher"`:

- `app.opened {app, bundleId}` on launch, `app.focused {app, bundleId}` when an app comes to the front (deduped),
- `media.play {track, artist}` when Spotify or Music starts a new track (polled every 3s, only asks players that are already running).

```sh
uv run watcher/watch.py              # installs pyobjc on the fly (inline script metadata)
python3 watcher/watch.py             # uses pyobjc if installed, else polls lsappinfo
python3 watcher/watch.py --dry-run   # print envelopes instead of posting
bun run dev --watcher                # launched with the rest of the stack
EIGEN_WATCHER=1 bun run core         # or let the core spawn it
```

Flags: `--core URL` (or `EIGEN_CORE`), `--poll`, `--media-interval S` (0 disables), `--once`. No special permissions: NSWorkspace notifications and `lsappinfo` are unprivileged. Media polling uses AppleScript, which asks once for permission to control Spotify/Music.

## Claude Code hooks

`watcher/claude-hook.ts` turns Claude Code activity into Eve's face: `UserPromptSubmit`/`PreToolUse` set `avatar.state thinking` plus a short `diag` ("Edit module.ts", "Bash curl", never the full command), `Stop` sets `avatar.mood happy` and `avatar.state idle`. It has an 800ms budget, prints nothing, and always exits 0, so Claude never notices when the core is down.

To install, add this to `.claude/settings.json` (project) or `~/.claude/settings.json` (everywhere), using the absolute path to your checkout:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "bun /path/to/eigenwife/watcher/claude-hook.ts" }] }],
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "bun /path/to/eigenwife/watcher/claude-hook.ts" }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "bun /path/to/eigenwife/watcher/claude-hook.ts" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "bun /path/to/eigenwife/watcher/claude-hook.ts" }] }]
  }
}
```

`EIGEN_CORE` overrides the core URL (default `http://127.0.0.1:7777`).

## Tests

`bun test packages/core/test/agency.test.ts packages/core/test/agency-watcher.test.ts`. No real side effects: osascript, fetch, `open`, brains, speech and memory are all fakes. Covered: READ/SAFE auto-run, spoken yes/no, quickJson fallback, timeout deny, keys, serialized approvals, deny list, budget, SENSITIVE upgrade, unknown kinds, external (harem) requests and permission-claim correction, argv-only calendar data, free/busy with a slow calendar, Firecrawl/DuckDuckGo/frontier/fetch degradation, place ranking, the scrape route, the full `runTask` event order, harem delegation (demo and frontier brains), harem failure fallback, demo fallback with everything down, AppleScript/JXA escaping, the hook mapping, and watcher parsing.

Manually verified on the dev Mac (2026-09-26): create + delete of a test event through the gate with a spoken approval; the built-in planner and the harem path both creating a real 7:30 event in the Eigenwife calendar after "yeah lock it in" (each deleted afterwards); watcher and hook envelopes landing on a live core.
