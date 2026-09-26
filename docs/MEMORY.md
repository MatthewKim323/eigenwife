# Memory, preference, home

Three core modules own what Eve knows and where she lives. They provide the `memory`, `preference`, and `home` services (contracts in `packages/core/src/services.ts`). All of them work with zero keys and get better as keys appear.

| Module | Path | Provides | Sponsor |
|---|---|---|---|
| home | `packages/core/src/home` | `home`: atomic files in `~/.eve`, Zo mirror, heartbeat, `eve` CLI | Zo |
| memory | `packages/core/src/memory` | `memory`: records, embeddings, retrieval, write policy | Moss, OpenAI embeddings |
| preference | `packages/core/src/preference` | `preference`: Act I math, persona synthesis, birth | Jev |

---

## 1. Memory layers

| Layer | Lives in | Example | Lifetime |
|---|---|---|---|
| Working | world snapshot + short-term records (`STORE_SHORT_TERM`) | "user is looking at the ramen menu" | this session, max 4h, never written to disk |
| Episodic | `kind: "episodic"` records | "Complained that a $28 ramen bowl was overpriced" | persistent |
| Semantic | `kind: "preference" \| "fact"` records | "Likes spicy food", "Trying to save money this month" | persistent |

Long-term records persist to `~/.eve/memories.jsonl` (one `MemoryRecord` per line) and mirror to Moss and Zo. Embedding vectors live separately in `~/.eve/embeddings.json` (local only, never mirrored).

### Retrieval

```
score   = 1.2 * cosine + 0.2 * recency + 0.3 * importance
recency = max(0, 1 - ageDays / 30)
hit     = cosine >= minCos  AND  score > keep        top k (default 5)
```

`minCos` is a relevance gate: recency plus importance alone can reach 0.5, and a memory that is merely recent and important but off topic should never surface. Thresholds are per embedding space because cosine scales differ:

| Space | keep | minCos | dedupe |
|---|---|---|---|
| local | 0.50 | 0.15 | 0.86 |
| openai (`text-embedding-3-small`, 512 dims) | 0.55 | 0.22 | 0.92 |
| moss (`moss-minilm`, alpha 1.0 = raw cosine) | 0.55 | 0.25 | 0.92 |

The local thresholds are tuned on the demo seed and demo queries ("what should we eat instead?" recalls spicy, $28 ramen, saving money, Japanese; "what's the weather like" recalls nothing). The OpenAI thresholds follow the model's known cosine range; they could not be validated live on 2026-09-26 because the key on this machine returned `insufficient_quota`.

`recall()` emits `memory.recall { query, hits, ms, by }` (the `MEMORY · 4ms` flash) unless `emit: false`, and stamps `lastRecalledAt` on every hit. `by` is `"moss"` when Moss contributed a hit, else `"openai"` or `"local"`.

### Embeddings

- **OpenAI** when `OPENAI_API_KEY` works: batched, cached by content hash (`sha1(model:dims:text)`), so each memory and each repeated query is embedded once, ever. Query embedding has a 1.2s budget. Any failure opens a 10 minute breaker and everything runs local.
- **Local** always: a deterministic 384-dim vector with three blocks: concept dims from a small hand-written lexicon (food, money, work, schedule, style, humor, outdoors, music, dating, social, nerd) with a few documented associations (eating out implies money 0.35, schedule implies work 0.4 and food 0.25), hashed word unigrams with light stemming, and hashed character trigrams. It is honest keyword-plus-lexicon matching, not a language model. Every record carries a local vector; the OpenAI vector is added when available.

### Write policy

`memory.observe({ user, eve, event })` decides what to remember:

```
IGNORE_EVENT | STORE_SHORT_TERM | STORE_LONG_TERM | UPDATE_PREFERENCE | UPDATE_RELATIONSHIP
```

1. With `brains`, `quickJson` classifies and extracts compact third-person facts ("Prefers concise responses"). The answer is validated; anything malformed falls through.
2. Without a brain, a keyword policy runs: likes/dislikes, style complaints ("too long", "just the answer"), goals ("I'm trying to..."), life facts ("my sister is..."), price complaints, and reactions to Eve (laughing at a tease nudges `banter +0.03`, "go away" nudges `initiative -0.04` through the `relationship` service).
3. Secrets (passwords, card numbers) are never stored.

`write()` dedupes: a new record whose nearest neighbour is above the space's dedupe cosine reinforces the old one instead (confidence by noisy-or, `c' = 1 - (1 - c)(1 - 0.5 c_new)`, importance max, tags union). Every write, new or reinforced, emits `memory.write { record, policy }`.

The memory module also listens on the bus:

| Event | Becomes |
|---|---|
| `dating.signal` with `positive >= 0.5` and `strength >= 0.6` | preference: "Drawn to sarcasm and nerdiness in a partner (lingered on Mira's profile)" |
| `task.done` | episodic: "Eve handled: Booked Menya Tsuki for 7:30" |
| `swarm.merge` `retained[]` | facts with `source: "swarm"` |

### Demo seed

With `config.demo` (default on, `EIGEN_DEMO=0` to disable) and an empty store, eight memories are seeded with stable ids (`seed_*`), `source: "seed"`, and `createdAt` spread over the past four weeks so recency does real work: likes spicy food, $28 ramen complaint, saving money this month, works late on weekdays, likes Japanese food, hates long explanations, laughed when teased, not into outdoor-heavy plans. Seeding twice is a no-op.

### Moss

When `MOSS_PROJECT_ID` and `MOSS_PROJECT_KEY` are set, long-term records mirror to the Moss index `eve-memories` (`MOSS_INDEX` to override) with `@moss-js/moss`. Verified 2026-09-26: the SDK and its native `moss-core` binding import and run under Bun on darwin-arm64 and reach the Moss control plane, so no Node sidecar is needed. On boot the adapter creates or upserts the index with every current record and `loadIndex`es it for in-process queries. Recall asks Moss first (300ms budget, `alpha: 1.0` so scores are raw cosine) and merges per record by max with the local space. A loaded index does not see `addDocs` until reloaded, so writes schedule a debounced reload; until then the local store still has the record. Not exercised against a live project here (no keys on this machine); the adapter is covered with an injected fake.

---

## 2. Act I: preference from attention

Shell emits `dating.leave { candidateId, regions, totalMs, skipLatencyMs }`. Region keys can be `cand_<id>_<region>` or bare region ids. Leaves are processed strictly in order.

### Attention reward r_i

**Jev** when `TYPESAFE_API_KEY` is set: one `POST /v1/systemone` with the gaze features and region texts as `state` and two typed questions, a `choice` over `skip | neutral | inspect | positive` and a `score` on `No signal | Weak | Clear | Strong`. 400ms budget; slow or malformed answers fall back to local.

**Local** otherwise, fully transparent:

```
dwell    = 1 - exp(-dwellMs / 4000)
revisit  = 1 - exp(-revisits / 2)
fixation = 1 - exp(-longestMs / 2000)
stayed   = clamp((skipLatencyMs - 1500) / 5500)
engage   = mean over regions of 1 - exp(-dwell_j / tau_kind)     tau: photo 1.2s, prompt 2.5s, meta 1.5s
z        = 0.3 dwell + 0.2 revisit + 0.2 fixation + 0.15 stayed + 0.15 engage

interest_k ∝ exp(-(z - c_k)^2 / (2 * 0.12^2))       c = skip 0.08, neutral 0.33, inspect 0.58, positive 0.82
r_i        = Σ_k interest_k * v_k                     v = skip 0.02, neutral 0.25, inspect 0.6, positive 1
strength   = clamp(|z - 0.33| / 0.67 + 0.15)          a snap skip and a long stare are both strong
```

Emits `dating.signal { candidateId, interest, strength, reward, by }` where `by` is `jev:<model>` or `local`.

### Region-aware estimator

Each card region carries an `emphasis` over traits. Attention on a region is evidence for its traits, scaled by what that kind of region can say about that kind of trait (kappa: prompts speak for personality, photos for appearance):

```
a_j    = (dwell_j + 350ms * revisits_j) / Σ_j (...)                   attention share of region j
f_i[t] = clamp(Σ_j a_j * emphasis_j[t] * kappa(kind_j, group(t)))     focus of candidate i on trait t

kappa        appearance  personality  lifestyle
photo           1.0         0.35         0.7
prompt          0.2         1.0          0.6
meta            0.2         0.4          0.9

w_i[t] = r_i * (1 + 2 * f_i[t])
P[t]   = Σ_i w_i[t] C_i[t] / Σ_i w_i[t]
```

With no focus this is exactly the spec's `P = Σ(r_i C_i) / Σ r_i`. With equal rewards and no focus, `P` is the population mean and every delta is zero (tested). Staring at a sarcastic prompt raises the weight of that candidate's sarcasm only.

### Deltas, direction, convergence

```
delta[t] = clamp((P[t] - mu[t]) / (2 sigma[t]), -1, 1)       mu, sigma over the candidate pool; this is the "humor +0.82"
u        = (P - mu) / ||P - mu||                               the latent preference direction ("then normalize")
m_t      = 0.5 m_{t-1} + 0.5 ||u_t - u_{t-1}||                 m_1 = 1
coverage = 1 - exp(-n / 4)
progress = coverage^0.6 * (1 - min(1, m_t))^0.4                never drops more than 0.05 per step
```

`preference.update { vector, deltas, progress, observations }` goes out after every card. Convergence fires at `progress >= 0.98` with at least 6 observations, or when every card in the deck (`dating.view.total`, else the pool size) has been seen. Then `progress` is 1. `POST /api/preference/converge` forces it (operator shortcut for a short demo).

On the real 12-card deck, a simulated user whose eyes follow one trait recovers that trait as the top delta for sarcasm, outdoors, warmth, and nerdiness, with progress climbing to about 0.9 by the last card (tested).

### Adaptation

After convergence, a clear positive (`interest.positive >= 0.5`) on another profile slowly moves the vector: `P(t+1) = 0.85 P(t) + 0.15 C_i`. The born persona's dials do not change.

---

## 3. Persona and birth

On convergence the vector becomes Eve:

```
level(t)   = clamp01(0.55 P[t] + 0.45 (0.5 + 0.5 delta[t]))
humor      = level(humor)          sarcasm = level(sarcasm)          warmth = level(warmth)
initiative = 0.5 level(ambition) + 0.5 level(spontaneity)
verbosity  = clamp(0.15 + 0.35 level(nerdiness) + 0.2 level(warmth) - 0.25 level(sarcasm) - 0.1 level(chaos), 0.1, 0.75)
chaos      = 0.6 level(chaos) + 0.25 level(spontaneity) + 0.15 level(nightlife)
hue        = circular mean of per-trait hues weighted by positive deltas (320 if none)
```

`voice.style` is derived from the dials ("dry, deadpan delivery, playful teasing timing, short sentences"), `voice` defaults to OpenAI `marin`. `tagline`, `description`, `personality`, `scenario` come from `brains.quickJson` (6s budget, em dashes stripped) with a deterministic template fallback. `name` is always "Eve".

Sequence:

1. `preference.converged { vector, persona }`, persisted to `profile.json` and `preferences.json`.
2. When the shell emits `shell.scene "emergence"`: `companion.born { persona }`, exactly once. If emergence arrives before synthesis finishes, birth fires as soon as the persona is ready.
3. On a core restart with a born persona in `~/.eve`: the persona is exposed immediately, and `companion.born { persona, restored: true }` is emitted once at startup, before any client connects, so it only lands in the world snapshot that every client receives in `bus.welcome`. The shell never sees a second birth.
4. `POST /api/preference/reset` backs up `profile.json` to `profile.prev.json`, clears everything, and reruns Act I.

---

## 4. Home and Zo

`~/.eve` (`EVE_HOME` to override), all writes atomic (temp file in the same directory, then `rename`), serialized per file so the last write wins:

| File | Written by | Mirrored to Zo |
|---|---|---|
| `profile.json` `{ persona, convergedAt, bornAt }` | preference | yes |
| `preferences.json` `{ vector, deltas, progress, observations, converged, history }` | preference | yes |
| `relationship.json` `{ state, reason, updatedAt }` | home, from `relationship.update` | yes |
| `memories.jsonl` | memory | yes |
| `task_state.json` `{ tasks: [{ taskId, goal, brain, startedAt, doneAt, ok, summary, ms }] }` | home, from `task.start` / `task.done` | yes |
| `status.json` heartbeat `{ pid, startedAt, lastBeatAt, host, port, online, memories, tasks, lastSyncAt }` | home | at most once a minute |
| `embeddings.json` | memory | no |

**Zo mirror** (`ZO_API_KEY`): writes are debounced (1.5s) and coalesced, so a burst becomes one sync carrying the latest bytes of every dirty file, into `/home/workspace/eve/` on her Zo (`ZO_EVE_DIR` to override). Transport: Zo MCP at `https://api.zo.computer/mcp` over Streamable HTTP (initialize, `tools/list`, then `tools/call` on the file-writing tool, with argument names read from its input schema; JSON and SSE responses both handled). If MCP fails, `POST /zo/ask` asks the Zo agent to write the files verbatim. Failed files stay dirty for the next sync. `lastSyncAt` is recorded, and once a sync succeeds `home.status.host` reads `"zo"`. `POST /api/home/sync` forces a full sync. Covered with a fake Zo; not run against a live Zo here (no key on this machine).

`home.status { online, host, uptimeMs, memories, tasks, lastSyncAt? }` every 5s.

### eve status

Works with the browser closed, and with the core down (then it reads `~/.eve`):

```
bun run --cwd packages/core eve status           # pretty block
bun run --cwd packages/core eve status --json
bun run --cwd packages/core eve memories
```

```
EVE
────────────────────────────────────────────
STATUS    ONLINE
UPTIME    05:31:14
MEMORIES  142
TASKS     3
HOST      zo
ZO        mirrored, last sync 12s ago
PERSONA   Eve, sarcastic and funny. Your type, compiled.
BORN      2h ago
HOME      /Users/you/.eve
────────────────────────────────────────────
EVE  STATUS ONLINE | UPTIME 05:31:14 | MEMORIES 142 | TASKS 3
```

---

## 5. HTTP routes

| Route | What |
|---|---|
| `GET /api/memory[?kind=]` | long-term records, short-term records, backend status |
| `POST /api/memory` `{ kind, content, policy? }` | write one record |
| `POST /api/memory/recall` `{ query, k?, kinds?, emit? }` | recall (emits `memory.recall` unless `emit: false`) |
| `POST /api/memory/observe` `{ user?, eve?, event? }` | run the write policy |
| `GET /api/preference` | vector, deltas, progress, persona, born, history |
| `POST /api/preference/converge` | force convergence now |
| `POST /api/preference/reset` | rerun Act I |
| `GET /api/home/status` | the status block as JSON |
| `GET /api/home/tasks` | persisted task list |
| `POST /api/home/sync` | force a Zo sync |

## 6. Env vars

| Var | Effect |
|---|---|
| `EVE_HOME` | home directory (default `~/.eve`) |
| `EIGEN_DEMO` | `0` disables the demo seed |
| `OPENAI_API_KEY` | OpenAI embeddings (local embedding otherwise) |
| `MOSS_PROJECT_ID`, `MOSS_PROJECT_KEY`, `MOSS_INDEX` | Moss mirror + recall |
| `TYPESAFE_API_KEY` | Jev scores Act I attention (local model otherwise) |
| `ZO_API_KEY`, `ZO_BASE_URL`, `ZO_EVE_DIR` | Zo mirror |

## 7. Contracts for other modules

- Call `memory.observe({ user, eve })` after each conversation turn; the memory module does not subscribe to `voice.final` itself, to avoid double writes.
- `memory.recall(query, { parent })` for prompt context; the recall flash is emitted for you.
- Read the persona with `ctx.use("preference").persona()` or `world().companion.persona`; both survive restarts.
- Relationship persistence: emit `relationship.update` and home writes `relationship.json`; read it back at startup with `home.read("relationship", null)`.
- Shell: send `dating.view` with `total`, `dating.leave` with region stats keyed by `regionKey()`, and `shell.scene "emergence"` when the birth animation should start. A `companion.born` with `restored: true` means skip the animation.
- `world().companion.born` cannot be unset by a reset (the reducer has no case for it); the shell should rely on `preference.update` progress 0 to restart Act I.
