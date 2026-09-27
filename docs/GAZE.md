# Gaze

Two gaze paths feed the same event, `gaze.target`. The reflex takes it from there.

| Where you're looking | Who resolves it | How |
|---|---|---|
| Inside the shell page | `apps/shell/src/gaze/bridge.ts` | `eye-client.js` hit-tests `[data-gaze]` elements (DOM). |
| Anywhere else on screen | `packages/core/src/gaze` (desktop gaze) | `eye serve` fixations, then `screen-ax at x y`, the accessibility element under the point. |

Points over Eve's own windows (the overlay, the shell tab) are skipped by desktop gaze, so the two paths never double up.

## What she does with it (reflex, `packages/core/src/reflex`)

| Held on the same thing | Rule | What happens |
|---|---|---|
| 2.5s | `stare_glance` | She glances at it too (`avatar.look`). In the overlay, desktop targets carry `meta.point`, so she looks at that spot on your screen. |
| 4s (`EIGEN_STARE_MS`) | `stare` | She notices out loud ("hm. devpost? what are you cooking."), but only if the last stare was 3+ minutes ago and nobody spoke in the last 6s. Otherwise she stays quiet. |

Only content counts. Buttons, menus, toolbars and the dock are `ui`/`app` and never trigger a stare. In a simulated hour of constant staring she speaks 2-4 times and ignores about 87% of ambient triggers.

## Desktop gaze pipeline

```
eye serve (ws :8765)  fixation_start {x,y}  gaze {valid, fix}  face
        │
        ▼
DesktopGaze (pure state machine, desktop.ts)
  settle 350ms -> resolve once (re-resolve only if the eyes drift > 90pt)
  re-announce every 1.2s while you keep looking (dwellMs grows)
  blinks don't break a stare; losing your face / head out of range does
  look back within 1.5s = same stare
        │ resolve(x, y)
        ▼
module.ts  pause? -> screen-ax at -> private/secure? -> Eve? -> privateReason -> redact -> GazeTarget
        │
        ▼
gaze.fixation / gaze.target / gaze.fixation_end / gaze.lost / eye.status on the bus
```

`screen-ax at` (in `watcher/screen-ax.swift`, the same helper the screen sense compiles) walks up from the hit element to the first thing a person looks at. That's a link, button, image, cell, row or heading, or anything at least the size of the gaze error circle, so a 150pt-accurate gaze never resolves to one glyph. For big text areas that support it (editors, text views) the label is the line under the point. Terminals that don't support it are labeled by window: `the Ghostty window "eigenwife"`.

Target keys are content-based (`desk:<app>:<role>:<hash of label+title>`), so frame jitter between lookups doesn't restart a stare.

## Privacy (shared with the screen sense, `packages/core/src/screen`)

Checked in this order, before anything is emitted:

1. **Paused**: `screen.json` paused, the tray / ⌘⇧P `attention.pause`, the screen service, or `EVE_SCREEN=0`. Nothing is resolved at all.
2. **Secure field anywhere on the path** (`AXSecureTextField`): the helper returns `private:true` without reading any text.
3. **Denylisted host** (`PRIVATE_DOMAINS` plus your `screen.json` domains): the helper stops, no text.
4. **Eve's own windows**: skipped (the shell does its own DOM gaze).
5. **`privateReason`**: private apps (password managers, Messages, Mail, banks...), your denylisted apps, private titles ("Sign in to...").
6. **Redaction**: the label and title go through `redactScreenText` (keys, tokens, card numbers...).

A private hit is never announced, and it breaks any stare in progress (`gaze.lost {reason:"offscreen"}`).

## Run

```bash
cd eye && uv run eye calibrate --no-expressions   # ~2 min, once per seat
uv run eye serve                                  # :8765
bun run dev                                       # core picks it up on its own
curl localhost:7777/api/gaze/status               # fixations, resolves, current target
```

`EVE_DESKTOP_GAZE=0` turns desktop gaze off. `EYE_URL` points it at another eye server. It needs the Accessibility permission for the app you run core from (the same one the screen sense needs).

## Shell (browser) notes

`eye-client.js` maps gaze only in **real document fullscreen at 100% zoom** on the calibrated display. The boot "begin" click requests fullscreen. The HUD shows the tracker's reason when gaze is off (`eye: enter fullscreen`, `eye: sit where you calibrated`), and `eye.status` carries `valid`, `reason`, `guidance`, `uncertaintyDeg`.
