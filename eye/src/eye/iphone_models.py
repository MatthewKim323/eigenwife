"""Small, target-grouped challengers to the original ARKit fused-ray mapper.

Selection scores are development estimates, never independent accuracy. Eye
rotation axes are optical/pupil directions, not calibrated visual axes.
"""
from __future__ import annotations
import numpy as np
from .gaze_model import GazeModel, DEFAULT_ALPHAS

FEATURE_SCHEMA = "iphone_camera_geometry_v1"
FEATURE_NAMES = tuple(
    [f"fused_direction_{a}" for a in "xyz"] + [f"eye_midpoint_{a}" for a in "xyz"] +
    [f"head_column_{c}_{a}" for c in (0, 1) for a in "xyz"] +
    [f"{eye}_direction_{a}" for eye in ("left", "right") for a in "xyz"] +
    [f"{eye}_origin_{a}" for eye in ("left", "right") for a in "xyz"])
ALPHAS = DEFAULT_ALPHAS


def design(x, name):
    x = np.atleast_2d(np.asarray(x, dtype=float))
    if name == "fused_linear":
        return x[:, :12]
    if name == "head_only":
        return x[:, 3:12]
    if name == "fused_projective":
        directions, origins = [x[:, :3]], [x[:, 3:6]]
    elif name == "binocular_projective":
        if x.shape[1] != 24:
            raise ValueError("binocular model requires geometry schema v1")
        directions, origins = [x[:, 12:15], x[:, 15:18]], [x[:, 18:21], x[:, 21:24]]
    else:
        raise ValueError("unknown iPhone model")
    cols = []
    for d, o in zip(directions, origins):
        if np.any(np.abs(d[:, 2]) < .15):
            raise ValueError("gaze ray is too parallel to camera plane")
        slopes = d[:, :2] / d[:, 2:3]
        # Intersection with an unknown plane parallel to camera image plane:
        # (ox - oz*sx) + plane_z*sx, similarly y. Personal ridge learns scale,
        # offset and small head correction; this does NOT recover screen pose.
        cols.extend([slopes, o[:, :2] - o[:, 2:3] * slopes])
    return np.hstack(cols + [x[:, 6:12]])


def _model(name):
    floor = {
        "fused_linear": np.r_[np.full(3, .02), np.full(3, .01), np.full(6, .02)],
        "head_only": np.r_[np.full(3, .01), np.full(6, .02)],
        "fused_projective": np.r_[np.full(2, .02), np.full(2, .01), np.full(6, .02)],
        "binocular_projective": np.r_[np.tile([.02, .02, .01, .01], 2), np.full(6, .02)],
    }[name]
    return GazeModel(degree=1, scale_floor=floor, clip=20)


class PostureSupport:
    """Training-only envelope, with 2-degree/25-mm tracking-noise margins.

    This bounds extrapolation; it is not an accuracy guarantee inside the box.
    Angular wrapping is centered on training pose to support landscape mounts.
    """
    margin = np.r_[np.full(3, .025), np.full(3, np.deg2rad(2.))]

    @staticmethod
    def coordinates(x):
        x = np.atleast_2d(np.asarray(x, dtype=float))
        a, b = x[:, 6:9], x[:, 9:12]
        c = np.cross(a, b)
        angles = np.column_stack((np.arctan2(b[:, 2], c[:, 2]),
                                  np.arctan2(-a[:, 2], np.hypot(a[:, 0], a[:, 1])),
                                  np.arctan2(a[:, 1], a[:, 0])))
        return np.column_stack((x[:, 3:6], angles))

    def __init__(self, x):
        z = self.coordinates(x)
        self.center = np.r_[np.zeros(3), np.arctan2(np.sin(z[:, 3:]).mean(0), np.cos(z[:, 3:]).mean(0))]
        z = self._relative(z)
        self.low, self.high = z.min(0), z.max(0)

    def _relative(self, z):
        z = z - self.center
        z[:, 3:] = (z[:, 3:] + np.pi) % (2*np.pi) - np.pi
        return z

    def contains(self, x):
        z = self._relative(self.coordinates(x))
        return np.all((z >= self.low-self.margin) & (z <= self.high+self.margin), axis=1)


class IPhoneModel:
    def __init__(self, name, model, diagnostics, support=None):
        self.name, self.model, self.diagnostics = name, model, diagnostics
        self.support = support

    def supports(self, x):
        return self.support.contains(x) if self.support is not None else np.ones(len(np.atleast_2d(x)), dtype=bool)

    def predict(self, x):
        try:
            pred = self.model.predict(design(x, self.name))
            pred[~self.supports(x)] = np.nan
            return pred
        except ValueError:
            return np.full((len(np.atleast_2d(x)), 2), np.nan)

    def to_arrays(self):
        support = {} if self.support is None else {"posture_support_center": self.support.center,
            "posture_support_low": self.support.low, "posture_support_high": self.support.high,
            "posture_support_margin": self.support.margin}
        return {**self.model.to_arrays(), **support, "iphone_model_name": np.array(self.name),
                "iphone_feature_schema": np.array(FEATURE_SCHEMA)}


def fit_iphone_model(x, y, groups, weights, error_scale):
    """Nested grouped CV: held-out target locations never tune ridge alpha.

    Three outer partitions keep repeated visits to a target together. Candidate
    selection is still development tuning; a later frozen validation is required.
    """
    x, y, groups = np.asarray(x), np.asarray(y), np.asarray(groups)
    unique = np.unique(groups)
    if len(unique) < 9:
        raise ValueError("need nine distinct targets for model comparison")
    weights = np.asarray(weights, dtype=float).copy()
    for g in unique:
        mask = groups == g
        weights[mask] /= weights[mask].sum()
    # Interleave locations to avoid partitioning entire screen edges together.
    folds = [np.isin(groups, unique[i::3]) for i in range(3)]
    diagnostics, fitted = [], {}
    for name in ("fused_linear", "fused_projective", "binocular_projective", "head_only"):
        try:
            z = design(x, name)
        except ValueError as exc:
            diagnostics.append({"name": name, "eligible": False, "reason": str(exc)})
            continue
        errors = np.empty(len(x))
        fold_scores = []
        for test in folds:
            m = _model(name)
            m.fit(z[~test], y[~test], groups=groups[~test], weights=weights[~test], alphas=ALPHAS, error_scale=error_scale)
            errors[test] = np.linalg.norm((m.predict(z[test]) - y[test]) * error_scale, axis=1)
            fold_scores.append(float(np.average(errors[test], weights=weights[test])))
        target_errors = [float(np.average(errors[groups == g], weights=weights[groups == g])) for g in unique]
        row = {"name": name, "eligible": name != "head_only", "cvMeanPoints": float(np.mean(target_errors)),
               "cvTargetP90Points": float(np.percentile(target_errors, 90)), "foldMeanPoints": fold_scores,
               "evaluation": "nested_target_grouped_development", "features": z.shape[1]}
        final = _model(name)
        stats = final.fit(z, y, groups=groups, weights=weights, alphas=ALPHAS, error_scale=error_scale)
        row.update(alpha=float(final.alpha), trainMeanPoints=float(stats["train_error"]))
        diagnostics.append(row)
        fitted[name] = final
    baseline = diagnostics[0]
    eligible = [r for r in diagnostics[1:] if r["eligible"] and
                r["cvMeanPoints"] < baseline["cvMeanPoints"] - max(3., .1 * baseline["cvMeanPoints"]) and
                r["cvTargetP90Points"] <= baseline["cvTargetP90Points"] * 1.05 and
                sum(a < b for a, b in zip(r["foldMeanPoints"], baseline["foldMeanPoints"])) >= 2]
    selected = min(eligible, key=lambda r: r["cvMeanPoints"]) if eligible else baseline
    result = IPhoneModel(selected["name"], fitted[selected["name"]], diagnostics, PostureSupport(x))
    return result, {"cv_error": selected["cvMeanPoints"], "train_error": selected["trainMeanPoints"],
                    "selectedModel": selected["name"], "modelCandidates": diagnostics,
                    "featureSchema": FEATURE_SCHEMA,
                    "selectionPolicy": "at least 10% and 3pt mean improvement; no target-tail regression above 5%; wins 2/3 folds"}
