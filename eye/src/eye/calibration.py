"""Calibration: the on-screen script, labeling recorded frames, fitting, validation.

This module is UI free. The script is a pure function of script time, so the
UI (drawing the target) and the fitter (labeling frames) always agree on where
the target was.

The script is shaped by what the research says breaks webcam gaze:

* Fixation grid with 5% margins. Under-covered corners were 19 degrees off in
  one study, and the extremes are where the cursor needs to reach.
* A slow moving target (~6 deg/s) for dense coverage between grid points.
  Faster sweeps outrun smooth pursuit.
* Head motion while fixating. A landmark model calibrated with a still head
  measured 3.8 degrees still but 31 degrees once the head moved; the fix is
  calibration data where the head moves.
* Held closures and winks, so blink thresholds are personal, and expressions
  for drag and scroll.
* Fresh validation targets, so the reported accuracy isn't a training score.
"""

from __future__ import annotations

import json
import math
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

from . import paths
from .features import EYE_TERMS, GAZE_SCALE_FLOOR, Features, gaze_vector
from .gaze_model import GazeModel
from .profile import FaceProfile

FIXATE, PURSUIT, HEAD, EXPRESS, VALIDATE = "fixate", "pursuit", "head", "express", "validate"
GAZE_KINDS = (FIXATE, PURSUIT, HEAD, VALIDATE)


@dataclass(frozen=True)
class Step:
    kind: str
    duration: float
    x: float = 0.5  # target (normalized display coords) for point-like steps
    y: float = 0.5
    from_x: float = 0.5  # where the target glides in from
    from_y: float = 0.5
    glide_s: float = 0.0
    sample_from: float = 0.0  # sampling window, seconds into the step
    sample_to: float = 0.0
    what: str = ""  # express steps: both | left | right | brow | mouth
    text: str = ""


@dataclass
class Cue:
    index: int
    step: Step
    tau: float  # seconds into the step
    x: float
    y: float
    sampling: bool
    shrink: float  # 1 = full size target, towards 0 as the fixation completes


# Pursuit path: a rounded rectangle near the edges, walked at constant speed.
# Distances are measured in screen-height units with x scaled by ASPECT, so the
# pace stays even in real points rather than in normalized coordinates.
ASPECT = 1.54  # 13-14" MacBook; a different screen only shifts the pace slightly
_AX, _AY, _CR = 0.45 * ASPECT, 0.44, 0.10


def _border_path(u: float) -> tuple[float, float]:
    """u in [0, 1): how far around the path, at constant speed.

    Straight edges joined by quarter-circle corners, so the target never
    changes direction abruptly (that would trigger catch-up saccades).
    """
    ex, ey, arc = 2 * (_AX - _CR), 2 * (_AY - _CR), math.pi / 2 * _CR
    # (length, kind, data). Edges: (from_x, from_y, to_x, to_y). Corners: (cx, cy, start_angle).
    segments = (
        (ex, "e", (-(_AX - _CR), -_AY, _AX - _CR, -_AY)),  # top, left to right
        (arc, "c", (_AX - _CR, -(_AY - _CR), -math.pi / 2)),
        (ey, "e", (_AX, -(_AY - _CR), _AX, _AY - _CR)),  # right, down
        (arc, "c", (_AX - _CR, _AY - _CR, 0.0)),
        (ex, "e", (_AX - _CR, _AY, -(_AX - _CR), _AY)),  # bottom, right to left
        (arc, "c", (-(_AX - _CR), _AY - _CR, math.pi / 2)),
        (ey, "e", (-_AX, _AY - _CR, -_AX, -(_AY - _CR))),  # left, up
        (arc, "c", (-(_AX - _CR), -(_AY - _CR), math.pi)),
    )
    d = (u % 1.0) * sum(seg[0] for seg in segments)
    for length, kind, data in segments:
        if d <= length:
            f = d / length
            if kind == "e":
                x0, y0, x1, y1 = data
                x, y = x0 + (x1 - x0) * f, y0 + (y1 - y0) * f
            else:
                cx, cy, a0 = data
                a = a0 + f * math.pi / 2
                x, y = cx + _CR * math.cos(a), cy + _CR * math.sin(a)
            return 0.5 + x / ASPECT, 0.5 + y
        d -= length
    return 0.5, 0.5


@dataclass
class Script:
    steps: list[Step]

    @property
    def duration(self) -> float:
        return sum(s.duration for s in self.steps)

    def at(self, t: float) -> Cue | None:
        start = 0.0
        for i, step in enumerate(self.steps):
            if t < start + step.duration:
                return self._cue(i, step, t - start)
            start += step.duration
        return None

    def _cue(self, i: int, step: Step, tau: float) -> Cue:
        sampling = step.sample_from <= tau < step.sample_to
        if step.kind == PURSUIT:
            x, y = _border_path(tau / step.duration)
            return Cue(i, step, tau, x, y, sampling, 0.6)
        if step.glide_s > 0 and tau < step.glide_s:
            k = tau / step.glide_s
            k = k * k * (3 - 2 * k)  # smoothstep
            return Cue(
                i,
                step,
                tau,
                step.from_x + (step.x - step.from_x) * k,
                step.from_y + (step.y - step.from_y) * k,
                False,
                1.0,
            )
        dwell = max(step.duration - step.glide_s, 1e-6)
        shrink = 1.0 - 0.7 * min((tau - step.glide_s) / dwell, 1.0)
        return Cue(i, step, tau, step.x, step.y, sampling, shrink)

    def to_json(self) -> str:
        return json.dumps([asdict(s) for s in self.steps])

    @classmethod
    def from_json(cls, text: str) -> "Script":
        return cls([Step(**d) for d in json.loads(text)])


GRID = [(x, y) for y in (0.05, 0.5, 0.95) for x in (0.05, 0.5, 0.95)]
INNER = [(0.27, 0.27), (0.73, 0.27), (0.27, 0.73), (0.73, 0.73)]
HEAD_POINTS = [(0.25, 0.3), (0.75, 0.3), (0.75, 0.7), (0.25, 0.7)]
VALIDATION = [(0.5, 0.22), (0.2, 0.5), (0.8, 0.5), (0.5, 0.78), (0.5, 0.5)]

EXPRESSIONS = (
    ("both", "close BOTH eyes when the ring turns red, open at the beep", 1.5),
    ("left", "close only your LEFT eye when the ring turns red, open at the beep", 1.3),
    ("right", "close only your RIGHT eye when the ring turns red, open at the beep", 1.3),
    ("brow", "raise your EYEBROWS when the ring turns red, relax at the beep", 1.1),
    ("mouth", "open your MOUTH when the ring turns red, close at the beep", 1.1),
)
READY_S = 2.6  # time to read the instruction before the ring turns red


def build_script(quick: bool = False, expressions: bool = True) -> Script:
    steps: list[Step] = []
    prev = (0.5, 0.5)

    def fixate(p, kind=FIXATE, glide=0.45, dwell=1.35, settle=0.5):
        nonlocal prev
        steps.append(
            Step(
                kind,
                glide + dwell,
                x=p[0],
                y=p[1],
                from_x=prev[0],
                from_y=prev[1],
                glide_s=glide,
                sample_from=glide + settle,
                sample_to=glide + dwell,
            )
        )
        prev = p

    # Snake through the 3x3 grid so each glide is short, then the inner ring.
    rows = [GRID[0:3], GRID[3:6][::-1], GRID[6:9]]
    for p in [p for row in rows for p in row] + ([] if quick else INNER):
        fixate(p)
    if not quick:
        steps.append(Step(PURSUIT, 15.0, sample_from=1.0, sample_to=15.0, text="follow the dot"))
        prev = _border_path(1.0)
        for p in HEAD_POINTS:
            steps.append(
                Step(
                    HEAD,
                    4.5,
                    x=p[0],
                    y=p[1],
                    from_x=prev[0],
                    from_y=prev[1],
                    glide_s=0.45,
                    sample_from=1.4,
                    sample_to=4.5,
                    text="keep your eyes on the dot, slowly move your head around",
                )
            )
            prev = p
    if expressions:
        for what, text, hold in EXPRESSIONS:
            steps.append(
                Step(
                    EXPRESS,
                    READY_S + hold + 0.4,
                    sample_from=READY_S + 0.3,
                    sample_to=READY_S + hold,
                    what=what,
                    text=text,
                )
            )
    prev = (0.5, 0.5)
    for p in VALIDATION:
        fixate(p, kind=VALIDATE)
    return Script(steps)


@dataclass
class Recording:
    """Everything captured during a calibration run."""

    t: list[float] = field(default_factory=list)  # frame capture times (monotonic)
    features: list[Features | None] = field(default_factory=list)
    lm: list[np.ndarray | None] = field(default_factory=list)
    blend: list[np.ndarray | None] = field(default_factory=list)
    matrix: list[np.ndarray | None] = field(default_factory=list)
    clock: list[tuple[float, float]] = field(default_factory=list)  # (monotonic, script time)

    def add(self, t: float, features: Features | None, obs) -> None:
        self.t.append(t)
        self.features.append(features)
        self.lm.append(None if obs is None else obs.lm)
        self.blend.append(None if obs is None else obs.blend)
        self.matrix.append(None if obs is None else obs.matrix)

    def script_times(self, latency: float = 0.0) -> np.ndarray:
        clock = np.array(self.clock) if self.clock else np.zeros((1, 2))
        return np.interp(np.array(self.t) - latency, clock[:, 0], clock[:, 1], left=-1.0, right=1e9)


@dataclass
class Result:
    model: GazeModel
    profile: FaceProfile
    stats: dict
    validation: list[dict]  # per target: x, y, px, py (normalized), n
    train: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None  # (x, y, weights) fit on


@dataclass
class Calibration:
    model: GazeModel
    profile: FaceProfile
    meta: dict
    train: tuple[np.ndarray, np.ndarray, np.ndarray] | None


def _label(rec: Recording, script: Script, latency: float, sampling_only: bool = True):
    times = rec.script_times(latency)
    rows = []
    for i, (st, f) in enumerate(zip(times, rec.features)):
        if f is None:
            continue
        cue = script.at(st)
        if cue is None or (sampling_only and not cue.sampling):
            continue
        rows.append((i, cue))
    return rows


def _lstsq_line(y: np.ndarray, values: np.ndarray) -> tuple[float, float]:
    a = np.vstack([np.ones_like(y), y]).T
    (b, m), *_ = np.linalg.lstsq(a, values, rcond=None)
    return float(b), float(m)


def fit_profile(rec: Recording, script: Script, close_on: float = 0.55) -> tuple[FaceProfile, dict]:
    """Learn per-eye baselines, pick the closure signal mix, and check winks."""
    prof = FaceProfile(calibrated=True)
    notes: dict = {}
    rows = _label(rec, script, 0.0)
    open_raw, open_y = [], []
    closed: dict[str, list] = {k: [] for k, _, _ in EXPRESSIONS}
    for i, cue in rows:
        f = rec.features[i]
        raw = (f.left.ear, f.right.ear, f.bs_blink[0], f.bs_blink[1], f.brow, f.jaw)
        if cue.step.kind in (FIXATE, VALIDATE):
            open_raw.append(raw)
            open_y.append(cue.y)
        elif cue.step.kind == EXPRESS:
            closed[cue.step.what].append(raw)
    if not open_raw:
        raise RuntimeError("no open-eye samples; was your face visible?")
    open_arr = np.array(open_raw)
    ys = np.array(open_y) - 0.5

    # Which blendshape follows which eye? MediaPipe names them from the
    # subject's point of view, but only for a non-mirrored frame, so confirm.
    if closed["left"] and closed["right"]:
        wl, wr = np.median(closed["left"], axis=0), np.median(closed["right"], axis=0)
        prof.swap = bool(((wl[2] - wl[3]) + (wr[3] - wr[2])) < 0)
        notes["blendshape_wink_gap"] = [float(wl[2] - wl[3]), float(wr[3] - wr[2])]

    def bs_pair(arr):
        cols = arr[:, [2, 3]]
        return cols[:, ::-1] if prof.swap else cols

    prof.ear_open_l, prof.ear_slope_l = _lstsq_line(ys, open_arr[:, 0])
    prof.ear_open_r, prof.ear_slope_r = _lstsq_line(ys, open_arr[:, 1])
    bs_open = bs_pair(open_arr)
    prof.bs_open_l, prof.bs_slope_l = _lstsq_line(ys, bs_open[:, 0])
    prof.bs_open_r, prof.bs_slope_r = _lstsq_line(ys, bs_open[:, 1])
    if closed["both"]:
        both = np.array(closed["both"])
        prof.ear_closed_l, prof.ear_closed_r = float(np.median(both[:, 0])), float(np.median(both[:, 1]))
        bs_closed = np.median(bs_pair(both), axis=0)
        prof.bs_closed_l, prof.bs_closed_r = float(bs_closed[0]), float(bs_closed[1])
    for key, neutral, peak, lo, hi in (
        ("brow", "brow_neutral", "brow_raised", 4, 0.15),
        ("mouth", "jaw_neutral", "jaw_open", 5, 0.15),
    ):
        base = float(np.median(open_arr[:, lo]))
        if closed[key]:
            top = float(np.median(np.array(closed[key])[:, lo]))
            if top - base >= hi:
                setattr(prof, neutral, base)
                setattr(prof, peak, top)
            notes[f"{key}_span"] = round(top - base, 3)

    # Pick the closure signal: EAR, blendshapes, or the average of both.
    def normalized(arr, y_offsets, mix):
        el = _line(arr[:, 0], prof.ear_open_l, prof.ear_slope_l, y_offsets, prof.ear_closed_l)
        er = _line(arr[:, 1], prof.ear_open_r, prof.ear_slope_r, y_offsets, prof.ear_closed_r)
        bs = bs_pair(arr)
        bl = _line(bs[:, 0], prof.bs_open_l, prof.bs_slope_l, y_offsets, prof.bs_closed_l)
        br = _line(bs[:, 1], prof.bs_open_r, prof.bs_slope_r, y_offsets, prof.bs_closed_r)
        return (1 - mix) * el + mix * bl, (1 - mix) * er + mix * br

    scores = {}
    for mix in (0.0, 0.5, 1.0):
        ol, or_ = normalized(open_arr, ys, mix)
        open_sig = np.minimum(ol, or_)
        d_prime, contrast = 0.0, {}
        if closed["both"]:
            cl, cr = normalized(np.array(closed["both"]), np.zeros(len(closed["both"])), mix)
            shut = np.minimum(cl, cr)
            spread = math.sqrt((open_sig.var() + shut.var()) / 2) or 1e-6
            d_prime = float((shut.mean() - open_sig.mean()) / spread)
        for eye, sign in (("left", 1), ("right", -1)):
            if not closed[eye]:
                continue
            wl, wr = normalized(np.array(closed[eye]), np.zeros(len(closed[eye])), mix)
            gap = (wl - wr) if sign > 0 else (wr - wl)
            shut = wl if sign > 0 else wr
            contrast[eye] = (float(np.median(gap)), float(np.median(shut)))
        worst_gap = min((v[0] for v in contrast.values()), default=0.0)
        scores[mix] = (min(d_prime, 8.0) + 4.0 * worst_gap, d_prime, contrast)
    prof.mix = max(scores, key=lambda m: scores[m][0])
    _, d_prime, contrast = scores[prof.mix]
    notes["signal"] = {"mix": prof.mix, "blink_dprime": round(d_prime, 2)}
    for eye, (gap, shut) in contrast.items():
        ok = gap >= 0.35 and shut >= 0.6
        setattr(prof, "wink_l" if eye == "left" else "wink_r", bool(ok))
        notes[f"wink_{eye}"] = {"gap": round(gap, 2), "closed": round(shut, 2), "ok": bool(ok)}

    # Personalize the long-blink threshold from the blinks you made while
    # following the dots: sit just above your longest spontaneous one.
    durations = []
    run_start = None
    last_t = None
    for i, cue in _label(rec, script, 0.0, sampling_only=False):
        f = rec.features[i]
        if cue.step.kind not in GAZE_KINDS:
            run_start = None
            continue
        cl, cr = prof.closure(f, cue.y)
        shut = min(cl, cr) > close_on
        if shut and run_start is None:
            run_start = f.t
        elif not shut and run_start is not None:
            durations.append(last_t - run_start)
            run_start = None
        last_t = f.t
    if durations:
        prof.click_s = float(min(max(max(durations) + 0.05, 0.25), 0.5))
    notes["blinks"] = {"count": len(durations), "longest": round(max(durations), 3) if durations else None}
    notes["click_s"] = prof.click_s
    return prof, notes


def _line(values, base, slope, y_offsets, closed):
    span = closed - (base + slope * y_offsets)
    span = np.where(np.abs(span) < 1e-6, 1e-6, span)
    return np.clip((values - (base + slope * y_offsets)) / span, 0.0, 1.5)


def _training_set(rec: Recording, script: Script, rows, profile: FaceProfile):
    xs, ys, groups, weights, kinds, times = [], [], [], [], [], []
    for i, cue in rows:
        kind = cue.step.kind
        if kind not in GAZE_KINDS:
            continue
        f = rec.features[i]
        cl, cr = profile.closure(f, cue.y)
        if max(cl, cr) > 0.35:  # blinking or squinting: iris landmarks are unreliable
            continue
        xs.append(gaze_vector(f))
        ys.append((cue.x, cue.y))
        times.append(f.t)
        if kind == PURSUIT:
            groups.append(cue.index * 1000 + int(cue.tau))
            weights.append(0.5)
        elif kind == HEAD:
            groups.append(cue.index * 1000 + int(cue.tau / 1.5))
            weights.append(1.0)
        else:
            groups.append(cue.index * 1000)
            weights.append(1.0)
        kinds.append(kind)
    return (
        np.array(xs),
        np.array(ys),
        np.array(groups),
        np.array(weights),
        np.array(kinds),
        np.array(times),
    )


def _reject_outliers(x, groups, kinds):
    """Drop fixation samples far from their group's median (glances away, landmark glitches)."""
    keep = np.ones(len(x), dtype=bool)
    for g in np.unique(groups):
        m = (groups == g) & np.isin(kinds, (FIXATE, VALIDATE))
        if m.sum() < 5:
            continue
        sub = x[m, 0:4]
        med = np.median(sub, axis=0)
        mad = np.median(np.abs(sub - med), axis=0) + 1e-4
        bad = (np.abs(sub - med) / mad > 4.0).any(axis=1)
        keep[np.flatnonzero(m)[bad]] = False
    return keep


def _prepare(rec, script, profile, latency):
    rows = _label(rec, script, latency)
    x, y, groups, weights, kinds, times = _training_set(rec, script, rows, profile)
    if len(x) < 30:
        raise RuntimeError(f"only {len(x)} usable samples; was your face visible to the camera?")
    keep = _reject_outliers(x, groups, kinds)
    return x[keep], y[keep], groups[keep], weights[keep], kinds[keep], int((~keep).sum())


def fit(rec: Recording, script: Script, display, latency: float = 0.05, distance_cm: float = 55.0) -> Result:
    profile, notes = fit_profile(rec, script)
    x, y, groups, weights, kinds, rejected = _prepare(rec, script, profile, latency)
    stats: dict = {"rejected": rejected, "profile": notes}

    # Pursuit samples lag the moving target (camera latency plus smooth pursuit
    # lag). Estimate the lag with a fixation-only model, then re-label with it.
    fixed = kinds == FIXATE
    if (kinds == PURSUIT).any() and fixed.sum() > 30:
        base = GazeModel(quad=EYE_TERMS, scale_floor=GAZE_SCALE_FLOOR)
        base.fit(x[fixed], y[fixed], groups[fixed])
        best = (math.inf, latency)
        for extra in np.arange(0.0, 0.31, 0.03):
            rows = [r for r in _label(rec, script, latency + extra) if r[1].step.kind == PURSUIT]
            lx, ly, *_ = _training_set(rec, script, rows, profile)
            if len(lx) > 20:
                err = float(np.median(np.linalg.norm(base.predict(lx) - ly, axis=1)))
                best = min(best, (err, latency + extra))
        latency = best[1]
        stats["pursuit_lag"] = round(latency, 3)
        x, y, groups, weights, kinds, rejected = _prepare(rec, script, profile, latency)
        stats["rejected"] = rejected

    train = kinds != VALIDATE
    stats["samples"] = int(train.sum())
    model = GazeModel(quad=EYE_TERMS, scale_floor=GAZE_SCALE_FLOOR)
    stats.update(model.fit(x[train], y[train], groups[train], weights[train]))

    validation = []
    val = ~train
    for g in np.unique(groups[val]):
        m = val & (groups == g)
        pred = np.median(model.predict(x[m]), axis=0)
        validation.append(
            {
                "x": float(y[m][0, 0]),
                "y": float(y[m][0, 1]),
                "px": float(pred[0]),
                "py": float(pred[1]),
                "n": int(m.sum()),
            }
        )
    if validation:
        errs = [math.hypot((v["px"] - v["x"]) * display.w, (v["py"] - v["y"]) * display.h) for v in validation]
        stats["validation_points"] = float(np.mean(errs))
        stats["validation_worst"] = float(np.max(errs))
        stats["validation_deg"] = display.degrees(float(np.mean(errs)), distance_cm)
    stats["head_range_deg"] = [float(np.ptp(x[:, 6])), float(np.ptp(x[:, 7]))]
    return Result(model, profile, stats, validation, (x[train], y[train], weights[train]))


def save(result: Result, display, camera_name: str, path: Path | None = None) -> Path:
    path = path or paths.calibration_file()
    meta = {
        "created": time.strftime("%Y-%m-%d %H:%M:%S"),
        "display": {"name": display.name, "w": display.w, "h": display.h},
        "camera": camera_name,
        "stats": result.stats,
    }
    train = {}
    if result.train is not None:
        train = {"train_x": result.train[0], "train_y": result.train[1], "train_w": result.train[2]}
    np.savez(
        path,
        meta=np.array(json.dumps(meta, default=float)),
        **result.model.to_arrays(),
        **result.profile.to_arrays(),
        **train,
    )
    return path


def load(path: Path | None = None) -> Calibration | None:
    path = path or paths.calibration_file()
    if not path.exists():
        return None
    d = np.load(path, allow_pickle=False)
    train = (d["train_x"], d["train_y"], d["train_w"]) if "train_x" in d else None
    return Calibration(GazeModel.from_arrays(d), FaceProfile.from_arrays(d), json.loads(str(d["meta"])), train)


def save_session(rec: Recording, script: Script, display, camera_name: str, blend_names: list[str]) -> Path:
    """Raw landmarks for every frame, so the model can be refit offline later."""
    path = paths.sessions_dir() / time.strftime("calib-%Y%m%d-%H%M%S.npz")
    n = len(rec.t)
    lm = np.full((n, 478, 3), np.nan, dtype=np.float32)
    blend = np.full((n, 52), np.nan, dtype=np.float32)
    matrix = np.full((n, 4, 4), np.nan, dtype=np.float32)
    for i in range(n):
        if rec.lm[i] is not None:
            lm[i], blend[i], matrix[i] = rec.lm[i], rec.blend[i], rec.matrix[i]
    np.savez_compressed(
        path,
        t=np.array(rec.t),
        lm=lm,
        blend=blend,
        matrix=matrix,
        clock=np.array(rec.clock),
        script=np.array(script.to_json()),
        display=np.array(json.dumps({"name": display.name, "w": display.w, "h": display.h, "mm": display.mm})),
        camera=np.array(camera_name),
        blend_names=np.array(json.dumps(blend_names)),
    )
    return path


def load_session(path: Path):
    """Rebuild a Recording (features recomputed from raw landmarks) from a saved session."""
    from .face import FaceObs
    from .features import BlendIdx, extract

    d = np.load(path, allow_pickle=False)
    idx = BlendIdx.from_names(json.loads(str(d["blend_names"])))
    rec = Recording(clock=[tuple(c) for c in d["clock"]])
    for t, lm, blend, matrix in zip(d["t"], d["lm"], d["blend"], d["matrix"]):
        if np.isnan(lm[0, 0]):
            rec.add(float(t), None, None)
            continue
        obs = FaceObs(t=float(t), size=(0, 0), lm=lm, blend=blend, matrix=matrix)
        rec.add(float(t), extract(obs, idx), obs)
    return rec, Script.from_json(str(d["script"])), json.loads(str(d["display"])), str(d["camera"])
