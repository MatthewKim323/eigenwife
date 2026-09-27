# eigenwife brand lock

Kawaii sticker system. Eve is the mascot and the ground truth: every asset reuses her.

## Eve (real model only)
Eve on this page is Alexia, the shell's current model (matt's call, 2026-09-26). Heads up: the
repo's rule elsewhere (docs/WARDROBE.md) keeps Alexia renders out of git as third-party art;
these landing media are the deliberate exception.

## Media (`media/`)
Real captures of the shell (`apps/shell`, `?model=alexia&mic=0&gaze=mouse`), recorded with
editskill's browser capture patched to new-headless Chromium on the real GPU
(`channel: 'chromium'`, `--use-angle=metal`); without it there's no WebGL and the shell shows a static fallback; a mouse hover stands in for the eye tracker. Raw captures live in
`media-raw/` (gitignored). Moods are rendered from the live rig via `window.__eve.mood()`; wardrobe from docs/screens/local.
Re-shoot: scenes `dating`, `convergence`, `emergence`, `desktop`; encode 1280w h264 crf 27 faststart.

## Palette
| role | hex |
|---|---|
| paper | #fff6fa |
| cloud | #ffffff |
| soft | #ffe3ef |
| hairline | #f6cfe0 |
| muted | #7d5f72 |
| ink | #3a2436 |
| pink (accent-300) | #ff9cc4 |
| hot (accent-500) | #ff5fa2 |
| hot-deep (accent-700 / shadow) | #d63a82 |
| lilac / lilac-deep | #c9bbff / #6b4fd8 |
| mint, butter (props) | #aef0d8, #ffe59a |

## Treatment
Thick ink outlines (4-5px at 240px), white die-cut keyline, hard offset shadow (ink on
cards, hot-deep on the wordmark). Type: Fredoka (display), Nunito (body), JetBrains Mono
(diagnostics like `LATENT PARTNER MODEL 98%`, the one uncanny-OS note).

## Props
eye, eigenvector arrow, sparkle, heart, cursor, speech bubble, ramen bowl, calendar.

## Higgsfield prompts (when the MCP is connected; attach eve.svg rendered to PNG as reference)

Logo:
```
create an original kawaii sticker logo for "eigenwife".
product: a persistent AI companion compiled from where your eyes linger
mood: cute, cheeky, slightly uncanny, techy
mascot: Eve, chibi girl with pink side-tail hair, pink bow, arrow-shaped ahoge, violet-pink heart-lit eyes, peeking over the wordmark
palette: hot pink #ff5fa2, pink #ff9cc4, deep violet #6b4fd8, ink #3a2436, paper #fff6fa, shadow #d63a82
props: eye, arrow vector, sparkle, heart
chunky rounded bubble wordmark, exact text "eigenwife", "eigen" pink and "wife" violet, thick white die-cut keyline,
hard offset shadow #d63a82, slight bounce and rotation, flat vector rendering, transparent background.
original design, no imitation of any public artist or source image, no photorealism, no thin lines, no extra words.
```

Mascot poses (keep identity, palette, outline, sticker border): waving; thinking with a
tiny calendar; side-eye at a dating app ("...seriously?"); holding a ramen bowl; asleep on
a tiny computer (Zo). Transparent PNG, full body, no text.

## Under the hood (dark section)
Built from matt's design vault (/Volumes/Vault/vaultdev/design): Strand's dark warm palette and
hairline bento (40px cells, fixed-height visuals on an 8px dot lattice, house ease
`[0.12, 0.23, 0.5, 1]`), its entity-resolution graph, live activity feed, anomaly chart with
baseline band + tooltip, severity-score bars and relationship chain + detail card; Clerk's
laptop -> "Authenticating..." -> server racks row. Pink #ff5fa2 replaces Strand's green as the
one accent; green stays only for live dots. Loops rest between beats and pause off screen.
