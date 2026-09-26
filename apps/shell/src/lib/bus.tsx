import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BusClient } from "@eigenwife/protocol/client";
import {
  emptyWorld,
  reduceWorld,
  type AnyEnvelope,
  type Envelope,
  type EventMap,
  type EventType,
  type WorldSnapshot,
} from "@eigenwife/protocol";

const coreUrl = new URLSearchParams(location.search).get("core") ?? "127.0.0.1:7777";
export const CORE_HTTP = `http://${coreUrl}`;

interface BusValue {
  client: BusClient;
  emit<K extends EventType>(type: K, data: EventMap[K], parent?: string): Envelope<K>;
}

const BusContext = createContext<BusValue | null>(null);
const WorldContext = createContext<{ world: WorldSnapshot; connected: boolean }>({ world: emptyWorld(), connected: false });

export function BusProvider({ children }: { children: ReactNode }) {
  const client = useMemo(() => new BusClient({ url: `ws://${coreUrl}/bus`, client: "shell", role: "shell" }), []);
  const [world, setWorld] = useState<WorldSnapshot>(emptyWorld);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const offAll = client.on("*", (e: AnyEnvelope) => setWorld((w) => reduceWorld(w, e)));
    const offStatus = client.onStatus(setConnected);
    client.connect();
    return () => {
      offAll();
      offStatus();
      client.close();
    };
  }, [client]);

  const value = useMemo<BusValue>(() => ({ client, emit: (t, d, p) => client.emit(t, d, p) }), [client]);
  return (
    <BusContext.Provider value={value}>
      <WorldContext.Provider value={{ world, connected }}>{children}</WorldContext.Provider>
    </BusContext.Provider>
  );
}

export function useBus(): BusValue {
  const v = useContext(BusContext);
  if (!v) throw new Error("useBus outside BusProvider");
  return v;
}

export function useWorld() {
  return useContext(WorldContext);
}

/** Subscribe to a bus event type or pattern for the component's lifetime. Handler may change freely. */
export function useEvent<K extends EventType>(type: K, handler: (e: Envelope<K>) => void): void;
export function useEvent(pattern: string, handler: (e: AnyEnvelope) => void): void;
export function useEvent(pattern: string, handler: (e: any) => void) {
  const { client } = useBus();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => client.on(pattern, (e: AnyEnvelope) => ref.current(e)), [client, pattern]);
}

/** Latest payload of an event type, or null. */
export function useLatest<K extends EventType>(type: K): Envelope<K> | null {
  const [v, setV] = useState<Envelope<K> | null>(null);
  useEvent(type, (e) => setV(e as Envelope<K>));
  return v;
}
