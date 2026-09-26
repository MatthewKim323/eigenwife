import { applyWear, describeOutfit, WARDROBE_ITEMS } from "@eigenwife/protocol";
import type { CoreContext, Module } from "../context";
import { json } from "../hub";
import type { WardrobeService, WardrobeState } from "../services";

/**
 * What Eve has on. Outfits change only when the user asks (spoken, the tray,
 * or an avatar.wear action): no time-of-day or mood rules. The state persists
 * in home ("wardrobe" -> ~/.eve/wardrobe.json) and is restored on start with
 * avatar.outfit { by: "restore" }. The world slot `wardrobe.wearing` puts it in
 * every persona prompt; `wardrobe.items` (ids) lets a shell that connects later
 * pick it up from the welcome snapshot. See docs/WARDROBE.md.
 */

export const HOME_FILE = "wardrobe";
const SRC = "core";

export interface WardrobeOptions {
  now?: () => number;
}

export function createWardrobe(ctx: CoreContext, opts: WardrobeOptions = {}) {
  const now = opts.now ?? Date.now;
  let state: WardrobeState = { items: [], by: "restore", updatedAt: 0 };
  /** null until the shell reports its model: then only its items can be worn. */
  let modelItems: string[] | null = null;

  const publish = () => {
    ctx.setSlot("wardrobe", "wearing", describeOutfit(state.items));
    ctx.setSlot("wardrobe", "items", state.items.join(","));
  };

  const available = () => (modelItems ?? Object.keys(WARDROBE_ITEMS)).filter((id) => !!WARDROBE_ITEMS[id]);

  async function persist() {
    await ctx
      .tryUse("home")
      ?.write(HOME_FILE, state)
      .catch((err) => ctx.log("wardrobe", "persist failed:", err));
  }

  const service: WardrobeService = {
    get: () => ({ ...state, items: [...state.items] }),
    available,
    async wear(change, by = "user") {
      const avail = available();
      const asked = change.add ?? [];
      const unavailable = asked.filter((id) => !avail.includes(id));
      const remove = change.remove === "all" ? state.items : (change.remove ?? []);
      const items = applyWear(state.items, { add: asked, remove }, WARDROBE_ITEMS, avail);
      const changed = items.join(",") !== state.items.join(",");
      if (changed) {
        state = { items, by, updatedAt: now() };
        publish();
        ctx.bus.emit("avatar.outfit", { items, by }, SRC);
        await persist();
        ctx.log("wardrobe", `${by}: ${describeOutfit(items)}`);
      }
      return { items: [...state.items], changed, unavailable };
    },
  };

  async function restore() {
    const saved = await ctx
      .tryUse("home")
      ?.read<WardrobeState | null>(HOME_FILE, null)
      .catch(() => null);
    const items = applyWear([], { add: Array.isArray(saved?.items) ? saved!.items : [] });
    state = { items, by: "restore", updatedAt: saved?.updatedAt ?? 0 };
    publish();
    ctx.bus.emit("avatar.outfit", { items, by: "restore" }, SRC);
  }

  function onModel(id: string, wardrobe: string[]) {
    modelItems = wardrobe.filter((x) => !!WARDROBE_ITEMS[x]);
    ctx.log("wardrobe", `model ${id}: ${modelItems.length ? modelItems.join(", ") : "no wardrobe"}`);
  }

  return { service, restore, onModel, state: () => state };
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const ids = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : typeof x === "string" ? x.split(",").map((s) => s.trim()).filter(Boolean) : []);

export function wardrobeModule(opts: WardrobeOptions = {}): Module {
  const offs: (() => void)[] = [];
  return {
    name: "wardrobe",
    async start(ctx) {
      const w = createWardrobe(ctx, opts);
      ctx.provide("wardrobe", w.service);
      offs.push(ctx.bus.on("avatar.model", (e) => w.onModel(e.data.id, e.data.wardrobe ?? [])));
      await w.restore();

      // GET: state + catalog. POST {add?, remove?: [] | "all", set?: []}: the tray and scripts.
      ctx.route("/api/wardrobe", async (req) => {
        if (req.method === "GET") {
          const avail = w.service.available();
          return json({
            ok: true,
            ...w.service.get(),
            wearing: describeOutfit(w.service.get().items),
            items: w.service.get().items,
            catalog: avail.map((id) => ({ id, label: WARDROBE_ITEMS[id]!.label, slot: WARDROBE_ITEMS[id]!.slot, on: w.service.get().items.includes(id) })),
          });
        }
        if (req.method !== "POST") return null;
        const b = await body(req);
        const remove = b.remove === "all" || b.set !== undefined ? "all" : ids(b.remove);
        const add = b.set !== undefined ? ids(b.set) : ids(b.add);
        const r = await w.service.wear({ add, remove }, "user");
        return json({ ok: true, ...r });
      });
    },
    stop() {
      for (const off of offs.splice(0)) off();
    },
  };
}
