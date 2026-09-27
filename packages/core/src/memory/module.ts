import { CANDIDATES, TRAIT_KEYS, newId, type Candidate, type MemoryHit, type MemoryRecord, type MemoryWritePolicy } from "@eigenwife/protocol";
import { secret } from "../config";
import type { CoreContext, Module } from "../context";
import { json } from "../hub";
import type { HomeService, MemoryService } from "../services";
import { HomeStore } from "../home/store";
import { localEmbed, OpenAIEmbedder, type FetchLike, type Vec } from "./embed";
import { MossAdapter, type MossLike } from "./moss";
import { decide, type Exchange } from "./policy";
import { isDuplicate, nearest, reinforce, search, type RecordVecs, type Space } from "./retrieval";
import { seedMemories } from "./seed";
import { homedir } from "os";
import { join } from "path";
import { bunRunner, filterHits, GbrainClient, gbrainInstalled, type GbrainRunner } from "./gbrain";
import { buildDigest, DIGEST_MAX_AGE_MS, type Digest } from "./gbrain-digest";
import { liveCue } from "./gbrain-live";
import { GbrainWriteback } from "./gbrain-writeback";

/**
 * Memory (hippocampus). Three layers:
 *  - working: the world snapshot plus short-term records (this session only)
 *  - episodic: things that happened ("complained a $28 ramen was overpriced")
 *  - semantic: preferences and facts ("likes spicy food", "saving money")
 * Long-term records persist to ~/.eve/memories.jsonl through home and mirror
 * to Moss when MOSS_PROJECT_ID/MOSS_PROJECT_KEY are set.
 */

export interface MemoryModuleOptions {
  /** Defaults to OPENAI_API_KEY. Empty string forces the local embedding. */
  openaiKey?: string;
  fetch?: FetchLike;
  /** Injected Moss adapter (tests), or null to disable. Defaults to env keys. */
  moss?: MossLike | null;
  candidates?: Candidate[];
  /** Short-term records expire after this long even within a session. */
  shortTermTtlMs?: number;
  persistDebounceMs?: number;
  now?: () => number;
  /** gbrain (matt's knowledge brain, docs/KNOW_ME.md). null disables; undefined = env defaults. */
  gbrain?: GbrainMemoryOptions | null;
}

export interface GbrainMemoryOptions {
  /** Injected CLI runner (tests). Default: the real `gbrain` binary. */
  runner?: GbrainRunner;
  /** Digest + live lookups. Default: on for the real ~/.eve (or EVE_GBRAIN=1) when gbrain is installed; EVE_GBRAIN=0 off. */
  enabled?: boolean;
  /** Write-back. Default: on for the real ~/.eve (or EVE_GBRAIN_WRITE=1); EVE_GBRAIN_WRITE=0 off. */
  write?: boolean;
  /** Wait after boot before a (stale) digest runs, so it never competes with her first words. */
  digestDelayMs?: number;
  /** Skip the digest entirely (live + write-back only). */
  digest?: boolean;
  queryTimeoutMs?: number;
  /** Budget for one live lookup (keyword search, p50 355ms). */
  liveTimeoutMs?: number;
  /** How long a lookup's world slot stays up. */
  liveSlotMs?: number;
  /** Same lookup isn't repeated within this window. */
  liveCooldownMs?: number;
  writeDebounceMs?: number;
}

export type MemoryServiceImpl = MemoryService & {
  shortTerm(): MemoryRecord[];
  vectors(id: string): RecordVecs | undefined;
  flush(): Promise<void>;
  backend(): { embeddings: "openai" | "local"; moss: boolean };
  /** gbrain status (docs/KNOW_ME.md), set once the module is up. */
  gbrain?: () => Record<string, unknown>;
};

const BREAKER_MS = 10 * 60_000;

export function memoryModule(opts: MemoryModuleOptions = {}): Module {
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let flushNow: (() => Promise<void>) | null = null;
  let moss: MossLike | null = null;
  const offs: (() => void)[] = [];
  const gbrainTimers = new Set<ReturnType<typeof setTimeout>>();
  let writeback: GbrainWriteback | null = null;

  return {
    name: "memory",
    async start(ctx: CoreContext) {
      const now = opts.now ?? (() => Date.now());
      const log = (...a: unknown[]) => ctx.log("memory", ...a);
      const fallbackStore = new HomeStore(ctx.config.eveHome);
      const home: Pick<HomeService, "read" | "write"> = ctx.tryUse("home") ?? {
        read: (n, f) => fallbackStore.read(n, f),
        write: async (n, d) => {
          await fallbackStore.write(n, d);
        },
      };
      const candidates = opts.candidates ?? CANDIDATES;

      // --- state ---------------------------------------------------------------
      const records = new Map<string, MemoryRecord>();
      const short = new Map<string, { rec: MemoryRecord; expiresAt: number }>();
      const vecs = new Map<string, RecordVecs>();
      const shortTtl = opts.shortTermTtlMs ?? 4 * 3600_000;

      const cacheFile = await home.read<{ model?: string; dims?: number; vectors?: Record<string, Vec> }>("embeddings", {});
      // AI Gateway serves the same embedding model through one key; OpenAI direct second.
      const gatewayKey = opts.openaiKey === undefined ? secret("AI_GATEWAY_API_KEY") : "";
      const openaiKey = opts.openaiKey ?? (gatewayKey || secret("OPENAI_API_KEY"));
      let breakerUntil = 0;
      let cacheDirty = false;
      const embedder = openaiKey
        ? new OpenAIEmbedder({
            apiKey: openaiKey,
            ...(gatewayKey ? { url: "https://ai-gateway.vercel.sh/v1/embeddings", model: "openai/text-embedding-3-small" } : {}),
            fetch: opts.fetch,
            cache: new Map(Object.entries(cacheFile.vectors ?? {})),
            onCacheChange: () => {
              cacheDirty = true;
              schedulePersist();
            },
          })
        : null;
      const openaiLive = () => !!embedder && now() >= breakerUntil;

      const loaded = await home.read<MemoryRecord[]>("memories.jsonl", []);
      for (const r of loaded) {
        if (!r || typeof r.id !== "string" || typeof r.content !== "string") continue;
        records.set(r.id, r);
      }

      const vecsFor = (content: string): RecordVecs => {
        const v: RecordVecs = { local: localEmbed(content) };
        const o = embedder?.cached(content);
        if (o) v.openai = o;
        return v;
      };
      for (const r of records.values()) vecs.set(r.id, vecsFor(r.content));

      // --- persistence -----------------------------------------------------------
      const persist = async () => {
        const rows = [...records.values()].sort((a, b) => a.createdAt - b.createdAt);
        await home.write("memories.jsonl", rows);
        if (cacheDirty && embedder) {
          cacheDirty = false;
          await home.write("embeddings", { model: embedder.model, dims: embedder.dims, vectors: Object.fromEntries(embedder.cache) });
        }
      };
      function schedulePersist() {
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = setTimeout(() => {
          persistTimer = null;
          void persist().catch((e) => log("persist failed", e));
        }, opts.persistDebounceMs ?? 150);
      }
      flushNow = async () => {
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = null;
        await persist();
      };

      /** Add OpenAI vectors to records that lack them, in one batched call. */
      const fillOpenai = async () => {
        if (!embedder || !openaiLive()) return;
        const missing = [...records.values(), ...[...short.values()].map((s) => s.rec)].filter((r) => !vecs.get(r.id)?.openai);
        if (!missing.length) return;
        const before = embedder.failures;
        const out = await embedder.embed(missing.map((r) => r.content));
        if (embedder.failures > before) {
          breakerUntil = now() + BREAKER_MS;
          log("openai embeddings unavailable, using local embeddings for 10 min");
          return;
        }
        missing.forEach((r, i) => {
          const v = vecs.get(r.id);
          if (v && out[i]) v.openai = out[i]!;
        });
      };

      // --- demo seed -------------------------------------------------------------
      if (ctx.config.demo && records.size === 0) {
        for (const r of seedMemories(now())) {
          records.set(r.id, r);
          vecs.set(r.id, vecsFor(r.content));
        }
        await persist();
        log(`seeded ${records.size} demo memories`);
      }

      // --- moss --------------------------------------------------------------------
      if (opts.moss !== undefined) moss = opts.moss;
      else if (secret("MOSS_PROJECT_ID") && secret("MOSS_PROJECT_KEY"))
        moss = new MossAdapter({
          projectId: secret("MOSS_PROJECT_ID"),
          projectKey: secret("MOSS_PROJECT_KEY"),
          index: secret("MOSS_INDEX") || undefined,
          log,
        });
      if (moss instanceof MossAdapter) void moss.init([...records.values()]);

      void fillOpenai();

      // --- service -----------------------------------------------------------------
      const pruneShort = () => {
        const t = now();
        for (const [id, s] of short) if (s.expiresAt <= t) {
          short.delete(id);
          vecs.delete(id);
        }
      };
      const allRecords = (): MemoryRecord[] => {
        pruneShort();
        return [...records.values(), ...[...short.values()].map((s) => s.rec)];
      };

      const embedQuery = async (q: string): Promise<RecordVecs> => {
        const v: RecordVecs = { local: localEmbed(q) };
        if (embedder && openaiLive()) {
          const before = embedder.failures;
          const [o] = await embedder.embed([q], 1200);
          if (o) v.openai = o;
          else if (embedder.failures > before) breakerUntil = now() + BREAKER_MS;
        }
        return v;
      };

      const recall: MemoryService["recall"] = async (query, o = {}) => {
        const t0 = performance.now();
        const k = o.k ?? 5;
        const q = await embedQuery(query);
        let mossScores: Map<string, number> | undefined;
        if (moss?.ready()) {
          try {
            const hits = await Promise.race([moss.query(query, k * 3), Bun.sleep(300).then(() => [])]);
            mossScores = new Map(hits.map((h) => [h.id, h.score]));
          } catch {}
        }
        const res = search(allRecords(), vecs, q, { k, kinds: o.kinds, now: now(), moss: mossScores });
        const t = now();
        const hits: MemoryHit[] = res.hits.map((h) => {
          const live = records.get(h.record.id) ?? short.get(h.record.id)?.rec;
          if (live) live.lastRecalledAt = t;
          return { record: { ...h.record, lastRecalledAt: t }, score: h.score };
        });
        if (hits.length) schedulePersist();
        const ms = Math.round((performance.now() - t0) * 10) / 10;
        const by: Space = res.space;
        if (o.emit !== false) ctx.bus.emit("memory.recall", { query, hits, ms, by }, "core", o.parent);
        return hits;
      };

      const write: MemoryService["write"] = async (rec, policy = "STORE_LONG_TERM") => {
        if (policy === "IGNORE_EVENT") return null;
        const content = rec.content?.trim();
        if (!content) return null;
        const v = vecsFor(content);
        if (embedder && openaiLive() && !v.openai) {
          const [o] = await embedder.embed([content], 1500);
          if (o) v.openai = o;
        }
        const isShort = policy === "STORE_SHORT_TERM";
        const pool = isShort ? allRecords() : [...records.values()];
        const near = nearest(pool, vecs, v);
        if (near && isDuplicate(near)) {
          const ex = near.record;
          ex.confidence = Math.round(reinforce(ex.confidence, rec.confidence ?? 0.7) * 1000) / 1000;
          ex.importance = Math.max(ex.importance, rec.importance ?? 0);
          if (rec.tags?.length) ex.tags = [...new Set([...(ex.tags ?? []), ...rec.tags])];
          if (records.has(ex.id)) {
            schedulePersist();
            void moss?.upsert([ex]);
          }
          ctx.bus.emit("memory.write", { record: { ...ex }, policy });
          return ex;
        }
        const r: MemoryRecord = {
          id: rec.id ?? newId("mem"),
          kind: rec.kind,
          content,
          importance: rec.importance ?? 0.5,
          confidence: rec.confidence ?? 0.7,
          source: rec.source ?? "observation",
          createdAt: rec.createdAt ?? now(),
          ...(rec.lastRecalledAt ? { lastRecalledAt: rec.lastRecalledAt } : {}),
          ...(rec.tags?.length || isShort ? { tags: [...new Set([...(rec.tags ?? []), ...(isShort ? ["short-term"] : [])])] } : {}),
        };
        vecs.set(r.id, v);
        if (isShort) short.set(r.id, { rec: r, expiresAt: now() + shortTtl });
        else {
          records.set(r.id, r);
          schedulePersist();
          void moss?.upsert([r]);
        }
        ctx.bus.emit("memory.write", { record: { ...r }, policy });
        return r;
      };

      const observe: MemoryService["observe"] = async (ex: Exchange) => {
        if (!ex.user && !ex.event && !ex.eve) return [];
        const d = await decide(ex, ctx.tryUse("brains"));
        if (d.relationship) {
          try {
            ctx.tryUse("relationship")?.nudge(d.relationship, `memory: ${d.policy.toLowerCase()}`);
          } catch {}
        }
        const out: MemoryRecord[] = [];
        for (const f of d.facts) {
          const r = await write(
            { kind: f.kind, content: f.content, importance: f.importance, confidence: f.confidence, source: d.by === "brain" ? "observation" : "observation:keywords", tags: f.tags },
            f.policy,
          );
          if (r) out.push(r);
        }
        return out;
      };

      const service: MemoryServiceImpl = {
        recall,
        write,
        observe,
        count: () => records.size,
        all: () => [...records.values()],
        shortTerm: () => {
          pruneShort();
          return [...short.values()].map((s) => s.rec);
        },
        vectors: (id) => vecs.get(id),
        flush: () => flushNow?.() ?? Promise.resolve(),
        backend: () => ({ embeddings: openaiLive() ? "openai" : "local", moss: !!moss?.ready() }),
      };
      ctx.provide("memory", service);

      // --- bus facts -------------------------------------------------------------------
      const mean: Record<string, number> = {};
      if (candidates.length) for (const t of TRAIT_KEYS) mean[t] = candidates.reduce((s, c) => s + (c.traits[t] ?? 0), 0) / candidates.length;

      offs.push(
        ctx.bus.on("dating.signal", (e) => {
          const s = e.data;
          if (s.interest.positive < 0.5 || s.strength < 0.6) return;
          const c = candidates.find((x) => x.id === s.candidateId);
          if (!c) return;
          const standout = TRAIT_KEYS.map((t) => [t, (c.traits[t] ?? 0) - (mean[t] ?? 0.5)] as const)
            .filter(([, d]) => d > 0.1)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 2)
            .map(([t]) => t.replace("_", " "));
          if (!standout.length) return;
          void write(
            {
              kind: "preference",
              content: `Drawn to ${standout.join(" and ")} in a partner (lingered on ${c.name}'s profile)`,
              importance: Math.min(0.8, 0.4 + 0.4 * s.strength),
              confidence: Math.min(0.9, 0.5 + 0.4 * s.interest.positive),
              source: "act1:attention",
              tags: ["type", ...standout],
            },
            "UPDATE_PREFERENCE",
          );
        }),
        ctx.bus.on("task.done", (e) => {
          if (!e.data.summary?.trim()) return;
          void write(
            {
              kind: "episodic",
              content: `${e.data.ok ? "Eve handled" : "Eve tried and failed"}: ${e.data.summary.trim().slice(0, 140)}`,
              importance: e.data.ok ? 0.55 : 0.4,
              confidence: 0.95,
              source: "task",
              tags: ["task"],
            },
            "STORE_LONG_TERM",
          );
        }),
        ctx.bus.on("swarm.merge", async (e) => {
          for (const fact of e.data.retained ?? []) {
            if (typeof fact !== "string" || !fact.trim()) continue;
            await write({ kind: "fact", content: fact.trim().slice(0, 200), importance: 0.5, confidence: 0.75, source: "swarm", tags: ["swarm"] }, "STORE_LONG_TERM");
          }
        }),
      );

      // --- gbrain: matt's knowledge brain, never on the reply path (docs/KNOW_ME.md) -------
      const g = opts.gbrain === null ? null : (opts.gbrain ?? {});
      const realHome = ctx.config.eveHome === join(homedir(), ".eve");
      const testing = process.env.NODE_ENV === "test" && !g?.runner;
      const envOn = secret("EVE_GBRAIN");
      const gbrainOn = !!g && !testing && (g.enabled ?? (!!g.runner || envOn === "1" || (envOn !== "0" && realHome))) && (!!g.runner || gbrainInstalled());
      const envWrite = secret("EVE_GBRAIN_WRITE");
      const writeOn = gbrainOn && (g!.write ?? (envWrite === "1" || (envWrite !== "0" && realHome)));
      const client = gbrainOn ? new GbrainClient(g!.runner ?? bunRunner()) : null;
      let digest: Digest | null = null;
      let digesting: Promise<Digest | null> | null = null;
      const live = { lookups: 0, hits: 0, inflight: 0, lastQuery: "", lastMs: 0, lastAt: 0 };
      const recentCues = new Map<string, number>();
      const gTimer = (ms: number, fn: () => void) => {
        const t = setTimeout(() => {
          gbrainTimers.delete(t);
          fn();
        }, ms);
        (t as { unref?: () => void }).unref?.();
        gbrainTimers.add(t);
      };
      const who = () => {
        const u = ctx.tryUse("user")?.profile();
        return u?.callMe || u?.name?.split(/\s+/)[0]?.toLowerCase() || "matt";
      };

      /** Fold a digest into the profile (onboarding wins) and the long-term store (replacing the last digest's facts). */
      const applyDigest = async (d: Digest, replaceFacts: boolean) => {
        try {
          if (Object.keys(d.profile).length) await ctx.tryUse("user")?.merge(d.profile, "gbrain");
        } catch (err) {
          log("gbrain profile merge failed:", err);
        }
        if (!replaceFacts || !d.facts.length) return;
        const keep = new Set(d.facts.map((f) => f.content.toLowerCase()));
        for (const r of [...records.values()])
          if (r.source === "gbrain" && r.tags?.includes("digest") && !keep.has(r.content.toLowerCase())) {
            records.delete(r.id);
            vecs.delete(r.id);
          }
        for (const f of d.facts)
          await write({ kind: "fact", content: f.content, importance: f.importance, confidence: 0.7, source: "gbrain", tags: ["gbrain", "digest"] }, "STORE_LONG_TERM");
        schedulePersist();
      };

      const runDigest = (): Promise<Digest | null> => {
        if (!client) return Promise.resolve(null);
        if (digesting) return digesting;
        digesting = (async () => {
          log("gbrain digest: querying");
          const d = await buildDigest({ client, brains: ctx.tryUse("brains"), who: who(), now, log, queryTimeoutMs: g!.queryTimeoutMs });
          if (d.by === "none") {
            log(`gbrain digest: nothing (${d.error})`);
            if (digest) digest = { ...digest, error: d.error };
            return null;
          }
          digest = d;
          await home.write("gbrain", d);
          await applyDigest(d, true);
          log(`gbrain digest: ${d.facts.length} facts, profile ${Object.keys(d.profile).join(",") || "-"} by ${d.by} in ${Math.round(d.ms / 1000)}s`);
          return d;
        })().finally(() => (digesting = null));
        return digesting;
      };

      if (client) {
        digest = await home.read<Digest | null>("gbrain", null);
        if (digest) void applyDigest(digest, false);
        if (g!.digest !== false) {
          const check = () => {
            if (!digest || now() - digest.at > DIGEST_MAX_AGE_MS) void runDigest();
            gTimer(3600_000, check);
          };
          gTimer(g!.digestDelayMs ?? 20_000, check);
        }
        if (writeOn) writeback = new GbrainWriteback({ client, debounceMs: g!.writeDebounceMs, now, who, log });
      }

      /** Fire-and-forget: search gbrain for what he just mentioned; results are for her NEXT turn. */
      const lookup = async (text: string) => {
        if (!client || live.inflight >= 2) return;
        const known = (ctx.tryUse("user")?.profile().people ?? []).map((p) => p.name);
        const cue = liveCue(text, known);
        if (!cue) return;
        const key = cue.query.toLowerCase();
        const coolMs = g!.liveCooldownMs ?? 10 * 60_000;
        if (now() - (recentCues.get(key) ?? -Infinity) < coolMs) return;
        recentCues.set(key, now());
        live.inflight += 1;
        live.lookups += 1;
        live.lastQuery = cue.query;
        try {
          const hits = await client.search(cue.query, { timeoutMs: g!.liveTimeoutMs ?? 2500, limit: 6 });
          live.lastMs = client.stats.lastMs ?? 0;
          live.lastAt = now();
          const top = filterHits(hits ?? [], { relative: 0.7, perPrefix: 2 }).slice(0, 3);
          if (!top.length) return;
          live.hits += top.length;
          for (const h of top)
            await write(
              { kind: "fact", content: `from ${who()}'s notes (${h.slug}): ${h.text.slice(0, 220)}`, importance: 0.5, confidence: 0.6, source: "gbrain", tags: ["gbrain", "live"] },
              "STORE_SHORT_TERM",
            );
          ctx.setSlot("gbrain", "recall", `his notes on "${cue.query}": ${top.map((h) => h.text.slice(0, 160)).join(" | ")}`);
          const setAt = now();
          gTimer(g!.liveSlotMs ?? 5 * 60_000, () => {
            if (live.lastAt <= setAt) ctx.setSlot("gbrain", "recall", null);
          });
        } catch (err) {
          log("gbrain lookup failed:", err);
        } finally {
          live.inflight -= 1;
        }
      };
      if (client)
        offs.push(
          ctx.bus.on("voice.final", (e) => {
            // Never awaited: the reply path only reads local memory.
            void lookup(e.data.text ?? "");
          }),
        );
      if (writeback) offs.push(ctx.bus.on("memory.write", (e) => void writeback?.offer(e.data.record, e.data.policy)));

      const gbrainStatus = () => ({
        live: !!client,
        write: !!writeback,
        realHome,
        digest: digest ? { at: digest.at, ageMin: Math.round((now() - digest.at) / 60_000), ms: digest.ms, by: digest.by, facts: digest.facts.length, queries: digest.queries, hits: digest.hits, error: digest.error } : null,
        digesting: !!digesting,
        lookups: { ...live },
        pendingWrites: writeback?.pending() ?? 0,
        written: writeback?.written ?? 0,
        writeFailures: writeback?.failed ?? 0,
        lastWriteAt: writeback?.lastWriteAt,
        cli: client ? { ...client.stats } : null,
      });
      service.gbrain = gbrainStatus;
      ctx.route("/api/memory/status", async (req) => {
        if (req.method === "POST") {
          // POST { digest: true } forces a digest now (background; poll status).
          const body = (await req.json().catch(() => ({}))) as { digest?: boolean; flush?: boolean };
          if (body.digest) void runDigest();
          if (body.flush) await writeback?.flush();
        }
        return json({ ok: true, count: records.size, shortTerm: service.shortTerm().length, backend: service.backend(), gbrain: gbrainStatus() });
      });

      // --- routes ---------------------------------------------------------------------
      ctx.route("/api/memory/recall", async (req) => {
        if (req.method !== "POST") return null;
        const body = (await req.json().catch(() => ({}))) as { query?: string; k?: number; kinds?: MemoryRecord["kind"][]; emit?: boolean };
        if (!body.query?.trim()) return json({ ok: false, error: "query required" }, 400);
        const t0 = performance.now();
        const hits = await recall(body.query, { k: body.k, kinds: body.kinds, emit: body.emit });
        return json({ ok: true, hits, ms: Math.round((performance.now() - t0) * 10) / 10, backend: service.backend() });
      });
      ctx.route("/api/memory/observe", async (req) => {
        if (req.method !== "POST") return null;
        const body = (await req.json().catch(() => ({}))) as Exchange;
        return json({ ok: true, records: await observe(body) });
      });
      ctx.route("/api/memory", async (req, url) => {
        if (url.pathname !== "/api/memory" && url.pathname !== "/api/memory/") return null;
        if (req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as Partial<MemoryRecord> & { policy?: MemoryWritePolicy };
          if (!body.content || !body.kind) return json({ ok: false, error: "kind and content required" }, 400);
          const r = await write({ ...body, kind: body.kind, content: body.content, source: body.source ?? "api" }, body.policy);
          return json({ ok: true, record: r });
        }
        const kind = url.searchParams.get("kind");
        const list = [...records.values()].filter((r) => !kind || r.kind === kind).sort((a, b) => b.createdAt - a.createdAt);
        return json({ ok: true, count: list.length, records: list, shortTerm: service.shortTerm(), backend: service.backend() });
      });

      log(`${records.size} memories, embeddings ${embedder ? "openai+local" : "local"}${moss ? ", moss on" : ""}`);
    },
    async stop() {
      for (const off of offs.splice(0)) off();
      for (const t of gbrainTimers) clearTimeout(t);
      gbrainTimers.clear();
      if (writeback) {
        writeback.stop();
        await Promise.race([writeback.flush().catch(() => {}), Bun.sleep(3000)]);
        writeback = null;
      }
      await flushNow?.().catch(() => {});
      flushNow = null;
      await moss?.close();
    },
  };
}
