import { describeOutfit, WARDROBE_ITEMS } from "@eigenwife/protocol";
import type { ActionDef } from "../types";

const list = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : typeof x === "string" && x ? [x] : []);
const label = (ids: string[]) => ids.map((id) => WARDROBE_ITEMS[id]?.label ?? id).join(", ");

/**
 * avatar.wear { add?: string[], remove?: string[] | "all" }: change what Eve has
 * on. SAFE_ACTION (her own appearance, nothing leaves the machine), so no
 * approval. Spoken requests and the tray go straight to the wardrobe service;
 * this is for planners, scripts and anything speaking action.request.
 */
export const avatarWear: ActionDef = {
  kind: "avatar.wear",
  permission: "SAFE_ACTION",
  describe: (a) => {
    const add = list(a.add);
    const rm = a.remove === "all" ? "everything" : label(list(a.remove));
    return [add.length ? `put on ${label(add)}` : "", rm ? `take off ${rm}` : ""].filter(Boolean).join(", ") || "change outfit";
  },
  async run(args, env) {
    const w = env.ctx.tryUse("wardrobe");
    if (!w) return { ok: false, observation: "no wardrobe module running" };
    const r = await w.wear({ add: list(args.add), remove: args.remove === "all" ? "all" : list(args.remove) }, "agent");
    const miss = r.unavailable.length ? ` (can't wear ${r.unavailable.join(", ")} on this model)` : "";
    return { ok: r.unavailable.length === 0 || r.changed, observation: `wearing: ${describeOutfit(r.items)}${miss}`, data: r };
  },
};
