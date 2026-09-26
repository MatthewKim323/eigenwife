import {
  BUS_PATH,
  BUS_PORT,
  envelope,
  matchesType,
  parseEnvelope,
  type AnyEnvelope,
  type Envelope,
  type EventMap,
  type EventType,
} from "./index";

type Handler<K extends EventType> = (e: Envelope<K>) => unknown;

export interface BusClientOptions {
  url?: string;
  client: string;
  role: EventMap["bus.hello"]["role"];
  /** Reconnect delay ceiling in ms. */
  maxBackoffMs?: number;
  WebSocketImpl?: typeof WebSocket;
}

/**
 * Tiny reconnecting bus client. Runs unchanged in the browser and in Bun.
 * Messages sent while disconnected are queued and flushed on reconnect.
 */
export class BusClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler<any>>>();
  private queue: string[] = [];
  private backoff = 250;
  private closed = false;
  private statusHandlers = new Set<(up: boolean) => void>();
  readonly url: string;
  connected = false;

  constructor(private opts: BusClientOptions) {
    this.url = opts.url ?? `ws://127.0.0.1:${BUS_PORT}${BUS_PATH}`;
  }

  connect(): this {
    this.closed = false;
    this.open();
    return this;
  }

  private open() {
    const WS = this.opts.WebSocketImpl ?? WebSocket;
    let ws: WebSocket;
    try {
      ws = new WS(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) {
        ws.close();
        return;
      }
      this.connected = true;
      this.backoff = 250;
      ws.send(JSON.stringify(envelope("bus.hello", { client: this.opts.client, role: this.opts.role, version: "0.1.0" }, this.opts.client)));
      for (const m of this.queue.splice(0)) ws.send(m);
      this.statusHandlers.forEach((h) => h(true));
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      const e = parseEnvelope(typeof ev.data === "string" ? ev.data : String(ev.data));
      if (e) this.dispatch(e);
    };
    ws.onclose = () => {
      // A socket we already replaced or closed on purpose (React StrictMode
      // close+connect) must not schedule a second, duplicate connection.
      if (this.ws !== ws) return;
      const was = this.connected;
      this.connected = false;
      this.ws = null;
      if (was) this.statusHandlers.forEach((h) => h(false));
      if (!this.closed) this.scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  }

  private scheduleReconnect() {
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs ?? 4000);
    setTimeout(() => {
      if (!this.closed) this.open();
    }, wait);
  }

  dispatch(e: AnyEnvelope) {
    for (const [pattern, set] of this.handlers) {
      if (!matchesType(pattern, e.type)) continue;
      for (const h of set) {
        try {
          h(e);
        } catch (err) {
          console.error(`[bus-client] handler for ${pattern} threw`, err);
        }
      }
    }
  }

  on<K extends EventType>(type: K, h: Handler<K>): () => void;
  on(pattern: string, h: (e: AnyEnvelope) => unknown): () => void;
  on(pattern: string, h: Handler<any>): () => void {
    let set = this.handlers.get(pattern);
    if (!set) this.handlers.set(pattern, (set = new Set()));
    set.add(h);
    return () => set!.delete(h);
  }

  onStatus(h: (up: boolean) => void): () => void {
    this.statusHandlers.add(h);
    return () => this.statusHandlers.delete(h);
  }

  emit<K extends EventType>(type: K, data: EventMap[K], parent?: string): Envelope<K> {
    const e = envelope(type, data, this.opts.client, parent);
    const raw = JSON.stringify(e);
    // The hub never echoes to the sender, so local listeners hear it here.
    this.dispatch(e as AnyEnvelope);
    if (this.ws && this.connected) this.ws.send(raw);
    else this.queue.push(raw);
    return e;
  }

  close() {
    this.closed = true;
    const ws = this.ws;
    this.ws = null;
    if (this.connected) {
      this.connected = false;
      this.statusHandlers.forEach((h) => h(false));
    }
    ws?.close();
  }
}
