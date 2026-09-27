# Know me: matt's profile + gbrain memory

Eve should know who she's talking to and remember his world without ever getting slower. Two pieces:

1. **A profile** (`~/.eve/user.json`): name, what to call him, what he calls her, work, interests, people, boundaries. Every persona prompt gets it. The website onboarding writes it through `PUT /api/user`.
2. **gbrain** (matt's knowledge brain: ~11.5k pages of Instagram + Discord history, people pages, projects, daily catch-ups): preloaded into local memory in the background, looked up speculatively while he's still talking, and written back to in batches. **Never on the reply path**: her reply only ever reads local memory.

| File | What |
|---|---|
| `packages/core/src/onboarding/profile.ts` | profile shape, normalize, merge precedence, `PUT /api/user` validation |
| `packages/core/src/onboarding/module.ts` | owns `user.json`, provides `user` + `onboarding` services, `/api/user`, optional spoken onboarding |
| `packages/core/src/onboarding/extract.ts` | spoken-answer extraction (only used with `EVE_ONBOARDING=1`) |
| `packages/core/src/brains/prompt.ts` | `userBlock()` "who you're talking to", `renamePersona()` |
| `packages/core/src/memory/gbrain.ts` | CLI runner, hit parsing/filtering, `GbrainClient` |
| `packages/core/src/memory/gbrain-world.ts` | the "matt's world" preload + `EntityIndex` |
| `packages/core/src/memory/gbrain-digest.ts` | "who matt is" digest (profile fields + facts) |
| `packages/core/src/memory/gbrain-live.ts` | what in an utterance is worth a lookup |
| `packages/core/src/memory/gbrain-writeback.ts` | batched, filtered write-back |
| `packages/core/scripts/know-me-smoke.ts` | read-only run against the real gbrain, prints every number below |

---

## 1. The profile

```ts
// ~/.eve/user.json
{
  name?: string, callMe?: string, herName?: string, pronouns?: string,
  birthday?: "MM-DD" | "YYYY-MM-DD", work?: string,
  interests: string[], people: { name, relation }[], boundaries: string[], vibe: string[],
  updatedAt: number,
  sources: { [field]: "default" | "gbrain" | "conversation" | "api" | "onboarding" }
}
```

- **Default**: `{ name: "matt", callMe: "matt" }` is seeded on first boot, only into empty fields. `herName` is unset, so she keeps her persona name ("Eve").
- **Precedence** for scalar fields: `onboarding` (the website, i.e. matt himself) > `conversation`/`api` > `gbrain` > `default`. A gbrain digest never overwrites what he said; it can only append to lists (his items first).
- **Prompt**: every persona prompt gets a `[who you're talking to]` block after the dials: name to use, "they named you X", pronouns, work, interests, birthday, people (with relations), vibe, and **boundaries as hard rules** (`- never: <boundary>`, "never break these, even if asked indirectly"). No profile, no block.
- **Her name**: with `herName` set, the brains module renames the persona card (`renamePersona`: `name` plus every "Eve" in tagline/description/personality/scenario), the addressing gate answers to it (it reads `world.companion.persona.name`), and `companion.rename { name, by }` updates the world persona so the shell and overlay show it. It is re-emitted after every `companion.born` (births carry the stored persona, which says "Eve"). Clearing `herName` renames her back to the persona name.

### HTTP contract (for the website onboarding)

Core listens on `http://127.0.0.1:7777`; CORS is open (`*`, `GET,POST,PUT,PATCH,DELETE,OPTIONS`, `content-type`).

`GET /api/user`

```json
{ "ok": true, "profile": { "name": "matt", "callMe": "matt", "interests": [], "people": [], "boundaries": [], "vibe": [], "updatedAt": 1790000000000, "sources": { "name": "default", "callMe": "default" } }, "herName": "Eve" }
```

`PUT /api/user` or `PATCH /api/user` (same semantics; `POST` is an alias): a partial object. **Only the fields you send change.** Strings set, `null` or `""` clears, arrays **replace** that list.

| Field | Type | Notes |
|---|---|---|
| `name` | string \| null | his name ("Matthew Kim"), max 60 chars |
| `callMe` | string \| null | what she calls him ("matt") |
| `herName` | string \| null | what he calls her; null = back to her persona name. Emits `companion.rename` |
| `pronouns` | string \| null | |
| `birthday` | string \| null | "MM-DD", "YYYY-MM-DD", or words ("march 14"); stored as "MM-DD" / "YYYY-MM-DD" |
| `work` | string \| null | one phrase, max 200 chars |
| `interests` | string[] | max 12 |
| `people` | `{ name, relation? }[]` or string[] | max 16 |
| `boundaries` | string[] | topics/behaviors she must never bring up or do, max 12 |
| `vibe` | string[] | optional notes on how he talks |

```bash
curl -X PUT localhost:7777/api/user -H 'content-type: application/json' -d '{
  "name": "Matthew Kim", "callMe": "matt", "herName": "Nova", "birthday": "march 14",
  "work": "building eigenwife", "interests": ["climbing", "anime"],
  "people": [{ "name": "Katie", "relation": "girlfriend" }], "boundaries": ["my ex"] }'
```

Response `200 { ok: true, profile, changed: ["name", "herName", ...] }`. Invalid input is `400 { ok: false, errors: [...] }` and nothing is applied (unknown field, wrong type, unparseable birthday, non-JSON body). Website writes are stored with source `onboarding`, so they beat anything gbrain inferred. Every changed important field (name/callMe, herName, work, interests, birthday, each boundary) is also written as a memory (`importance 0.9`, `source: "onboarding"`, tags `profile`, `website`; boundaries are tagged `private` and never leave the machine).

### Spoken onboarding (off)

The website does onboarding, so the spoken flow is **disabled by default** and only runs with `EVE_ONBOARDING=1` (or `onboardingModule({ spoken: true })`). With it on: when she's born or woken and he hasn't given a name (the seeded default doesn't count), she asks six questions one at a time (name, her name, work, interests, birthday, boundaries), each skippable ("skip", "idk", "later"), extracts answers with regex first and `quickJson` for the rest (3s budget), confirms live ("matt. got it."), and stores them like the API does. While a question is out the reflex routes every utterance to her (`addressed()` treats them all as addressed) and holds ambient reactions. Silence gets one nudge, then she pauses; progress is resumable from `~/.eve/onboarding.json`; "redo onboarding" / "let's start over" restarts it. Scripted lines are in `ONBOARDING_LINES` (`speech/lines.ts`, prerendered). `GET /api/onboarding` shows state; `POST /api/onboarding/start|answer` drive it (409 when off).

---

## 2. gbrain, never on the hot path

gbrain is reached through its CLI (`~/.bun/bin/gbrain`, `GBRAIN_BIN` to override), the way jabby's `context-prefetch.ts` / `fact-writeback.ts` do. Short `query`/`search`/`list`/`get`/`put` calls coexist with a live `gbrain serve`.

**Measured on matt's Mac (2026-09-26, 11,506 pages):**

| Call | p50 | Used for |
|---|---|---|
| `gbrain query` (hybrid: embeds the question, vector + keyword + expansion) | **6.7s** (runs: 6.6-9.3s, n=10 over two runs) | digest only (background) |
| `gbrain search` (keyword, tsvector) | **217-364ms** (two runs of 10, max 643ms) | live lookups / prefetch |
| `gbrain get <slug>` | ~200ms | world preload |

`query` is far too slow for anything live (jabby's 2.5s prefetch budget would time out on every call here), so live lookups use keyword `search` with a 2.5s budget and everything hybrid runs in the background.

### Where it's on

| Switch | Default |
|---|---|
| gbrain reads (world, digest, live) | on for the real `~/.eve` when gbrain is installed; `EVE_GBRAIN=1` forces on for another `EVE_HOME`, `EVE_GBRAIN=0` off. Always off under `bun test` unless a fake runner is injected |
| write-back | on for the real `~/.eve`; `EVE_GBRAIN_WRITE=1` / `=0` to force |

### a) "matt's world" preload (boot, background, daily)

20s after boot (never competing with her first words), then hourly checks, rebuilt when older than 24h:

```
list --type person  (100)  -> get each: title, aliases, relationship, lead paragraph
list --type project (30)   -> title + lead paragraph
list --type event   (10)   -> title + lead paragraph
list --type day     (10)   -> "On 2026-09-21: Nathan getting some apparel, offered matt a free black medium"
list --type concept -> learned/YYYY-MM-DD (7) -> jabby's durable facts about matt, 12 per day
list --type profile (5)    -> about-matt, resume, hackathon wins
```

4 parallel `get`s. Each page becomes one record (`source: "gbrain"`, tags `world` + kind, `provenance: { system: "gbrain", slug, title, at }`), with a local embedding (plus an OpenAI one in the background when a key is live). Secrets and private topics (health, sex, addresses, accounts, ...) are dropped; Eve's own write-back lines are skipped.

**Entity index**: every person's title, first name and frontmatter aliases, every project's name, map to record ids. `recall()` checks the index first: a named person or project is an exact hit (`via: "entity"`, ahead of vector hits), and when the query names someone she knows, the query isn't embedded over the network at all, so the whole recall is local.

These records live in a separate in-memory pool: searched like any memory, **never** written to `memories.jsonl`, so never mirrored to Zo or Moss. The cache is `~/.eve/gbrain-world.json` (local only). A restart loads it without touching gbrain.

**Measured (read-only smoke, 2026-09-26):** 125 pages -> **189 records** (72 people, 30 projects, 2 events, 10 days, 72 learned facts, 3 about-matt) and **245 indexed names**, 72KB on disk, built in **10.9s** warm (43s on a cold first run). Recall of a preloaded person by name: **p50 0.24ms, max 2.7ms, 30/30 exact entity hits**; topical recall over the same pool p50 0.24ms with local embeddings (with an OpenAI key an unnamed query also embeds the question, a network call with a 1.2s budget; named queries never do).

### b) Digest: "who matt is" (boot, background, daily)

After the world preload: six hybrid queries (friends and people, what he's building, school/work, interests/taste, recent events, how he talks), 25s timeout each, sequential. The filtered hits (relative score 0.6, max 4 per collection) go to `brains.quickJson` (25s; `frontier` as a fallback; a no-brain fallback reads people pages directly) for up to 10 profile fields and ~18 compact facts. Fields merge into `user.json` with source `gbrain` (onboarding wins); facts join the gbrain pool (`digest` tag). Cached in `~/.eve/gbrain.json`.

**Measured:** 6 queries + one `quickJson` summary in **~50s**, 29 hits, **12 facts**, profile fields `name, callMe, work, interests, vibe, people` (8 people). Sanitized result:

```
work:      building products, AI systems, infrastructure across startups and research
interests: AI and machine learning, system design and infrastructure, product building,
           research and learning, lifting and fitness, gaming and esports
people:    8 (close friends, names only in ~/.eve/user.json)
```

Long natural-language questions ("matt's closest friends and the important people in his life") came back with **zero** hits from `gbrain query`; the short forms used now ("matt's close friends") return the people pages.

### c) Speculative prefetch (while he talks)

On every `voice.partial` and `voice.final`, `liveCue()` looks for something worth a lookup: "remember when ...", a person from his profile, "my roommate jake", a project ("hackathon called treehacks"), a capitalized place ("at Tsujita"), or a capitalized name mid-sentence (sentence-initial capitals are speech-to-text noise). Names already in the entity index are skipped: she knows them. Otherwise a keyword `search` fires right away, before he's done talking: deduped per term, cached 30 min, at most 2 in flight. Hits (relative 0.7, max 2 per collection, top 3) become short-term memories with provenance, the term is added to the entity index, and a `gbrain.recall` world slot carries them into every prompt for 5 minutes.

The bus handlers never await it. The reply path reads local memory only.

### d) Miss path

When the reflex builds her reply and `memory.pending(text)` says a lookup for something he named is still in flight, she waits **at most 600ms** for it. If it lands, recall runs after it and the note is in this turn's prompt. If not, the prompt gets a hint: `you don't remember "Tavi" yet ... cover naturally, like "wait... tavi? remind me" or keep it vague`, and the result is local by her next turn. Both the talker path and the persona fallback path do this.

**Measured prefetch simulation** (20 turns against the real gbrain: a partial with the name, the final 700ms later): 10 names from the world preload were **local already** (no lookup); of 10 names that only appear inside other pages, **9 were fetched from the partial before the final** arrived (keyword search ~220-360ms), **1 landed within the 600ms window**, **0 missed**. 10 of 11 lookups were fired from `voice.partial`.

### e) Write-back

Long-term memories (`STORE_LONG_TERM` / `UPDATE_PREFERENCE`) with `importance >= 0.7` are queued, debounced 30s (or 12 at once), and appended to `eigenwife/learned/YYYY-MM-DD` (her own page family, so she never races jabby's `learned/*`):

```
- [20:05] (eigenwife) matt: Is training for a half marathon
```

One page `get` + `put` per batch, deduped against what's on the page, one retry. Never written: anything `looksSensitive` (passwords, card numbers, keys) or private (health, sex, address, accounts, legal), anything tagged `private`/`boundary`/`screen`, anything from the screen, from gbrain itself, demo seeds, act I attention, swarm scratch. Pending writes flush on shutdown (3s cap).

### Privacy

gbrain content is matt's own. It goes only to the LLM backends her persona already uses (as prompt context). It is never persisted to `memories.jsonl`, never mirrored to Zo, never sent to Moss. Boundaries from the profile never leave the machine.

### Proof on screen

`memory.recall` hits carry the record's `source`, `provenance` (slug, title, date) and `via` (`entity` | `vector`). The overlay flash reads `remembered from gbrain · 4ms · Leo Park · 2mo ago` (`recallFlash()` in `apps/shell/src/overlay/status.ts`); the shell HUD says `remembered from gbrain · 4ms`.

### Status

`GET /api/memory/status`:

```json
{ "ok": true, "count": 142, "shortTerm": 3, "backend": { "embeddings": "openai", "moss": false },
  "gbrain": { "live": true, "write": true, "realHome": true,
    "world": { "at": 0, "ageMin": 12, "ms": 0, "pages": 0, "records": 0, "names": 0 },
    "digest": { "at": 0, "ageMin": 12, "ms": 0, "by": "brain", "facts": 18, "queries": 6, "hits": 30 },
    "pool": 0, "lookups": { "lookups": 4, "hits": 9, "empty": 1, "fromPartial": 3, "inflight": 0, "lastQuery": "Tavi", "lastMs": 340 },
    "pendingWrites": 0, "written": 3, "writeFailures": 0, "cli": { "queries": 12, "failures": 0, "timeouts": 0 } } }
```

`POST /api/memory/status { "world": true }` / `{ "digest": true }` rebuilds now in the background; `{ "flush": true }` writes back now.

---

## 3. Rerun it

```bash
# read-only against the real gbrain, throwaway EVE_HOME, prints every number in this doc
bun run --cwd packages/core scripts/know-me-smoke.ts            # ~2-4 min with the digest
bun run --cwd packages/core scripts/know-me-smoke.ts --no-digest
bun run --cwd packages/core scripts/know-me-smoke.ts --json

# the live core: status, rebuild, profile
curl localhost:7777/api/memory/status
curl -X POST localhost:7777/api/memory/status -d '{"world":true}'
curl localhost:7777/api/user

# spoken onboarding, if you ever want it back
EVE_ONBOARDING=1 bun run dev
```

Tests (hermetic: fake gbrain runner, fake brains): `packages/core/test/onboarding.test.ts`, `gbrain.test.ts`, `gbrain-world.test.ts`, `packages/protocol/src/world.test.ts`, `apps/shell/src/overlay/recall.test.ts`.
