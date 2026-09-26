import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Mood } from "@eigenwife/protocol";
import { applyPoses, BLEND_MS } from "./emotion";
import { buildPoses, DEFAULT_MODEL, expressionToPose, HARU, MODELS, resolveModel, type Exp3 } from "./models";
import { EveRig } from "./rig";

const MOODS: Mood[] = ["neutral", "happy", "annoyed", "thinking", "surprised", "smug", "sad"];
const PUBLIC = join(import.meta.dir, "../../public");
const readJson = (p: string) => JSON.parse(readFileSync(join(PUBLIC, p), "utf8"));

function rng(seed = 7) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("model registry", () => {
  test("default is Haru", () => {
    expect(DEFAULT_MODEL).toBe("haru");
    expect(resolveModel("", undefined).id).toBe("haru");
  });

  test("?model= beats EVE_MODEL, unknown ids fall back", () => {
    const other = { ...HARU, id: "other" };
    MODELS.other = other;
    try {
      expect(resolveModel("?model=other", "haru").id).toBe("other");
      expect(resolveModel("", "other").id).toBe("other");
      expect(resolveModel("?model=nope", "other").id).toBe("other");
      expect(resolveModel("?model=nope", "also-nope").id).toBe("haru");
      expect(resolveModel("?model=HARU", "").id).toBe("haru");
    } finally {
      delete MODELS.other;
    }
  });

  test("a model3.json path makes an ad-hoc model with standard ids", () => {
    const m = resolveModel("?model=/avatar/_eval/Ren/Ren.model3.json");
    expect(m.url).toBe("/avatar/_eval/Ren/Ren.model3.json");
    expect(m.name).toBe("Ren");
    expect(m.expressions).toEqual({});
    // Only local paths or http(s), never javascript: or relative junk.
    expect(resolveModel("?model=javascript:x.model3.json").id).toBe("haru");
  });

  test("every mood has a pose and every framing slot exists", () => {
    for (const def of Object.values(MODELS)) {
      for (const m of MOODS) expect(def.poses[m]).toBeDefined();
      for (const s of ["column", "stage", "overlay"] as const) {
        const f = def.framing[s];
        expect(f.scale).toBeGreaterThan(0);
        expect(f.head.y).toBeGreaterThan(0);
        expect(f.head.y).toBeLessThan(0.5);
      }
    }
  });
});

describe("haru assets match the registry", () => {
  const settings = readJson("avatar/haru/Haru.model3.json");
  const ids = new Set<string>(readJson("avatar/haru/Haru.cdi3.json").Parameters.map((p: any) => p.Id));

  test("model url points at the shipped model", () => {
    expect(HARU.url).toBe("/avatar/haru/Haru.model3.json");
  });

  test("rig param ids, face rest ids and pose ids all exist on the model", () => {
    for (const id of Object.values(HARU.params)) expect(ids.has(id)).toBe(true);
    for (const id of Object.keys(HARU.faceRest)) expect(ids.has(id)).toBe(true);
    for (const m of MOODS) for (const id of Object.keys(HARU.poses[m])) expect(ids.has(id)).toBe(true);
  });

  test("mapped expressions ship with the model", () => {
    const names = new Set(settings.FileReferences.Expressions.map((e: any) => e.Name));
    for (const name of Object.values(HARU.expressions)) expect(names.has(name)).toBe(true);
  });

  test("only the calm idle loop ships: no gesture motions, no sounds", () => {
    const groups = settings.FileReferences.Motions;
    expect(Object.keys(groups)).toEqual([HARU.idleMotionGroup]);
    expect(groups.Idle.length).toBe(1);
    expect(JSON.stringify(groups)).not.toContain("Sound");
  });
});

describe("expression mapping", () => {
  const exp: Exp3 = {
    Parameters: [
      { Id: "ParamEyeLOpen", Value: 0, Blend: "Multiply" },
      { Id: "ParamEyeLSmile", Value: 1, Blend: "Add" },
      { Id: "ParamTere", Value: 0.5, Blend: "Overwrite" },
      { Id: "ParamMouthForm", Value: 0.3 },
    ],
  };

  test("blend modes map to mul / add / abs, missing blend = Add", () => {
    expect(expressionToPose(exp)).toEqual({
      ParamEyeLOpen: { v: 0, op: "mul" },
      ParamEyeLSmile: { v: 1, op: "add" },
      ParamTere: { v: 0.5 },
      ParamMouthForm: { v: 0.3, op: "add" },
    });
  });

  test("our overrides win per param, the rest of the expression stays", () => {
    const t = buildPoses({ expressions: { happy: "F05" }, poses: { ...HARU.poses, happy: { ParamEyeLOpen: { v: 0.25 } } } }, { F05: exp });
    expect(t.happy.ParamEyeLOpen).toEqual({ v: 0.25 });
    expect(t.happy.ParamEyeLSmile).toEqual({ v: 1, op: "add" });
    expect(t.annoyed).toEqual(HARU.poses.annoyed);
  });

  test("a missing expression file leaves the overrides alone", () => {
    expect(buildPoses(HARU, {}).happy).toEqual(HARU.poses.happy);
  });

  test("real Haru expressions: happy closes into a smile, surprised widens", () => {
    const exps: Record<string, Exp3> = {};
    for (const e of readJson("avatar/haru/Haru.model3.json").FileReferences.Expressions) exps[e.Name] = readJson(`avatar/haru/${e.File}`);
    const t = buildPoses(HARU, exps);
    const run = (m: Mood) => {
      const p = new Map<string, number>(Object.entries(HARU.faceRest));
      applyPoses(t, { [m]: 0.78 }, (id) => p.get(id) ?? 0, (id, v) => void p.set(id, v));
      return p;
    };
    const happy = run("happy");
    expect(happy.get("ParamEyeLSmile")!).toBeGreaterThan(0.5);
    expect(happy.get("ParamMouthForm")!).toBeGreaterThan(0.5);
    expect(run("surprised").get("ParamEyeLOpen")!).toBeGreaterThan(1);
    expect(run("annoyed").get("ParamMouthForm")!).toBeLessThan(-0.5);
    expect(run("sad").get("ParamMouthForm")!).toBeLessThan(-0.5);
  });
});

describe("no mood change without an event", () => {
  const input = { state: "idle" as const, focus: { x: 0, y: 0 }, mouth: 0, mouthHold: false };
  const FACE_ONLY = Object.keys(HARU.faceRest).filter((id) => !/EyeBall|EyeLOpen|EyeROpen|MouthOpenY/.test(id));

  function sim(rig: EveRig, from: number, to: number, params: Map<string, number>, rand: () => number) {
    const io = { get: (id: string) => params.get(id) ?? 0, set: (id: string, v: number) => void params.set(id, v) };
    const seen: Mood[] = [];
    for (let t = from; t < to; t += 16) {
      // The idle motion scribbles over the face every frame (like Haru's loop does).
      for (const id of Object.keys(HARU.faceRest)) params.set(id, rand() * 2 - 1);
      rig.frame(io, input, 16, t);
      const d = rig.emotion.dominant(t);
      if (seen[seen.length - 1] !== d) seen.push(d);
    }
    return seen;
  }

  test("a minute of idle: always neutral, expression params pinned at rest", () => {
    const rig = new EveRig(rng(5), 0);
    rig.setModel(HARU);
    const params = new Map<string, number>();
    expect(sim(rig, 0, 60_000, params, rng(9))).toEqual(["neutral"]);
    expect(rig.emotion.weights(60_000)).toEqual({});
    for (const id of FACE_ONLY) expect(params.get(id)).toBe(HARU.faceRest[id]);
  });

  test("an event changes the face, then it auto-returns to neutral", () => {
    const rig = new EveRig(rng(5), 0);
    rig.setModel(HARU);
    const params = new Map<string, number>();
    rig.setMood("happy", 1, 1000, 2000);
    const seen = sim(rig, 1000, 1000 + 2000 + BLEND_MS + 500, params, rng(3));
    expect(seen).toEqual(["happy", "neutral"]);
    for (const id of FACE_ONLY) expect(params.get(id)).toBe(HARU.faceRest[id]);
  });
});

describe("local-only models", () => {
  test("alexia is the default only when her files are on this machine", () => {
    expect(resolveModel("", "", ["alexia"]).id).toBe("alexia");
    expect(resolveModel("", "", []).id).toBe("haru");
    expect(resolveModel("?model=alexia", "", []).id).toBe("haru");
    expect(resolveModel("?model=haru", "", ["alexia"]).id).toBe("haru");
    expect(resolveModel("", "alexia", ["alexia"]).id).toBe("alexia");
  });

  test("alexia maps every mood to her own expressions", () => {
    const a = MODELS.alexia!;
    expect(a.expressions).toMatchObject({ happy: "lzx", annoyed: "sq", thinking: "wh", surprised: "xxy", smug: "dyj", sad: "k" });
    expect(Object.keys(a.poses).sort()).toEqual(["annoyed", "happy", "neutral", "sad", "smug", "surprised", "thinking"]);
  });
});
