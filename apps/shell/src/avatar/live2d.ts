import { buildPoses, type Exp3, type Framing, type FramingSlot, type ModelDef } from "./models";
import type { RigInput } from "./rig";
import { activeModel, avatarRuntime } from "./store";

export const CORE_URL = "/avatar/live2dcubismcore.min.js";

export interface EveLive2D {
  destroy(): void;
  /** Pause rendering while she's hidden. */
  setActive(on: boolean): void;
  /** Reframe her inside the box (column / stage / overlay). Eased, never a jump. */
  setFraming(slot: FramingSlot, instant?: boolean): void;
}

let coreLoading: Promise<void> | null = null;

/** The Cubism core must be a global script, loaded BEFORE pixi-live2d-display is imported. */
function loadCore(): Promise<void> {
  if ((globalThis as any).Live2DCubismCore) return Promise.resolve();
  coreLoading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = CORE_URL;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      coreLoading = null;
      reject(new Error("cubism core failed to load"));
    };
    document.head.appendChild(s);
  });
  return coreLoading;
}

/** Fetch the exp3 files the def maps to moods. Missing ones just leave our overrides alone. */
async function loadExpressions(def: ModelDef): Promise<Record<string, Exp3>> {
  const wanted = new Set(Object.values(def.expressions));
  if (!wanted.size) return {};
  const out: Record<string, Exp3> = {};
  try {
    const settings = await (await fetch(def.url)).json();
    const list: { Name: string; File: string }[] = settings?.FileReferences?.Expressions ?? [];
    await Promise.all(
      list
        .filter((e) => wanted.has(e.Name))
        .map(async (e) => {
          const r = await fetch(new URL(e.File, new URL(def.url, location.href)).href);
          if (r.ok) out[e.Name] = await r.json();
        }),
    );
  } catch (err) {
    console.warn("[avatar] expressions unavailable, using overrides only:", err);
  }
  return out;
}

/**
 * Where her head sits inside the canvas box in the overlay window (fractions),
 * for look-at mapping. From the active model's overlay framing.
 */
export const HEAD_IN_BOX = activeModel.framing.overlay.head;

/**
 * The overlay's entry point: the active model (?model= / EVE_MODEL / Haru)
 * with the overlay framing from the registry.
 */
export function loadEve(
  canvas: HTMLCanvasElement,
  box: { width: number; height: number },
  getInput: () => RigInput,
  onError: (err: unknown) => void,
): Promise<EveLive2D> {
  return loadModel(activeModel, canvas, box, getInput, onError, "overlay");
}

/**
 * Boot the model into a transparent canvas and take over her face. The SDK's
 * expression manager, eye blink, breath and focus are all disabled; our rig
 * writes every parameter each frame (see rig.ts for the order).
 */
export async function loadModel(
  def: ModelDef,
  canvas: HTMLCanvasElement,
  box: { width: number; height: number },
  getInput: () => RigInput,
  onError: (err: unknown) => void,
  slot: FramingSlot = "column",
): Promise<EveLive2D> {
  await loadCore();
  const PIXI = await import("pixi.js");
  (globalThis as any).PIXI = PIXI;
  const { Live2DModel } = await import("pixi-live2d-display/cubism4");
  Live2DModel.registerTicker(PIXI.Ticker);

  const app = new PIXI.Application({
    view: canvas,
    width: box.width,
    height: box.height,
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(2, globalThis.devicePixelRatio || 1),
    autoStart: false,
    powerPreference: "high-performance",
  });

  const [model, exps]: [any, Record<string, Exp3>] = await Promise.all([
    Live2DModel.from(def.url, { autoUpdate: false, autoInteract: false, idleMotionGroup: def.idleMotionGroup } as any),
    loadExpressions(def),
  ]);
  const im = model.internalModel;
  const core = im.coreModel;

  // Built-ins off: nothing fights the rig. Expressions are applied by the rig
  // as blended poses (buildPoses), never by the SDK on its own schedule.
  im.eyeBlink = undefined;
  if (im.motionManager) im.motionManager.expressionManager = undefined;
  delete im.breath;
  im.updateNaturalMovements = () => {};

  const rig = avatarRuntime.rig;
  rig.setModel(def, buildPoses(def, exps));
  const io = {
    get: (id: string) => core.getParameterValueById(id) as number,
    set: (id: string, v: number) => core.setParameterValueById(id, v),
  };
  let frameDt = 16;
  let frameNow = performance.now();
  // updateFocus runs after motion and before physics, so hair reacts to our
  // head turns in the same frame.
  im.updateFocus = () => rig.frame(io, getInput(), frameDt, frameNow);

  // Framing: eased toward the dock's target so a dock change never pops.
  model.anchor.set(0.5, 0);
  const cur: Framing = { ...def.framing[slot], head: { ...def.framing[slot].head } };
  let target: Framing = def.framing[slot];
  const place = () => {
    model.scale.set((box.height * cur.scale) / im.originalHeight);
    model.x = box.width * cur.x;
    model.y = box.height * cur.y;
  };
  place();
  app.stage.addChild(model);

  const render = app.render.bind(app);
  let broken = false;
  app.render = () => {
    if (broken) return;
    try {
      render();
    } catch (err) {
      broken = true;
      app.ticker.stop();
      onError(err);
    }
  };
  app.ticker.add(
    () => {
      if (broken) return;
      frameDt = Math.min(100, app.ticker.deltaMS);
      frameNow = performance.now();
      const k = 1 - Math.exp(-frameDt / 160);
      cur.scale += (target.scale - cur.scale) * k;
      cur.x += (target.x - cur.x) * k;
      cur.y += (target.y - cur.y) * k;
      place();
      try {
        model.update(frameDt);
      } catch (err) {
        broken = true;
        app.ticker.stop();
        onError(err);
      }
    },
    undefined,
    PIXI.UPDATE_PRIORITY.HIGH,
  );
  app.ticker.start();

  return {
    destroy() {
      app.ticker.stop();
      try {
        app.destroy(false, { children: true });
      } catch {}
    },
    setActive(on: boolean) {
      if (broken) return;
      if (on && !app.ticker.started) app.ticker.start();
      if (!on && app.ticker.started) app.ticker.stop();
    },
    setFraming(next: FramingSlot, instant = false) {
      target = def.framing[next];
      if (instant) {
        Object.assign(cur, { scale: target.scale, x: target.x, y: target.y });
        place();
      }
    },
  };
}
