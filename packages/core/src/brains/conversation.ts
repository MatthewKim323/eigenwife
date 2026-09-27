/**
 * The conversation she's having with him, across the whole session and across
 * restarts. Every reply prompt gets the recent turns verbatim plus a rolling
 * summary of everything older, so "no, the other one" and "like i said
 * earlier" just work. Summarizing runs in the background, never on a reply.
 */
export interface Turn {
  role: "user" | "eve";
  text: string;
  at: number;
}

export interface ConversationOptions {
  /** Turns kept verbatim in prompts. */
  recent?: number;
  /** When the buffer passes this, the oldest turns get folded into the summary. */
  foldAt?: number;
  now?: () => number;
}

const clean = (t: string) => t.replace(/\[(?:mood|pause):[^\]]*\]/gi, "").replace(/\s+/g, " ").trim();

export class Conversation {
  turns: Turn[] = [];
  summary = "";
  private folding = false;
  private opts: Required<ConversationOptions>;

  constructor(opts: ConversationOptions = {}) {
    this.opts = { recent: 16, foldAt: 40, now: Date.now, ...opts };
  }

  add(role: Turn["role"], text: string): Turn | null {
    const t = clean(text);
    if (!t) return null;
    const last = this.turns.at(-1);
    // Her line arrives in pieces (speech.begin per utterance): merge back-to-back pieces within 8s.
    if (last && last.role === role && role === "eve" && this.opts.now() - last.at < 8000) {
      last.text = `${last.text} ${t}`;
      last.at = this.opts.now();
      return last;
    }
    const turn = { role, text: t, at: this.opts.now() };
    this.turns.push(turn);
    return turn;
  }

  /** The block every persona prompt gets. */
  block(name = "you"): string {
    const lines: string[] = [];
    if (this.summary) lines.push(`earlier in this conversation: ${this.summary}`);
    const recent = this.turns.slice(-this.opts.recent);
    if (recent.length) {
      lines.push("recent conversation (oldest first):");
      for (const t of recent) lines.push(`${t.role === "user" ? "him" : name}: ${t.text}`);
    }
    return lines.join("\n");
  }

  /** True when older turns should be folded into the summary. */
  needsFold(): boolean {
    return !this.folding && this.turns.length > this.opts.foldAt;
  }

  /**
   * Fold the oldest turns into the summary with a summarizer (a brain call).
   * Turns are only dropped after the summary is back, so a failed call loses nothing.
   */
  async fold(summarize: (previous: string, turns: Turn[]) => Promise<string | null>): Promise<boolean> {
    if (!this.needsFold()) return false;
    this.folding = true;
    try {
      const n = this.turns.length - this.opts.recent;
      const old = this.turns.slice(0, n);
      const next = await summarize(this.summary, old);
      if (!next?.trim()) return false;
      this.summary = next.trim().slice(0, 1500);
      this.turns = this.turns.slice(n);
      return true;
    } finally {
      this.folding = false;
    }
  }

  toJSON() {
    return { summary: this.summary, turns: this.turns };
  }

  load(data: { summary?: string; turns?: Turn[] } | null | undefined) {
    if (!data) return;
    this.summary = typeof data.summary === "string" ? data.summary : "";
    this.turns = Array.isArray(data.turns) ? data.turns.filter((t) => t && (t.role === "user" || t.role === "eve") && typeof t.text === "string") : [];
  }
}
