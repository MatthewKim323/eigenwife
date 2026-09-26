# Agent cursor: Eve's own mouse

Eve has her own cursor on your desktop, next to yours, like a second player on the same computer. It rests by her avatar, wanders over now and then, points at what she's talking about, and when she does something (browses a restaurant, plays a song, quits an app) you watch it glide there and click. Her cursor is drawn, never real: your pointer is never moved and no input is ever posted.

![Eve's cursor gliding to her browser's address bar](screens/local/agent-cursor/1-address-bar-glide.png)

(Screenshots live in `docs/screens/local/`, which is gitignored: they show a real desktop.)

## What you see

- **Her pointer.** A soft, rounded arrow in her palette hue with a white edge and a glow, plus a pill tag: **Eve**, and what she's doing (`Eve · shakeshack.com`, `Eve · Menu`, `Eve · "spicy ramen"`).
- **Glides.** 350-700ms scaled by distance (Fitts-ish), on a gentle arc like a wrist, with minimum-jerk speed and a small overshoot that settles onto the target, and a faint comet trail. Idle wandering is 1.6x lazier.
- **Click:** the pointer presses in and springs back, a ring ripples out. **Type:** a blinking caret in her tag and tiny keycap particles. **Scroll:** chevrons. **Point:** a small wiggle and two pulsing rings while she talks. **Hover:** a soft halo.
- **Her browser** gets a glowing frame in her hue and an **Eve's browser** badge, and every tab title starts with `Eve's browser ·`.
- **At rest** she sits beside her avatar (by her hand, on the side facing the screen) and breathes: a pixel or two of drift. She never fades out.

## When it moves

| Mode | What happens |
|---|---|
| rest | beside her avatar, breathing. Follows when you drag her avatar. |
| wander | every 20-60s (first after 15s): over near your cursor for a few seconds (84-124px away on her side, never on top of it, re-aims at most every 800ms for at most 4.5s), or to what her avatar is looking at (a shared glance, a held target, your real gaze) and hovers, or a small loop near home. Then back home. |
| task | the core drives it: browser steps and native actions, in sync with the real thing. |
| point | while she talks about something with a known place on screen (below), then home. At most one point per 12s, never while a task is using the cursor. |
| quiet | you're typing fast (the OS says input in the last second over and over while the mouse sits still) or the frontmost app is fullscreen: she dims to 35% and holds still. |
| hidden | tray **Show Eve's cursor** off, or ⌘⇧E (she and her cursor hide together). Persisted in `~/.eve/overlay.json` as `cursorVisible`. |

What she points at while talking (`packages/core/src/agency/pointer.ts`), first match wins: a fresh `gaze.point` from the eye tracker ("wait what is that"), her browser when she just used it and talks about the page ("the menu is right here"), an app she names or the app you're in when she says "this" (its window, else its Dock spot).

## What she can do

**Her browser** (`eve.browser`, `packages/core/src/agency/browser`). A headful Chromium (playwright-core, Chrome for Testing) with its own profile in `~/.eve/browser/profile` (never your Chrome), on the left half of the main display. Steps:

| Step | |
|---|---|
| `open {url}` | cursor to the address bar, click, "types" the url, navigates (http/https only) |
| `click {selector \| text}` | finds the link / button / tab by name first (off-canvas matches skipped), scrolls it into view, glides, clicks |
| `type {selector, value, enter?}` | glides, clicks into the field, types key by key |
| `scroll {dy, selector?}` | wheel over the element (or the page middle) |
| `read {max}` | title, url and text of HER page, for the task |
| `screenshot` | a PNG of HER page only, saved to `~/.eve/browser/shots/` |
| `wait {ms}` | |

Before every click and keystroke the element's screen position is computed from the page: `window.screenX/Y` + the browser chrome offset (calibrated as `outerHeight - innerHeight * zoom`, side borders split evenly) + the element's viewport box times the page zoom (`devicePixelRatio / dpr at launch`). Then `agent.cursor move` goes out with the glide duration, the core waits for it, emits `click`/`type`, and only then acts (`geometry.ts`, `driver.ts`).

**Agency actions** (through the same gate as everything else, `docs/AGENCY.md`):

| Action | Class | |
|---|---|---|
| `browser.task {steps? \| url? \| query? \| place? \| maps?, budget?}` | `SAFE_ACTION` | browse and read. Step budget 12 (max 30), extra steps are dropped and reported. Full step trace in `data.trace`. |
| `browser.submit {steps}` | `EXTERNAL_SIDE_EFFECT` | anything that commits. `browser.task` stops before a POST form submit, Enter in a POST form, or a button labeled book / reserve / order / pay / checkout / confirm / submit / sign up / send / post / delete..., her cursor hovers over it ("ok to book now?"), and the rest goes through `browser.submit`, which needs your spoken yes. Links are browsing, not submits. |
| `browser.close` | `SAFE_ACTION` | closes her window |

**Native actions.** `music.play` / `music.control` (Spotify), `calendar.create_event` / `calendar.delete_event` (Calendar), `app.quit`, `files.open` (the app, else Finder) declare `cursorApp`. When the cursor layer is up, the gate first looks up that app's biggest on-screen window (CGWindowList bounds and owner names only: no titles, no pixels, no permissions), glides there (or to the Dock when it has no window), clicks, and then the AppleScript does the real work. Approvals still come first for consequential ones.

**The show during "figure out tonight".** When a task looks food-shaped and the cursor layer is watching (or `EVE_BROWSER_SHOW=1`), she opens Google Maps in her browser for the same query while the swarm works, and when the plan's pick arrives (the calendar request, from harem or the built-in planner) she opens that place, checks the Menu tab and hours, and scrolls. It runs beside the task and never delays the answer: the Zo / cached places path stays the data source. `EVE_BROWSER_SHOW=0` turns it off.

**Voice.** "show me", "do it yourself", "open it", "pull it up", "let me see" open the last place she found (or the page you're on) in her browser. "show me ramen places near irvine" searches Maps, "open hacker news in your browser" searches. "show me my resume" is still a file (docs/WORK.md).

## Limits (on purpose)

- The cursor and her browser never read your screen: no screenshots, no screen recording, no OCR, no window titles (screen awareness is a separate, pausable module with its own rules: docs/SCREEN.md). `read` and `screenshot` only ever see her own browser page. Window positions come from bounds and owner names only.
- Nothing about your screen goes anywhere. Her browser's pages go to her own tasks.
- Your cursor is never moved (no CGEvent, no cliclick, nothing that posts input). Her browser gets input over CDP into her page only.
- The cursor layer never takes the mouse: `setIgnoreMouseEvents(true)` without forwarding, not focusable, and nothing turns that off (tested by scanning the layer sources).
- Consequential steps stay behind the spoken approval. Budget and deny list apply as for every action.
- Hidden from screen capture exactly like her avatar ("Hide from screen capture" in the tray, `EVE_OVERLAY_CAPTURABLE=1` for recordings).

## How it's built

```
 core :7777                                    apps/overlay (Electron main)                 cursor window per display
 ─────────                                     ────────────────────────────                 ─────────────────────────
 agency/cursor.ts  AgentCursor ─ agent.cursor ─► layer.ts  BusClient "eve-cursor"  ──IPC──► renderer.ts  CursorSim ─► canvas
 agency/browser/   EveBrowser  ─ agent.browser ►   Presence (rest / wander / quiet)          sim.ts (pure motion + effects)
 agency/pointer.ts speech.begin -> point          TypingDetector (OS idle time)
 gate.ts           cursorApp -> glide, click      fullscreen check (window bounds)
                                                   avatar bounds, look target (page IPC)
```

- `packages/protocol`: `agent.cursor {x, y, space:"screen", action: move|click|type|scroll|hover|point|idle, label?, target?, ms?}` and `agent.browser {status, bounds?}`. `cursor.ts` is the shared motion math (glide duration, arc, minimum-jerk + overshoot), used by the core to time clicks, the layer to draw, and her avatar's eyes to follow.
- The core knows the layer is up because it says `bus.hello {client:"eve-cursor"}`. Without it the core skips window lookups and the show (tests never launch a browser).
- Her avatar's look arbiter: `agent` sits between `hold` and `gaze`, so while she acts she watches her own cursor along the same glide, then lets go on idle (or 3.5s after her last action).
- The page reports what her avatar is looking at (`eveOverlay.reportLook`, at most 2Hz) so the idle wander can go there.

## Run it

```bash
bun run dev && bun run overlay            # the cursor layer starts with the overlay
bun run scripts/agent-cursor-demo.ts      # she browses a public restaurant page (no submits)
bun run scripts/agent-cursor-demo.ts --maps "cheap spicy ramen near Irvine, CA"
bun run scripts/agent-cursor-demo.ts --native Finder --close
```

Next to a core you're already using: an agency-only core and a cursor-only overlay instance.

```bash
EVE_OVERLAY_CURSOR_ONLY=1 EVE_OVERLAY_INSTANCE=demo EVE_OVERLAY_CAPTURABLE=1 \
  EVE_OVERLAY_URL="http://127.0.0.1:5173/?mode=overlay&core=127.0.0.1:7788" bun run overlay
bun run scripts/agent-cursor-demo.ts --standalone --core 127.0.0.1:7788 --close
```

| Env | |
|---|---|
| `EVE_CURSOR_LAYER=0` | no cursor layer |
| `EVE_OVERLAY_CURSOR_ONLY=1` | only the cursor layer (no avatar, tray, hotkeys, mic) |
| `EVE_OVERLAY_INSTANCE=name` | a second overlay with its own profile and single-instance lock |
| `EVE_BROWSER_SHOW=0/1` | the visible browse during tasks: off / on even with nobody watching |
| `EVE_BROWSER_EXECUTABLE` | a different Chromium for her browser |

Her browser needs playwright-core's Chromium once: `bunx playwright-core install chromium`.

## Extend it

- **A new browser step:** add it to `BrowserStep` and `EveBrowser.step()` (glide first, then act), allow it in `normalizeSteps`, test it against the fake backend in `packages/core/test/agent-cursor.test.ts`.
- **A new native action with a cursor:** give its `ActionDef` a `cursorApp(args)` returning the app name. The gate does the rest.
- **Something new to point at:** add a source to `where()` in `pointer.ts` (it needs a screen point, never screen contents).
- **Presence behavior:** `apps/overlay/src/cursor/presence.ts` is pure; tune `PRESENCE` and extend `presence.test.ts`.
- **Look:** paint only in `renderer.ts`; anything that moves belongs in `sim.ts` with a test.

## Tests

`bun test packages apps/shell/src apps/overlay/src`: glide math (duration range and monotonicity, arc side, minimum jerk, overshoot and settle, no teleports); page to screen with chrome offset, zoom and DPR, screenshot pixels, side borders; the JXA reading bounds but never titles or pixels; cursor event order (move before click before the real click, address bar before navigation, glide before typing); step budget; optional steps; submit stops and asks (no yes, no click; spoken yes, click); POST-form Enter vs search Enter; native glide before the AppleScript, none when nobody watches; the show during a task and not without a watcher; voice intents; pointing (app window, gaze, rate limit, busy, not watching); presence (appear at home, wander cadence, polite follow distance, look hover, quiet, hidden, avatar dragged, point then home, silent core); typing detector; renderer sim (enter, glide, press, ripple, particles, caret, scroll, idle, dim, breathing, browser frame); the layer window never taking input.

Verified on the dev Mac (2026-09-26): an agency-only core plus a cursor-only overlay instance; her Chromium opened on the left half with the glowing frame, her cursor glided to the address bar (`Eve · shakeshack.com`), scrolled, clicked a menu card next to matt's real cursor, read the page, then rested by home. Everything was quit afterwards.
