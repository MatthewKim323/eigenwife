import type { MemoryRecord, MemoryWritePolicy } from "@eigenwife/protocol";
import type { GbrainClient } from "./gbrain";
import { PRIVATE } from "./gbrain-digest";
import { looksSensitive } from "./policy";

/**
 * Write-back: important facts she learns in conversation go into gbrain, the
 * way jabby's fact-writeback does it (append bullets to a per-day page), on
 * her own page family so the two never race on one page:
 *
 *   eigenwife/learned/YYYY-MM-DD
 *   - [HH:MM] (eigenwife) matt: Prefers concise answers
 *
 * Batched and debounced; one write in flight. Never: anything sensitive
 * (the memory policy's secret check plus private topics), anything tagged
 * private (onboarding boundaries), anything screen-derived, anything that
 * came from gbrain in the first place, demo seeds.
 */

export interface WritebackOptions {
  client: GbrainClient;
  /** Batch window after the last new fact. */
  debounceMs?: number;
  maxBatch?: number;
  now?: () => number;
  /** Local timezone offset in minutes for the page date (default: this machine's). */
  tzOffsetMin?: number;
  who?: () => string;
  log?: (...a: unknown[]) => void;
}

const SOURCES_NEVER = /^(?:gbrain|seed|screen|vision|act1|swarm)|screen/i;
const TAGS_NEVER = new Set(["private", "sensitive", "boundary", "screen", "short-term"]);

/** Should this memory write go to gbrain? */
export function eligible(rec: MemoryRecord, policy: MemoryWritePolicy): boolean {
  if (policy !== "STORE_LONG_TERM" && policy !== "UPDATE_PREFERENCE") return false;
  if (rec.importance < 0.7) return false;
  if (SOURCES_NEVER.test(rec.source)) return false;
  if (rec.tags?.some((t) => TAGS_NEVER.has(t))) return false;
  if (looksSensitive(rec.content) || PRIVATE.test(rec.content)) return false;
  return true;
}

export function pageSlug(ts: number, tzOffsetMin: number): string {
  return `eigenwife/learned/${new Date(ts + tzOffsetMin * 60_000).toISOString().slice(0, 10)}`;
}

function hhmm(ts: number, tzOffsetMin: number): string {
  return new Date(ts + tzOffsetMin * 60_000).toISOString().slice(11, 16);
}

export function factsOnPage(page: string): string[] {
  const out: string[] = [];
  for (const line of page.split("\n")) {
    const m = /^- \[\d{2}:\d{2}\] \(eigenwife\) (?:[^:]{1,40}: )?(.+)$/.exec(line);
    if (m?.[1]) out.push(m[1].trim().toLowerCase());
  }
  return out;
}

export class GbrainWriteback {
  private queue: MemoryRecord[] = [];
  private queuedIds = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy: Promise<void> | null = null;
  written = 0;
  failed = 0;
  lastWriteAt?: number;
  lastError?: string;

  constructor(private o: WritebackOptions) {}

  pending(): number {
    return this.queue.length;
  }

  /** Offer a memory write; eligible ones are queued. Returns whether it was queued. */
  offer(rec: MemoryRecord, policy: MemoryWritePolicy): boolean {
    if (!eligible(rec, policy) || this.queuedIds.has(rec.id)) return false;
    this.queuedIds.add(rec.id);
    this.queue.push({ ...rec });
    if (this.timer) clearTimeout(this.timer);
    const full = this.queue.length >= (this.o.maxBatch ?? 12);
    this.timer = setTimeout(() => void this.flush(), full ? 0 : (this.o.debounceMs ?? 30_000));
    (this.timer as { unref?: () => void }).unref?.();
    return true;
  }

  /** Write everything queued as one page update. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.busy) await this.busy;
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, this.o.maxBatch ?? 12);
    this.busy = this.write(batch).finally(() => (this.busy = null));
    await this.busy;
    if (this.queue.length) await this.flush();
  }

  private async write(batch: MemoryRecord[]) {
    const now = (this.o.now ?? Date.now)();
    const tz = this.o.tzOffsetMin ?? -new Date(now).getTimezoneOffset();
    const slug = pageSlug(now, tz);
    const existing = await this.o.client.get(slug);
    const known = new Set(factsOnPage(existing));
    const fresh = batch.filter((r) => {
      const k = r.content.trim().toLowerCase();
      if (known.has(k)) return false;
      known.add(k);
      return true;
    });
    if (!fresh.length) return;
    const who = this.o.who?.() || "matt";
    const header = `# eigenwife learned ${slug.slice(-10)}\n\nFacts Eve (eigenwife, matt's desktop companion) learned talking with ${who} on ${slug.slice(-10)}. Auto-extracted, source: eigenwife.\n`;
    const body = existing.trim() ? existing.trimEnd() : header.trimEnd();
    const lines = fresh.map((r) => `- [${hhmm(now, tz)}] (eigenwife) ${who}: ${r.content.trim().replace(/\s*[\u2013\u2014]\s*/g, ", ")}`);
    const ok = await this.o.client.put(slug, `${body}\n${lines.join("\n")}\n`);
    if (ok) {
      this.written += fresh.length;
      this.lastWriteAt = now;
      this.o.log?.(`+${fresh.length} fact${fresh.length === 1 ? "" : "s"} -> ${slug}`);
    } else {
      this.failed += fresh.length;
      this.lastError = `put ${slug} failed`;
      this.o.log?.(this.lastError);
    }
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
