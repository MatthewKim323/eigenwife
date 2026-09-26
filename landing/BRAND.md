# eigenwife brand lock

Kawaii sticker system. Eve is the mascot and the ground truth: every asset reuses her.

## Eve (real model only)
The page uses the real Eve from the shell: Haru, the Live2D sample model (Live2D Free Material
License, fine for the hackathon, check before commercial use). Never Alexia on this page:
she's third-party art and the repo rule is her renders are never committed (see docs/WARDROBE.md).

## Media (`media/`)
Real captures of the shell (`apps/shell`, `?model=haru&mic=0&gaze=mouse`), recorded headless with
editskill's browser capture; a mouse hover stands in for the eye tracker. Raw captures live in
`media-raw/` (gitignored). Stills come from `docs/screens/` (committed Haru/shell screens only).
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
