/**
 * Live minutes per local day, for the cost guard (EVE_LIVE_DAILY_MIN).
 * gpt-live-1 bills every second a session is open (silence included), so the
 * meter counts the larger of the provider's cumulative usage.seconds and the
 * wall clock since session.started. Persisted in ~/.eve/live-usage.json.
 */

export interface UsageFile {
  day: string;
  seconds: number;
}

export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class UsageMeter {
  private day: string;
  /** Seconds from sessions that already ended today. */
  private closed = 0;
  private session: { startedAt: number; reported: number } | null = null;

  constructor(
    private now: () => number = Date.now,
    saved?: UsageFile | null,
  ) {
    this.day = localDay(now());
    if (saved && saved.day === this.day && Number.isFinite(saved.seconds)) this.closed = Math.max(0, saved.seconds);
  }

  private roll() {
    const d = localDay(this.now());
    if (d === this.day) return;
    this.day = d;
    this.closed = 0;
    // A session running across midnight counts toward the new day from here.
    if (this.session) this.session = { startedAt: this.now(), reported: 0 };
  }

  begin() {
    this.roll();
    if (!this.session) this.session = { startedAt: this.now(), reported: 0 };
  }

  /** session.usage.updated / session.closed: cumulative seconds for this session. */
  report(seconds: number) {
    if (!this.session || !Number.isFinite(seconds)) return;
    this.session.reported = Math.max(this.session.reported, seconds);
  }

  end(finalSeconds?: number) {
    this.roll();
    if (!this.session) return;
    if (finalSeconds !== undefined) this.report(finalSeconds);
    this.closed += this.sessionSeconds();
    this.session = null;
  }

  private sessionSeconds(): number {
    if (!this.session) return 0;
    const wall = Math.max(0, (this.now() - this.session.startedAt) / 1000);
    return Math.max(wall, this.session.reported);
  }

  seconds(): number {
    this.roll();
    return this.closed + this.sessionSeconds();
  }

  minutes(): number {
    return this.seconds() / 60;
  }

  get running(): boolean {
    return this.session !== null;
  }

  toJSON(): UsageFile {
    return { day: this.day, seconds: Math.round(this.seconds()) };
  }
}
