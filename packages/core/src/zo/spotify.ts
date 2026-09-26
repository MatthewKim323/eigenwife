import type { CoreContext } from "../context";
import type { NowPlaying, ZoService } from "./apps";

/**
 * Media awareness through Zo: polls Spotify's currently-playing track (so it
 * works when the music is on matt's phone, not this laptop) and emits
 * `media.play` { track, artist } when the song changes or restarts on repeat.
 * That feeds the reflex rule "same breakup song 4 times".
 *
 * Background only: the poll never blocks anything, uses the low-priority Zo
 * lane, backs off on errors (up to 5 min) and slows to idleMs after a few
 * polls with nothing playing. A media.play from another source (the local
 * watcher) for the same track within dedupeMs suppresses ours, so one listen
 * is one event.
 */

export const ZO_MEDIA_SOURCE = "zo";

export interface SpotifyPollerOptions {
  zo: Pick<ZoService, "nowPlaying">;
  bus: CoreContext["bus"];
  intervalMs?: number;
  idleMs?: number;
  maxBackoffMs?: number;
  dedupeMs?: number;
  now?: () => number;
  log?: (...a: unknown[]) => void;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export class SpotifyPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastKey: string | null = null;
  private lastProgress = 0;
  private errors = 0;
  private idle = 0;
  private recent = new Map<string, number>();
  private off: (() => void) | null = null;
  private now: () => number;
  emitted = 0;
  polls = 0;
  lastPlaying: NowPlaying | null = null;

  constructor(private o: SpotifyPollerOptions) {
    this.now = o.now ?? Date.now;
  }

  start(firstDelayMs = 3000): void {
    if (this.running) return;
    this.running = true;
    this.off = this.o.bus.on("media.play", (e) => {
      if (e.source === ZO_MEDIA_SOURCE) return;
      this.recent.set(norm(e.data.track), e.ts);
    });
    this.schedule(firstDelayMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.off?.();
    this.off = null;
  }

  /** Next delay: base interval, slower when idle, exponential on errors. */
  nextDelay(): number {
    const base = this.o.intervalMs ?? 25_000;
    if (this.errors) return Math.min(this.o.maxBackoffMs ?? 300_000, base * 2 ** this.errors);
    if (this.idle >= 3) return this.o.idleMs ?? 60_000;
    return base;
  }

  private schedule(ms: number) {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.tick();
      this.schedule(this.nextDelay());
    }, ms);
  }

  /** One poll. Public for tests. Never throws. */
  async tick(): Promise<void> {
    this.polls++;
    let r;
    try {
      r = await this.o.zo.nowPlaying();
    } catch (e) {
      r = { ok: false, ms: 0, error: String(e) };
    }
    if (!r.ok || !r.value) {
      this.errors = Math.min(this.errors + 1, 6);
      if (this.errors === 1) this.o.log?.("zo spotify poll failed:", r.error);
      return;
    }
    this.errors = 0;
    const np = r.value;
    this.lastPlaying = np;
    if (!np.playing || !np.track) {
      this.idle++;
      return;
    }
    this.idle = 0;
    const key = np.id ?? norm(`${np.track}|${np.artist ?? ""}`);
    const progress = np.progressMs ?? 0;
    const changed = key !== this.lastKey;
    // Same song, playhead jumped back: it started over (repeat). Counts as another listen.
    const replay = !changed && np.progressMs !== undefined && progress + 5000 < this.lastProgress;
    this.lastKey = key;
    this.lastProgress = progress;
    if (!changed && !replay) return;
    const t = this.now();
    for (const [k, at] of this.recent) if (t - at > (this.o.dedupeMs ?? 60_000)) this.recent.delete(k);
    if (this.recent.has(norm(np.track))) return;
    this.emitted++;
    this.o.bus.emit("media.play", { track: np.track, ...(np.artist ? { artist: np.artist } : {}) }, ZO_MEDIA_SOURCE);
  }
}
