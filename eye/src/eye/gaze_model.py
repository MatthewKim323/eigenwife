"""Ridge regression from gaze features to normalized screen position."""

from __future__ import annotations

import numpy as np

DEFAULT_ALPHAS = np.logspace(-3, 3, 13)


def _expand(z: np.ndarray, degree: int, quad: int | None) -> np.ndarray:
    cols = [z]
    if degree >= 2:
        zq = z[:, : (quad or z.shape[1])]
        i, j = np.triu_indices(zq.shape[1])
        cols.append(zq[:, i] * zq[:, j])
    return np.hstack(cols)


def _solve(p: np.ndarray, y: np.ndarray, w: np.ndarray, alpha: float):
    """Weighted ridge with an unpenalized intercept. Returns (coef, p_mean, y_mean)."""
    sw = w / w.sum()
    p_mean = sw @ p
    y_mean = sw @ y
    pc = p - p_mean
    yc = y - y_mean
    pw = pc * w[:, None]
    a = pc.T @ pw + alpha * np.eye(p.shape[1])
    coef = np.linalg.solve(a, pw.T @ yc)
    return coef, p_mean, y_mean


def _robust_solve(p, y, w, alpha, delta, error_scale):
    """Four bounded Huber IRLS passes; only training residuals set weights."""
    effective = w.copy()
    for _ in range(1 if delta is None else 4):
        coef, pm, ym = _solve(p, y, effective, alpha)
        if delta is not None:
            residual = np.linalg.norm(((p - pm) @ coef + ym - y) * error_scale, axis=1)
            effective = w * np.minimum(1.0, delta / np.maximum(residual, 1e-9))
    return coef, pm, ym


class GazeModel:
    """Standardize, add quadratic terms, ridge-regress onto (x, y) in 0..1.

    Only the first `quad` features (the eye block) get quadratic terms; the
    rest (head pose) stay linear. Head terms are what break when calibration
    didn't cover a pose, so they get the least capacity.

    alpha is picked by grouped cross validation: a group is one calibration
    target (or one chunk of the moving-target sweep), so the score reflects how
    well the model generalizes to places on screen it wasn't trained on.
    """

    def __init__(self, degree: int = 2, quad: int | None = None, scale_floor: np.ndarray | None = None, clip: float = 5.0, robust_deltas: tuple[float | None, ...] = (None,)):
        self.degree = degree
        self.quad = quad
        self.scale_floor = scale_floor
        self.clip = clip
        self.robust_deltas = robust_deltas
        self.robust_delta = None
        self.error_scale = None
        self.alpha: float | None = None
        self.x_mean = self.x_scale = self.coef = self.p_mean = self.y_mean = None

    @property
    def fitted(self) -> bool:
        return self.coef is not None

    @property
    def n_features(self) -> int:
        return len(self.x_mean)

    def _design(self, x: np.ndarray) -> np.ndarray:
        # A model fitted on an older, shorter feature vector reads its leading
        # columns (features are only ever appended, see features.GAZE_FEATURES).
        x = x[:, : len(self.x_mean)]
        z = np.clip((x - self.x_mean) / self.x_scale, -self.clip, self.clip)
        return _expand(z, self.degree, self.quad)

    def _normalization(self, x):
        mean = x.mean(axis=0)
        scale = x.std(axis=0)
        if self.scale_floor is not None:
            scale = np.maximum(scale, self.scale_floor)
        return mean, np.where(scale > 0, scale, 1.0)

    def fit(self, x, y, groups=None, weights=None, alphas=DEFAULT_ALPHAS, error_scale=None) -> dict:
        x = np.asarray(x, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        w = np.ones(len(x)) if weights is None else np.asarray(weights, dtype=np.float64)
        error_scale = np.ones(y.shape[1]) if error_scale is None else np.asarray(error_scale, dtype=np.float64)
        if error_scale.shape != (y.shape[1],) or not np.isfinite(error_scale).all() or np.any(error_scale <= 0):
            raise ValueError("error_scale must contain one positive finite value per output")
        self.x_mean, self.x_scale = self._normalization(x)
        p = self._design(x)

        if not self.robust_deltas or any(delta is not None and (not np.isfinite(delta) or delta <= 0) for delta in self.robust_deltas):
            raise ValueError("robust_deltas must contain None or positive finite thresholds")
        self.error_scale = error_scale
        cv_err = {}
        candidates = []
        if groups is not None and len(np.unique(groups)) >= 3:
            groups = np.asarray(groups)
            # Neither feature normalization nor robust residual weights may
            # see the held-out target. Validation is never passed into fit.
            folds = []
            for g in np.unique(groups):
                test = groups == g
                mean, scale = self._normalization(x[~test])
                design = _expand(np.clip((x - mean) / scale, -self.clip, self.clip), self.degree, self.quad)
                folds.append((test, design))
            for delta in self.robust_deltas:
                scores = {}
                for alpha in alphas:
                    err = np.zeros(len(x))
                    for test, design in folds:
                        coef, pm, ym = _robust_solve(design[~test], y[~test], w[~test], alpha, delta, error_scale)
                        err[test] = np.linalg.norm(((design[test] - pm) @ coef + ym - y[test]) * error_scale, axis=1)
                    scores[float(alpha)] = float(np.average(err, weights=w))
                alpha = min(scores, key=scores.get)
                candidates.append({"robust_delta_points": delta, "alpha": alpha, "cv_error": scores[alpha]})
                cv_err[delta] = scores
            # Keep ordinary ridge unless robust fitting gives a material gain
            # in training-only grouped CV; tiny differences aren't evidence.
            selected = min(candidates, key=lambda row: row["cv_error"])
            plain = next((row for row in candidates if row["robust_delta_points"] is None), None)
            if plain and selected["cv_error"] > plain["cv_error"] * 0.97:
                selected = plain
            self.alpha = selected["alpha"]
            self.robust_delta = selected["robust_delta_points"]
        elif self.alpha is None:
            self.alpha = 1.0
        self.coef, self.p_mean, self.y_mean = _robust_solve(p, y, w, self.alpha, self.robust_delta, error_scale)
        fit_err = np.linalg.norm((self.predict(x) - y) * error_scale, axis=1)
        return {
            "alpha": self.alpha,
            "cv_error": cv_err.get(self.robust_delta, {}).get(self.alpha),
            "robust_delta_points": self.robust_delta,
            "model_candidates": candidates,
            "train_error": float(np.average(fit_err, weights=w)),
        }

    def refit(self, x, y, weights=None) -> None:
        """Refit with the current alpha and normalization (cheap, for online updates)."""
        x = np.asarray(x, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        w = np.ones(len(x)) if weights is None else np.asarray(weights, dtype=np.float64)
        self.coef, self.p_mean, self.y_mean = _robust_solve(self._design(x), y, w, self.alpha, self.robust_delta, self.error_scale)

    def predict(self, x) -> np.ndarray:
        x = np.atleast_2d(np.asarray(x, dtype=np.float64))
        return (self._design(x) - self.p_mean) @ self.coef + self.y_mean

    def to_arrays(self, prefix: str = "gaze_") -> dict[str, np.ndarray]:
        return {
            prefix + "robust_delta": np.array(-1.0 if self.robust_delta is None else self.robust_delta),
            prefix + "error_scale": np.ones(2) if self.error_scale is None else self.error_scale,
            prefix + "degree": np.array(self.degree),
            prefix + "quad": np.array(-1 if self.quad is None else self.quad),
            prefix + "alpha": np.array(self.alpha),
            prefix + "clip": np.array(self.clip),
            prefix + "x_mean": self.x_mean,
            prefix + "x_scale": self.x_scale,
            prefix + "coef": self.coef,
            prefix + "p_mean": self.p_mean,
            prefix + "y_mean": self.y_mean,
        }

    @classmethod
    def from_arrays(cls, d, prefix: str = "gaze_") -> "GazeModel":
        quad = int(d[prefix + "quad"]) if prefix + "quad" in d else -1
        m = cls(degree=int(d[prefix + "degree"]), quad=None if quad < 0 else quad, clip=float(d[prefix + "clip"]))
        delta = float(d[prefix + "robust_delta"]) if prefix + "robust_delta" in d else -1
        m.robust_delta = None if delta < 0 else delta
        m.error_scale = np.asarray(d[prefix + "error_scale"]) if prefix + "error_scale" in d else np.ones(2)
        m.alpha = float(d[prefix + "alpha"])
        for key in ("x_mean", "x_scale", "coef", "p_mean", "y_mean"):
            setattr(m, key, np.asarray(d[prefix + key], dtype=np.float64))
        return m
