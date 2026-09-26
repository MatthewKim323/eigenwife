# Wardrobe, touch and where she looks

Eve has outfits she wears until you tell her otherwise, reacts when you poke or pat her, and follows your cursor around the screen.

Screenshots of the default local model (Alexia, third-party art) are **never committed**. Regenerate them locally into `docs/screens/local/` (gitignored), see [Capture](#capture).

## Outfits

Outfits change **only when you ask**: by voice, from the overlay tray, or through the `avatar.wear` action. There are no time-of-day, mood or self-chosen changes.

### Catalog

`packages/protocol/src/wardrobe.ts` is the model-independent catalog, shared by core and shell. Items in one slot are exclusive (the later one wins); `conflicts` adds cross-slot exclusions.

| Item | Label | Slot | Alexia expression |
|---|---|---|---|
| `hoodie` | cat hoodie (hood down) | top | `yfmz` (Param16 + Param17) |
| `hood_up` | cat hoodie, hood up | top | `yf` (Param16) |
| `sunglasses` | sunglasses | eyewear | `dyj` (Param64) |
| `sunglasses_up` | sunglasses pushed up | eyewear | `mj` (Param11) |
| `lollipop` | lollipop | prop | `bbt` (Param60) |
| `odd_eye_left` | violet left eye | eyes | `yjys1` (Param62) |
| `odd_eye_right` | violet right eye | eyes | `yjys2` (Param63) |

Each model maps the items it can show in `ModelDef.wardrobe` (`apps/shell/src/avatar/models.ts`, built with `wear(id, expression)`). Haru has `{}`: anything asked of her is a no-op and she says she can't.

### Voice

Parsed by `packages/core/src/reflex/outfit.ts` (keyword based, part of `readIntent`), routed by the reflex as `ACT` (local, never waits on remote Jev). She changes first, then says one short in-character line (persona brain with what she now wears as facts, scripted fallback).

| Say | Result |
|---|---|
| "put your hoodie on", "put your pajamas on", "get comfy", "cozy clothes", "hood down" | `hoodie` |
| "hood up", "put your hood up" | `hood_up` |
| "wear your glasses", "shades on", "put on your sunglasses" | `sunglasses` |
| "push your sunglasses up", "shades up" | `sunglasses_up` |
| "grab a lollipop", "have some candy" | `lollipop` |
| "try the odd eyes", "violet right eye" | `odd_eye_left` / `odd_eye_right` |
| "lose the sunglasses", "sunglasses off", "take off the hoodie" | removes that item (both variants) |
| "take it off", "normal clothes", "change back" | removes everything |
| "change clothes" | hoodie on, or back to normal if a top is on |
| "what are you wearing" | answers from the slot, changes nothing |
| "wear a dress" (anything not in the catalog) | says she doesn't have one and offers what she has |

"should i wear a dress", "i bought sunglasses", "take it off my calendar" are not outfit requests.

### Core (`packages/core/src/wardrobe/module.ts`)

- State `{ items, by, updatedAt }` in home as `wardrobe` (`~/.eve/wardrobe.json`). On start it's restored (sanitized through the catalog) and announced as `avatar.outfit { items, by: "restore" }`.
- Service `wardrobe`: `get()`, `available()`, `wear({ add?, remove?: [] | "all" }, by)`. Every change emits `avatar.outfit { items, by: "user" | "agent" }` (full state, not a delta) and persists.
- World slots: `wardrobe.wearing` ("cat hoodie, sunglasses") goes into every persona prompt, so she knows what she has on and can joke about it; `wardrobe.items` (ids) lets a shell that connects later pick the outfit up from the welcome snapshot.
- `avatar.model { id, wardrobe }` from the shell narrows `available()` to what the loaded model can show.
- `GET /api/wardrobe` -> `{ items, wearing, catalog: [{ id, label, slot, on }] }`. `POST /api/wardrobe { add?, remove?, set? }`.
- Action `avatar.wear { add?, remove? }` (`packages/core/src/agency/actions/wardrobe.ts`): `SAFE_ACTION`, no approval. Voice and the tray call the service directly so outfit changes don't spend the session's action budget.

### Tray

Overlay menu bar heart > **Outfit**: a checkbox per item the model can wear, plus "Back to normal". It polls `GET /api/wardrobe` every 4s, so voice changes show up there too; clicks `POST /api/wardrobe`.

### Rig (`apps/shell/src/avatar/wardrobe.ts`)

Pipeline: `motion -> face rest -> emotion pose -> wardrobe -> blink -> look-at -> mouth -> breath`.

- The wardrobe layer is applied every frame right after the mood poses, with the exp3 blend semantics (Alexia's toggles are `Add +30` on a 0..30 switch). It fades ~250ms (`WARDROBE_FADE_MS`), crossfading within a slot.
- Face rest pinning never touches it (none of its params are in `faceRest`), and moods never clear it: the outfit is its own state, not a mood.
- **The sunglasses rule.** While a slot is worn, the wardrobe owns that slot's parameters and fades out whatever the mood pose did to them. Alexia's `smug` mood uses `dyj` (sunglasses on) as a flourish: with nothing on her eyes, smug flashes sunglasses and they go when smug fades; with `sunglasses` worn, smug neither doubles nor removes them (they stay after smug); with `sunglasses_up` worn, smug can't put a second pair on her face.
- Accents (`ModelDef.accents`, Alexia: `blush: lh`, `sweat: h`) are short pulses on the same layer (head pat blush).
- `__eve.wear(items)` / `__eve.wearing()` set it locally for capture (the core's next `avatar.outfit` wins).

## Touch (`apps/shell/src/avatar/touch.ts`)

All subtle and rate limited. Asleep, she doesn't react.

| What | Reaction |
|---|---|
| Hover onto her | a tiny smile or a "hm?" blink, alternating, at most every 8s |
| Click her body | a startled blink + a small hop (no partial "surprised" pose: on toggle expressions like Alexia's star eyes it would ghost) |
| Click her head | head pat: happy, blush (`lh`), eyes shut ~1.3s |
| 3+ clicks within 4s | annoyed (`sq`), and `avatar.poke { region, count }` to the core (at most every 20s from the shell); the reflex rule `poked` says one scripted line ("okay. stop poking me.") with a 30s cooldown |
| Drag start / drop (overlay) | surprised / settles with a hop |

Regions: the head is an ellipse from the registry framing (`framing.head` + `ModelDef.headShape`, default `{ rx: 0.055, ry: 0.068, dy: -0.03 }` of model height), the body is her painted pixels. In the overlay only her painted pixels ever take the mouse (click-through unchanged: `ClickThroughGate` still decides). In the shell's desktop column she stays `pointer-events: none`; clicks and hovers are matched geometrically (head ellipse + a body column) and never when the pointer is on real UI (buttons, links, inputs, `[data-gaze]`).

## Where she looks (`apps/shell/src/avatar/look.ts`)

A pure look-source arbiter, highest priority first:

1. **glance**: an explicit short shared-attention target (`avatar.look`, a new `gaze.target` element)
2. **hold**: watching the swarm while acting
3. **gaze**: the user's real gaze point (`gaze.point`), while fresh (600ms)
4. **cursor**: the mouse anywhere on screen, until it rests for 4s
5. **idle**: back at the user (camera, top-center), with a short glance around every 6-14s

While tracking (gaze, cursor, idle glances) her eyes follow fully and her head at ~0.5x (`RigInput.headGain`), clamped to a natural range (`x` 0.9, `y` 0.6), smoothed by the existing look-at spring, with micro-saccades on top. Explicit glances keep the full head turn.

- Overlay: main polls `screen.getCursorScreenPoint()` ~30Hz while she's visible (only sends when it moved) over IPC `overlay:cursor` / `eveOverlay.onCursor`. Everything is in screen points: head = window origin + head in the page.
- Shell: window `pointermove` in viewport px, in every dock.
- Plugging in a gaze tracker: emit `gaze.point { x, y }` (screen points for the overlay, viewport px for the shell). `useGazeFeed` already calls `arbiter.gaze()`.

## Capture

Serve the real local model without committing it (worktrees: symlink it, the path is gitignored):

```bash
ln -s ~/dev/eigenwife/apps/shell/public/avatar/local apps/shell/public/avatar/local   # worktree only
bun run --cwd apps/shell dev
```

Open `?scene=emergence&stay=1&mic=0&model=alexia`, hide everything but `.eve-layer`, then `__eve.hush(); __eve.state("idle"); __eve.still(true); __eve.frame("stage")` and per shot `__eve.wear([...])`, `__eve.mood(m, 1, 600000)`, `__eve.touch("pat" | "poke" | "annoyed")`, element screenshot of `.eve-box`. Save to `docs/screens/local/wardrobe-*.png` (gitignored). `__eve.still(false)` + moving the mouse shows cursor tracking.

## Tests

`packages/core/test/wardrobe.test.ts`: slot exclusivity, conflicts, persistence + restore, sanitizing, Haru no-op, `/api/wardrobe`, `avatar.wear` without approval, spoken intent table (and non-requests), reflex end to end (change + line, ask, missing item, take it off, change clothes, moods/time never change the outfit), poke rule cooldown. `apps/shell/src/avatar/wardrobe.test.ts`: registry mapping, fades, rig layer with moods, the sunglasses rule, crossfade, Haru no-op, outfit before model load, head/body regions, poke counting and rate limits, hover limiter, pat/poke effects, look arbiter priority, idle glances, head gain.
