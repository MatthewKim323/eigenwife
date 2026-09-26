import type { RigInput } from "./rig";
import { avatarRuntime } from "./store";

export const MODEL_URL = "/avatar/hiyori/Hiyori.model3.json";
export const CORE_URL = "/avatar/live2dcubismcore.min.js";

/** Where her head sits inside the canvas box (fractions), for look-at mapping. */
export const HEAD_IN_BOX = { x: 0.5, y: 0.2 };

export interface EveLive2D {
  destroy(): void;
  /** Pause rendering while she's hidden. */
  setActive(on: boolean): void;
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

/**
 * Boot Hiyori into a transparent canvas and take over her face. The SDK's
 * expression manager, eye blink, breath and focus are all disabled; our rig
 * writes every parameter each frame (see rig.ts for the order).
 */
export async function loadEve(
  canvas: HTMLCanvasElement,
  box: { width: number; height: number },
  getInput: () => RigInput,
  onError: (err: unknown) => void,
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

  const model: any = await Live2DModel.from(MODEL_URL, { autoUpdate: false, autoInteract: false, idleMotionGroup: "Idle" } as any);
  const im = model.internalModel;
  const core = im.coreModel;

  // Built-ins off: nothing fights the rig.
  im.eyeBlink = undefined;
  if (im.motionManager) im.motionManager.expressionManager = undefined;
  delete im.breath;
  im.updateNaturalMovements = () => {};

  const rig = avatarRuntime.rig;
  const io = {
    get: (id: string) => core.getParameterValueById(id) as number,
    set: (id: string, v: number) => core.setParameterValueById(id, v),
  };
  let frameDt = 16;
  let frameNow = performance.now();
  // updateFocus runs after motion and before physics, so hair and ribbons
  // react to our head turns in the same frame.
  im.updateFocus = () => rig.frame(io, getInput(), frameDt, frameNow);

  // Framing: head near the top of the box, upper body visible.
  model.anchor.set(0.5, 0);
  const fit = () => {
    const s = (box.height * 2.05) / model.internalModel.originalHeight;
    model.scale.set(s);
    model.x = box.width / 2;
    model.y = box.height * 0.035;
  };
  fit();
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
  app.ticker.add(() => {
    if (broken) return;
    frameDt = Math.min(100, app.ticker.deltaMS);
    frameNow = performance.now();
    try {
      model.update(frameDt);
    } catch (err) {
      broken = true;
      app.ticker.stop();
      onError(err);
    }
  }, undefined, PIXI.UPDATE_PRIORITY.HIGH);
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
  };
}
