# Sponsor API Reference

Researched 2026-09-26 against live docs. Every fact below cites a URL. Anything marked **UNVERIFIED** was not confirmed from an official source and should be tested before relying on it.

Quick env var table:

| Sponsor | Env var | Base URL | Auth header |
|---|---|---|---|
| Featherless | `FEATHERLESS_API_KEY` | `https://api.featherless.ai/v1` | `Authorization: Bearer <key>` |
| Moss | `MOSS_PROJECT_ID`, `MOSS_PROJECT_KEY` | SDK only (REST exists, not mapped here) | handled by SDK |
| Jev (TypeSafe AI) | `TYPESAFE_API_KEY` | `https://api.typesafe.ai/v1` | `Authorization: Bearer <key>` |
| Zo Computer | `ZO_API_KEY` (our name, Zo does not define one) | `https://api.zo.computer` | `Authorization: Bearer zo_sk_...` |
| Open Swarm | `OPENSWARM_TOKEN` (our name) | `http://localhost:8324/api` (local app) | `Authorization: Bearer <token>` or `x-openswarm-token` |
| Firecrawl | `FIRECRAWL_API_KEY` | `https://api.firecrawl.dev/v2` | `Authorization: Bearer fc-...` |
| OpenAI | `OPENAI_API_KEY` | `https://api.openai.com/v1` | `Authorization: Bearer <key>` |

---

## 1. Featherless (featherless.ai)

**What:** serverless inference for ~22k open-weight Hugging Face models behind one OpenAI-compatible API. Flat subscription, limited by concurrency not tokens.

- Docs: https://featherless.ai/docs/quickstart-guide , https://featherless.ai/docs/api-examples-and-snippets
- Base URL: `https://api.featherless.ai/v1`
- Auth: `Authorization: Bearer $FEATHERLESS_API_KEY` (env name used in their LangChain example)
- Endpoints: `POST /chat/completions`, `POST /completions`, `GET /models` (public, no auth needed, verified via curl)
- SDK: use the `openai` npm package (v7.23.0 on npm today) with `baseURL` overridden. No dedicated npm SDK needed.
- Streaming: standard OpenAI SSE (`stream: true`, `data: {...choices[0].delta.content}` lines, ends with `data: [DONE]`). Their snippets page has no streaming example, but the API is documented as OpenAI compatible. Test once.

**Rate limits** (https://featherless.ai/docs/concurrency-limits): concurrency units per plan. Model under 16B = 1 unit, under 34B = 2 units, 70B+ = 4 units. A 4-unit plan runs 4 small-model requests in parallel. Exceeding the budget returns HTTP 429. Each model in `GET /models` has a `concurrency_cost` field.

**Model picks for short persona lines** (all verified present in `GET /models` today, all cost 1 unit):

| Model id | Gated | Ctx | Notes |
|---|---|---|---|
| `Sao10K/L3-8B-Stheno-v3.2` | no | 8192 | Popular Llama-3 8B roleplay finetune. Best fit for in-character lines. |
| `NousResearch/Hermes-3-Llama-3.1-8B` | no | 32768 | Strong instruction following, steerable persona. Safe default. |
| `mistralai/Mistral-Nemo-Instruct-2407` | no | 32768 | 12B, good prose, still 1 unit. |
| `Qwen/Qwen2.5-7B-Instruct` | no | 32768 | Good at JSON-ish constrained output. |
| `meta-llama/Meta-Llama-3.1-8B-Instruct` | **yes** | 32768 | Gated: needs HF account linked. Avoid for a demo. |

Avoid `Qwen/Qwen3-8B` for latency: it emits thinking tokens by default (general Qwen3 behavior, not checked on Featherless).

```ts
// Bun: fetch + SSE parse, no deps
export async function* featherlessStream(messages: {role: string; content: string}[], model = "Sao10K/L3-8B-Stheno-v3.2") {
  const res = await fetch("https://api.featherless.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.FEATHERLESS_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, stream: true, max_tokens: 80, temperature: 0.9 }),
  });
  if (!res.ok || !res.body) throw new Error(`featherless ${res.status}: ${await res.text()}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") return;
      const delta = JSON.parse(data).choices?.[0]?.delta?.content;
      if (delta) yield delta as string;
    }
  }
}
```

Or with the SDK: `new OpenAI({ apiKey: process.env.FEATHERLESS_API_KEY, baseURL: "https://api.featherless.ai/v1" })`.

---

## 2. Moss (moss.dev, formerly usemoss.dev)

**What:** "real-time semantic search for AI agents". Indexes live in Moss cloud, `loadIndex()` pulls them into your process, then queries run locally in ~1 to 10 ms with built-in embedding models (no embedding API key). Hybrid semantic + keyword. This is the memory/search sponsor. Integrations listed for LiveKit, Pipecat, LangChain, Vercel AI SDK.

- Site: https://www.moss.dev , Repo: https://github.com/usemoss/moss
- Docs: https://docs.moss.dev (index at https://docs.moss.dev/llms.txt). Note: `docs.usemoss.dev` currently serves an expired TLS cert.
- JS reference: https://docs.moss.dev/docs/reference/js/api.md , https://docs.moss.dev/docs/reference/js/classes/MossClient.md
- Auth: https://docs.moss.dev/docs/integrate/authentication.md . Env vars `MOSS_PROJECT_ID`, `MOSS_PROJECT_KEY`, from the API Keys page at https://portal.usemoss.dev
- Runtime: Node.js 20.4+ per docs. **UNVERIFIED on Bun**: test `loadIndex` + local `query` under Bun first thing; if it breaks, run the Moss adapter in a small Node sidecar.

**npm package: two exist.** Current docs use `@moss-js/moss` (v1.14.0, published 2026-09-21). The GitHub README uses `@moss-dev/moss` (v1.7.1, last touched 2026-08-27, not marked deprecated). Use `@moss-js/moss`.

**API (MossClient):**
- `new MossClient(projectId, projectKey)`
- `createIndex(name, docs, { modelId? })`: `modelId` is `"moss-minilm"` (default, fast), `"moss-mediumlm"` (more accurate), or `"custom"` (you pass `embedding`)
- `addDocs(name, docs, { upsert: true })`
- `deleteDocs(name, docIds)`, `getDocs(name)`, `listIndexes()`, `getIndex(name)`, `deleteIndex(name)`
- `loadIndex(name, options?)`: required before fast local queries; supports auto-refresh
- `query(name, text, { topK = 5, alpha?, filter? })`: `alpha` 1.0 = pure semantic, 0.0 = pure keyword. Filter ops: `$eq`, `$and`, `$in`, `$near`. Without a loaded index it falls back to a cloud query.
- `queryMultiIndex(names, text, options)`, `getJobStatus(jobId)`
- Mutations are async server-side jobs; the SDK polls until done.

Shapes:
```ts
type DocumentInfo = { id: string; text: string; metadata?: Record<string, any>; embedding?: Float32Array };
type SearchResult = { docs: Array<{ id: string; text: string; score: number; metadata?: Record<string, any>; indexName?: string }>; timeTakenInMs?: number };
```

**Limits** (https://docs.moss.dev/docs/pricing.md): free Developer plan ($5/mo credits) = 1 project, 3 indexes, 500 MB storage, 50 MB/month ingest, 1 concurrent job. Local queries are unlimited and never metered.

```ts
import { MossClient } from "@moss-js/moss";

const moss = new MossClient(process.env.MOSS_PROJECT_ID!, process.env.MOSS_PROJECT_KEY!);
const INDEX = "memories";

export async function ensureIndex() {
  const existing = await moss.listIndexes();
  // listIndexes return shape UNVERIFIED: check if it is string[] or {name}[]
  const names = (existing as any[]).map((i) => (typeof i === "string" ? i : i.name));
  if (!names.includes(INDEX)) {
    await moss.createIndex(INDEX, [{ id: "seed", text: "index created" }], { modelId: "moss-minilm" });
  }
  await moss.loadIndex(INDEX);
}

export async function remember(id: string, text: string, metadata?: Record<string, string>) {
  await moss.addDocs(INDEX, [{ id, text, metadata }], { upsert: true });
}

export async function recall(q: string, topK = 5) {
  const r = await moss.query(INDEX, q, { topK, alpha: 0.7 });
  return r.docs.map((d) => ({ id: d.id, text: d.text, score: d.score }));
}
```

**UNVERIFIED:** whether a loaded index sees `addDocs` writes immediately or only after auto-refresh/reload. The JS "Sessions" page (https://docs.moss.dev/docs/reference/js/sessions.md, `SessionIndex`) covers local real-time indexing with cloud sync and is probably the right tool for live conversation memory. REST header names for the control plane API were not checked (https://docs.moss.dev/docs/api-reference/v1/getting-started/authentication.md).

---

## 3. Jev (TypeSafe AI)

**What:** Jev is TypeSafe AI's "System One" model. Not a text generator: you send `state` plus typed `questions` and get back structured answers with probabilities. Three question types: `choice` (pick one label), `score` (position on an ordered rubric), `noul` (probability a statement is true). Claims up to 200x faster and 400x cheaper than LLMs on classification. Latency 70 to 500 ms end to end, most around 100 ms.

This is the only "Jev" product found; no ambiguity. Related: `featherless-ai/simple-jev` (https://github.com/featherless-ai/simple-jev) is an open-source imitation that turns any open model into a `/v1/systemone`-compatible endpoint (demo at `simple-jev-demo-api.featherless.ai`). Useful as a fallback since it matches the request shape, but it is explicitly not the TypeSafe model.

- Docs: https://docs.typesafe.ai (index: https://docs.typesafe.ai/llms.txt), API ref: https://docs.typesafe.ai/api.md , JS SDK: https://docs.typesafe.ai/sdk/javascript.md
- Console / keys: https://console.typesafe.ai
- Deep dive: https://flaviocopes.com/jev/ , LangChain post: https://www.langchain.com/blog/building-a-harness-with-jev
- Endpoint: `POST https://api.typesafe.ai/v1/systemone`. Also `GET https://api.typesafe.ai/v1/models`
- Auth: `Authorization: Bearer $TYPESAFE_API_KEY`
- Models: `jev-latest` (stable), `jev-preview`, pinned like `jev-1.13.0`
- SDKs: `@typesafe-ai/sdk` (v0.6.0, Node 20+), Vercel AI SDK provider `@ai-sdk/typesafe-ai` (v3.0.8), Python `typesafe-sdk`, LangChain `langchain-typesafe`
- Rate limits (early access, per flaviocopes.com, not seen on official docs): 1,200 req/min, 250k tokens/s. Errors: 401 bad key, 422 validation, 429 rate limit, 529 overloaded. Official advice: exponential backoff.
- Pricing (flaviocopes.com): $0.042 per 1M input tokens, output free.

Request:
```json
{
  "model": "jev-latest",
  "state": "string | object | array",
  "questions": {
    "is_urgent": { "type": "noul", "instructions": "Does this convey urgency?", "criteria": { "true": "Explicitly time-sensitive", "false": "No urgency expressed" } },
    "department": { "type": "choice", "instructions": "Which team should handle this?", "criteria": { "billing": "Payments, refunds", "technical": "Bugs, outages", "sales": "Pricing, upgrades" } },
    "frustration": { "type": "score", "instructions": "How frustrated is the customer?", "criteria": ["Calm", "Frustrated", "Very angry"] }
  }
}
```

Response:
```json
{
  "model": "jev-1.13.0",
  "answers": {
    "is_urgent": { "type": "noul", "noul": 0.95 },
    "department": { "type": "choice", "choice": "billing", "probabilities": { "billing": 0.88, "technical": 0.12, "sales": 0.0 }, "confidence": 0.81 },
    "frustration": { "type": "score", "score": 1.05, "legend": { "0": "Calm", "1": "Frustrated", "2": "Very angry" }, "probabilities": { "0": 0.0, "1": 0.95, "2": 0.05 }, "confidence": 0.92 }
  },
  "usage": { "input_tokens": 0, "output_tokens": 0 }
}
```

```ts
export async function jev(state: unknown, questions: Record<string, unknown>) {
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "jev-latest", state, questions }),
  });
  if (!res.ok) throw new Error(`jev ${res.status}: ${await res.text()}`);
  return (await res.json()).answers as Record<string, any>;
}

// e.g. const a = await jev(transcript, { should_interrupt: { type: "noul", instructions: "Should the persona interject now?" } });
```

SDK form:
```ts
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
const client = new TypeSafeClient(); // reads TYPESAFE_API_KEY
const r = await client.systemOne({ state: { document: "..." }, questions: { category: choice("What is this about?", { billing: null, technical: null, other: null }) } });
r.answers.category.choice;
```
The SDK presumably also exports `noul` and `score` helpers (docs only show `choice`): **UNVERIFIED**.

---

## 4. Zo Computer (zo.computer)

**What:** a personal cloud Linux server with an AI agent on it. 50+ built-in tools: files, bash, web browsing/research, image/speech/video gen, scheduled automations, SMS/email/Telegram/Discord/Slack messaging, hosted sites, plus connected apps (Gmail, Calendar, Notion, Linear, Drive, etc).

- Docs: https://docs.zocomputer.com (index: https://docs.zocomputer.com/llms.txt), API: https://docs.zocomputer.com/api.md , MCP: https://docs.zocomputer.com/mcp-server
- Auth: create an access token at Settings > Advanced. Format `zo_sk_...`. Header `Authorization: Bearer zo_sk_...`. Token grants full access to the Zo: keep it server side only.
- Base URL: `https://api.zo.computer`
- Env var: Zo docs do not name one. We use `ZO_API_KEY`.
- Rate limits: not documented. **UNVERIFIED**.

**Two ways to drive it from an external app:**

A) HTTP "Ask Zo" (simplest, recommended): https://docs.zocomputer.com/api-reference/ai/ask-zo.md
- `POST /zo/ask` body: `input` (string, required), `conversation_id` (continue a thread), `model_name` (e.g. `"zo:openai/gpt-5.4"`, list via `GET /models/available`), `persona_id` (list via `GET /personas/available`), `stream` (bool, SSE), `memory_mode` (`"enabled"` | `"off"`), `output_format` (JSON Schema for structured output)
- Response: `{ "output": string | object, "conversation_id": string | null }`. Errors: `{ "error": "..." }` (status 200 or 422).
- Streaming: SSE; the conversation id comes back in the `x-conversation-id` response header. **UNVERIFIED:** exact SSE event names / payload shape (docs only say "Server-Sent Events"). Log raw events on first run.

B) MCP: `https://api.zo.computer/mcp` (HTTP transport, same Bearer token). Gives direct tool calls: `run_bash_command` (docs page `tools/bash.md`), `read_file`, `write_file`, `list_directory`, `grep_search`, `web_search`, `web_research`, `read_webpage`, `view_webpage`, `use_webpage`, `create_automation`, `list_automations`, `get_automation`, `edit_automation`, `delete_automation`, `send_email_to_user`, `send_sms_to_user`, `send_discord_message`, `generate_speech`, etc. Tool ids are inferred from doc page slugs (hyphens to underscores); `create_automation` and `run_bash_command` are confirmed verbatim. Use `@modelcontextprotocol/sdk` Streamable HTTP client from TS.

**Background tasks and status:** there is no job/status REST endpoint. Options:
- Synchronous: `POST /zo/ask` blocks until the agent finishes; wrap in our own job table and poll ourselves.
- Scheduled: `create_automation` with `rrule` (RFC 5545), `instruction`, optional `delivery_method` (`email|sms|telegram|slack|discord`), optional `model`. Read back with `list_automations` / `get_automation`. Runs are results-delivered-by-message, not a pollable job. **UNVERIFIED:** whether `get_automation` exposes last-run output.
- Pattern that works: ask Zo to write results to a known file (e.g. `/home/workspace/eigenwife/status.json`) and read it back via MCP `read_file` or another `/zo/ask`.

```ts
export async function askZo(input: string, opts: { conversationId?: string; schema?: object } = {}) {
  const res = await fetch("https://api.zo.computer/zo/ask", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.ZO_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input,
      conversation_id: opts.conversationId ?? null,
      output_format: opts.schema,
      stream: false,
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`zo: ${json.error}`);
  return json as { output: string | Record<string, unknown>; conversation_id: string | null };
}
```

---

## 5. Open Swarm (openswarm.com)

**What:** open-source desktop "mission control" for many parallel AI agents on an infinite spatial canvas (agent cards, view cards, embedded browser cards), streaming chat, human-in-the-loop tool approvals, message branching. Built on `claude-agent-sdk`. Local-first: it is an Electron app, not a hosted SaaS API.

- Repo: https://github.com/openswarm-ai/openswarm (AGPL-3.0 per GitHub license metadata, 821 stars, pushed 2026-09-23)
- Site: https://openswarm.com , docs: https://docs.openswarm.com/what-is-open-swarm (TLS cert currently expired, could not fetch)
- Stack: React 18 + Redux + MUI frontend (port 3000), FastAPI backend (port 8324), Electron 33. macOS desktop build on GitHub Releases.
- Run from source: `git clone https://github.com/openswarm-ai/openswarm && cd openswarm && bash run.sh`. Backend alone: `bash backend/run.sh` (OpenAPI docs at `http://localhost:8324/docs`).
- Anthropic key is set in the in-app Settings page; advanced config in `backend/.env`.

**No official public/embeddable API.** But the local backend is a plain REST + WebSocket API (read from source, `backend/main.py`, `backend/apps/agents/agents.py`, `backend/auth.py`):
- Every route is prefixed `/api/<subapp>`; agents live at `/api/agents`.
- Auth: per-install token, file `auth.token` in the data root. Packaged macOS app: `~/Library/Application Support/OpenSwarm/data/auth.token`. From source: `backend/data/auth.token`. Override with `OPENSWARM_DATA_ROOT`. Send as `Authorization: Bearer <token>`, `x-openswarm-token: <token>`, or `?token=<token>`.
- CORS allows `localhost:*`, `127.0.0.1:*`, `file://`. Call from our server, not from a remote origin.
- `POST /api/agents/launch` body = `AgentConfig`: `{ name, prompt?, model = "sonnet", mode = "agent", provider = "anthropic", system_prompt?, allowed_tools?, max_turns?, target_directory?, dashboard_id?, read_only = false }` returns `{ session_id, session }`. A `prompt` runs as the first turn.
- `POST /api/agents/sessions/{id}/message` body `{ prompt, mode?, model?, ... }`
- `GET /api/agents/sessions`, `GET /api/agents/sessions/{id}`, `POST /api/agents/sessions/{id}/stop`, `POST /api/agents/approval`
- WebSocket `ws://localhost:8324/ws/agents/{session_id}?token=...` streams session events (sequenced, replayable); `ws://localhost:8324/ws/dashboard` for global events. WS also checks Origin, so connect from a server process or a localhost page.

Launching via the API should make the agent card show up on the canvas (it goes through the same `agent_manager`), which is the "visualize" story: run the Open Swarm app on the demo laptop and spawn agents into it from our backend. **UNVERIFIED:** that a session launched without `dashboard_id` appears on the active dashboard; pass the dashboard id from `/api/dashboards` if not. These are internal routes and can change any commit.

```ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const OS_BASE = "http://localhost:8324";
const token = process.env.OPENSWARM_TOKEN
  ?? readFileSync(`${homedir()}/Library/Application Support/OpenSwarm/data/auth.token`, "utf8").trim();

export async function spawnSwarmAgent(name: string, prompt: string, system_prompt?: string) {
  const res = await fetch(`${OS_BASE}/api/agents/launch`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, prompt, system_prompt, mode: "agent" }),
  });
  if (!res.ok) throw new Error(`openswarm ${res.status}: ${await res.text()}`);
  return (await res.json()) as { session_id: string; session: unknown };
}

export function watchSwarmAgent(sessionId: string, onEvent: (e: unknown) => void) {
  const ws = new WebSocket(`ws://localhost:8324/ws/agents/${sessionId}?token=${encodeURIComponent(token)}`);
  ws.onmessage = (m) => onEvent(JSON.parse(String(m.data)));
  return ws;
}
```

---

## 6. Firecrawl (firecrawl.dev)

**What:** web scraping, search, crawl, and LLM extraction API. Current version is **v2**.

- Docs: https://docs.firecrawl.dev , scrape: https://docs.firecrawl.dev/api-reference/endpoint/scrape , search: https://docs.firecrawl.dev/api-reference/endpoint/search , extract: https://docs.firecrawl.dev/api-reference/endpoint/extract , node SDK: https://docs.firecrawl.dev/sdks/node
- Base URL: `https://api.firecrawl.dev/v2`
- Auth: `Authorization: Bearer fc-...`, env `FIRECRAWL_API_KEY` (SDK reads it)
- SDK: `firecrawl` on npm (v4.41.0; same package as `@mendable/firecrawl-js`). `import { Firecrawl } from "firecrawl"; new Firecrawl({ apiKey })`. Methods: `scrape`, `search`, `crawl`, `map`, `agent`, `parse`, `browser`.

**Rate limits** (https://docs.firecrawl.dev/rate-limits), req/min: Free: scrape 10, search 10, extract 2. Hobby: 100/100/20. Standard: 500/500/100. Concurrent browsers: Free 2, Hobby 5. 429 on excess. Extract shares limits with `/agent`.

**Scrape** `POST /v2/scrape`:
```json
{
  "url": "https://example.com",
  "formats": [
    { "type": "markdown" },
    { "type": "json", "prompt": "Extract the product", "schema": { "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"] } }
  ],
  "onlyMainContent": true
}
```
Response: `{ "success": true, "data": { "markdown": "...", "json": { ... }, "metadata": { "title", "description", "url", "statusCode", "contentType" } } }`. (`onlyMainContent` is from general Firecrawl knowledge, not rechecked today.)

**Search** `POST /v2/search`: `query` (max 500 chars), `limit` (1 to 100, default 10), `sources` (default `["web"]`, also `"images"`, `"news"`), `country`, `location`, `tbs` (e.g. `"qdr:w"`), `includeDomains`, `excludeDomains`, `categories`, `scrapeOptions` (same `formats` as scrape to get full page markdown). Response: `data.web[]` with `url`, `title`, `description`, and `markdown` + `metadata` when scraped.

**Extract** `POST /v2/extract`: `{ urls: string[] (globs ok), prompt?, schema?, enableWebSearch?, scrapeOptions? }` returns `{ success, id }`. Async: poll `GET /v2/extract/{id}` for `{ success, status: "processing"|"completed"|"failed"|"cancelled", data, expiresAt, tokensUsed }`. For a single known URL, prefer scrape with a `json` format: synchronous, one call, higher rate limit.

```ts
const FC = "https://api.firecrawl.dev/v2";
const fcHeaders = { Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`, "Content-Type": "application/json" };

export async function scrape(url: string, schema?: object, prompt?: string) {
  const formats: any[] = [{ type: "markdown" }];
  if (schema) formats.push({ type: "json", schema, prompt });
  const res = await fetch(`${FC}/scrape`, { method: "POST", headers: fcHeaders, body: JSON.stringify({ url, formats }) });
  const j = await res.json();
  if (!j.success) throw new Error(`firecrawl scrape: ${JSON.stringify(j)}`);
  return j.data as { markdown?: string; json?: any; metadata: Record<string, any> };
}

export async function search(query: string, limit = 5, withContent = false) {
  const body: any = { query, limit };
  if (withContent) body.scrapeOptions = { formats: [{ type: "markdown" }] };
  const res = await fetch(`${FC}/search`, { method: "POST", headers: fcHeaders, body: JSON.stringify(body) });
  const j = await res.json();
  return (j.data?.web ?? []) as { url: string; title: string; description: string; markdown?: string }[];
}
```

---

## 7. OpenAI

Docs moved to https://developers.openai.com/api/docs (old platform.openai.com URLs 301 there). SDK: `openai` on npm (v7.23.0).

**TTS:** https://developers.openai.com/api/docs/guides/text-to-speech , reference: https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create , model page: https://developers.openai.com/api/docs/models/gpt-4o-mini-tts
- Model: `gpt-4o-mini-tts` (still the newest and recommended TTS model; default snapshot `gpt-4o-mini-tts-2025-12-15`, older `-2025-03-20`). Only this model supports `instructions` and SSE.
- `POST https://api.openai.com/v1/audio/speech`: `model`, `input` (max 4096 chars), `voice` (`alloy, ash, ballad, coral, echo, fable, onyx, nova, sage, shimmer, verse, marin, cedar`; OpenAI recommends `marin` or `cedar` for quality; custom `{ "id": "voice_..." }` also allowed), `instructions` (tone/accent/emotion prompt), `response_format` (`mp3` default, `opus`, `aac`, `flac`, `wav`, `pcm`), `speed` (0.25 to 4.0), `stream_format` (`"audio"` raw chunked bytes, or `"sse"`).
- SSE events: `speech.audio.delta` (base64 audio chunk), `speech.audio.done`.
- Lowest latency per docs: `wav` or `pcm`. `pcm` is 24 kHz, 16-bit signed little-endian mono (from memory of the docs, verify).
- Rate limits: Tier 1 500 RPM / 50k TPM. Pricing $0.60 per 1M text input, $12 per 1M audio output tokens.

Browser playback recommendation: proxy through our server with `stream_format: "audio"` + `response_format: "mp3"` and point an `<audio>` element (or `new Audio(url)`) at the proxy route. The browser starts playing progressively; no client decoding code. For absolute lowest first-byte latency use `pcm` and feed an `AudioWorklet` / scheduled `AudioBufferSourceNode`s.

```ts
// Bun server route: GET /tts?text=...  -> streams mp3 straight to the browser
export async function ttsHandler(req: Request) {
  const text = new URL(req.url).searchParams.get("text") ?? "";
  const upstream = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: "marin",
      input: text,
      instructions: "Warm, playful, a little teasing. Short natural pauses.",
      response_format: "mp3",
      stream_format: "audio",
    }),
  });
  if (!upstream.ok || !upstream.body) return new Response(await upstream.text(), { status: 502 });
  return new Response(upstream.body, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
}
// browser: new Audio(`/tts?text=${encodeURIComponent(line)}`).play();
```

**Small fast chat model:** `gpt-6-luna` (https://developers.openai.com/api/docs/models/gpt-6-luna): "most efficient model for focused, high-volume tasks". $0.10 / $0.50 per 1M in/out, 1.05M context, Chat Completions + Responses + streaming. It is a **reasoning model with default effort `medium`**: set `reasoning_effort: "none"` for low latency. Tier 1: 500 RPM, 500k TPM. Other small ids still listed: `gpt-5.6-luna`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5-mini`, `gpt-5-nano`, `gpt-4.1-mini`, `gpt-4o-mini`. A `-fast` suffix for lower latency was reported by a third party (search snippet), **UNVERIFIED** on official docs.

```ts
const res = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "gpt-6-luna", reasoning_effort: "none", stream: true, messages: [{ role: "user", content: "hi" }] }),
});
// same SSE parsing as the Featherless example
```

**Embeddings:** https://developers.openai.com/api/docs/guides/embeddings . Still `text-embedding-3-small` (1536 dims default) and `text-embedding-3-large` (3072), both accept `dimensions` to shrink, max 8192 input tokens. `POST /v1/embeddings { model, input, dimensions?, encoding_format: "float" }` returns `{ data: [{ embedding, index }], model, usage }`. Only needed if we skip Moss's built-in embeddings.

---

## Open questions to test first

1. Moss SDK under Bun (native/WASM loading) and read-after-write on a loaded index.
2. Zo `/zo/ask` SSE event format and typical wall-clock latency for a tool-using task.
3. Open Swarm: does an API-launched session appear on the canvas; which `dashboard_id`.
4. Featherless streaming works with `stream: true` on the chosen model (cold models may have a slow first token).
5. Jev rate limits and `noul`/`score` SDK helpers.
