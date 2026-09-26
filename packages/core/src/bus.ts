import {
  envelope,
  matchesType,
  type AnyEnvelope,
  type Envelope,
  type EventMap,
  type EventType,
} from "@eigenwife/protocol";

type Handler<K extends EventType> = (e: Envelope<K>) => unknown;

/**
 * In-process pub/sub. The hub bridges it to websocket clients, so a module in
 * the core and a React component in the shell see the exact same stream.
 */
export class EventBus {
  private handlers = new Map<string, Set<Handler<any>>>();
  private history: AnyEnvelope[] = [];
  private taps = new Set<(e: AnyEnvelope) => void>();

  constructor(private historySize = 500) {}

  on<K extends EventType>(type: K, h: Handler<K>): () => void;
  on(pattern: string, h: (e: AnyEnvelope) => unknown): () => void;
  on(pattern: string, h: Handler<any>): () => void {
    let set = this.handlers.get(pattern);
    if (!set) this.handlers.set(pattern, (set = new Set()));
    set.add(h);
    return () => set!.delete(h);
  }

  /** Resolve with the next event of this type that passes the filter. */
  once<K extends EventType>(type: K, filter: (e: Envelope<K>) => boolean = () => true, timeoutMs = 0): Promise<Envelope<K> | null> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const off = this.on(type, (e) => {
        if (!filter(e)) return;
        off();
        if (timer) clearTimeout(timer);
        resolve(e);
      });
      if (timeoutMs > 0)
        timer = setTimeout(() => {
          off();
          resolve(null);
        }, timeoutMs);
    });
  }

  /** Every published event, after handlers ran. The hub uses this to fan out. */
  tap(fn: (e: AnyEnvelope) => void): () => void {
    this.taps.add(fn);
    return () => this.taps.delete(fn);
  }

  emit<K extends EventType>(type: K, data: EventMap[K], source = "core", parent?: string): Envelope<K> {
    const e = envelope(type, data, source, parent);
    this.publish(e as AnyEnvelope);
    return e;
  }

  publish(e: AnyEnvelope): void {
    this.history.push(e);
    if (this.history.length > this.historySize) this.history.splice(0, this.history.length - this.historySize);
    for (const [pattern, set] of this.handlers) {
      if (!matchesType(pattern, e.type)) continue;
      for (const h of set) {
        try {
          const r = h(e);
          if (r && typeof (r as Promise<void>).catch === "function")
            (r as Promise<void>).catch((err) => console.error(`[bus] async handler for ${pattern} failed:`, err));
        } catch (err) {
          console.error(`[bus] handler for ${pattern} threw:`, err);
        }
      }
    }
    for (const t of this.taps) t(e);
  }

  recent(pattern = "*", limit = 50): AnyEnvelope[] {
    return this.history.filter((e) => matchesType(pattern, e.type)).slice(-limit);
  }
}
