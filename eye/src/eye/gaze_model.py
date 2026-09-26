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


class GazeModel:
    """Standardize, add quadratic terms, ridge-regress onto (x, y) in 0..1.

    Only the first `quad` features (the eye block) get quadratic terms; the
    rest (head pose) stay linear. Head terms are what break when calibration
    didn't cover a pose, so they get the least capacity.

    alpha is picked by grouped cross validation: a group is one calibration
    target (or one chunk of the moving-target sweep), so the score reflects how
    well the model generalizes to places on screen it wasn't trained on.
    """

    def __init__(self, degree: int = 2, quad: int | None = None, scale_floor: np.ndarray | None = None, clip: float = 5.0):
        self.degree = degree
        self.quad = quad
        self.scale_floor = scale_floor
        self.clip = clip
        self.alpha: float | None = None
        self.x_mean = self.x_scale = self.coef = self.p_mean = self.y_mean = None

    @property
    def fitted(self) -> bool:
        return self.coef is not None

    def _design(self, x: np.ndarray) -> np.ndarray:
        z = np.clip((x - self.x_mean) / self.x_scale, -self.clip, self.clip)
        return _expand(z, self.degree, self.quad)

    def fit(self, x, y, groups=None, weights=None, alphas=DEFAULT_ALPHAS) -> dict:
        x = np.asarray(x, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        w = np.ones(len(x)) if weights is None else np.asarray(weights, dtype=np.float64)
        self.x_mean = x.mean(axis=0)
        scale = x.std(axis=0)
        if self.scale_floor is not None:
            scale = np.maximum(scale, self.scale_floor)
        self.x_scale = np.where(scale > 0, scale, 1.0)
        p = self._design(x)

        cv_err = {}
        if groups is not None and len(np.unique(groups)) >= 3:
            groups = np.asarray(groups)
            for alpha in alphas:
                err = np.zeros(len(x))
                for g in np.unique(groups):
                    test = groups == g
                    coef, pm, ym = _solve(p[~test], y[~test], w[~test], alpha)
                    err[test] = np.linalg.norm((p[test] - pm) @ coef + ym - y[test], axis=1)
                cv_err[float(alpha)] = float(np.average(err, weights=w))
            self.alpha = min(cv_err, key=cv_err.get)
        elif self.alpha is None:
            self.alpha = 1.0
        self.coef, self.p_mean, self.y_mean = _solve(p, y, w, self.alpha)
        fit_err = np.linalg.norm(self.predict(x) - y, axis=1)
        return {
            "alpha": self.alpha,
            "cv_error": cv_err.get(self.alpha),
            "train_error": float(np.average(fit_err, weights=w)),
        }

    def refit(self, x, y, weights=None) -> None:
        """Refit with the current alpha and normalization (cheap, for online updates)."""
        x = np.asarray(x, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        w = np.ones(len(x)) if weights is None else np.asarray(weights, dtype=np.float64)
        self.coef, self.p_mean, self.y_mean = _solve(self._design(x), y, w, self.alpha)

    def predict(self, x) -> np.ndarray:
        x = np.atleast_2d(np.asarray(x, dtype=np.float64))
        return (self._design(x) - self.p_mean) @ self.coef + self.y_mean

    def to_arrays(self, prefix: str = "gaze_") -> dict[str, np.ndarray]:
        return {
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
        m.alpha = float(d[prefix + "alpha"])
        for key in ("x_mean", "x_scale", "coef", "p_mean", "y_mean"):
            setattr(m, key, np.asarray(d[prefix + key], dtype=np.float64))
        return m
