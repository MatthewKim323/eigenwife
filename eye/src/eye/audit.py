"""Read-only offline calibration replay: ``python -m eye.audit SESSION.npz``.

The report never saves or replaces a calibration. Validation is held out from
fitting; each head-target stress test also reselects alpha without its target.
Scores describe this recording only, not prospective live accuracy.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from . import calibration as cal
from .screen import Display


def audit(path: Path, latency: float = 0.05) -> dict:
    rec, script, geometry, camera = cal.load_session(path)
    display = Display(0, geometry["name"], 0, 0, geometry["w"], geometry["h"],
                      1.0, True, tuple(geometry["mm"]))
    result = cal.fit(rec, script, display, latency=latency)
    x, y, groups, weights, kinds, _ = cal._prepare(
        rec, script, result.profile, latency,
        pursuit_latency=result.stats.get("pursuit_lag", latency),
    )
    head_holdouts = []
    for group in np.unique(groups[kinds == cal.HEAD]):
        test = (kinds == cal.HEAD) & (groups == group)
        train = (kinds != cal.VALIDATE) & ~test
        if train.sum() < 30:
            continue
        model = cal.new_model(x.shape[1])
        scores = model.fit(x[train], y[train], groups[train], weights[train], error_scale=[display.w, display.h])
        errors = np.linalg.norm((model.predict(x[test]) - y[test]) * [display.w, display.h], axis=1)
        head_holdouts.append({
            "target": y[test][0].tolist(), "samples": int(test.sum()),
            "mean_points": float(errors.mean()), "p90_points": float(np.percentile(errors, 90)),
            "worst_points": float(errors.max()), "alpha": scores["alpha"],
        })
    return {
        "session": str(path.resolve()), "camera": camera, "display": geometry,
        "method": "linear ridge, fold-local scaling, whole head-target holdouts, untrimmed validation",
        "limitation": "offline replay of one recording; live accuracy requires fresh validation",
        "stats": result.stats, "validation": result.validation,
        "head_target_holdouts": head_holdouts,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", type=Path)
    parser.add_argument("--latency", type=float, default=0.05,
                        help="base camera latency in seconds (pursuit lag is estimated separately)")
    args = parser.parse_args()
    print(json.dumps(audit(args.session, args.latency), indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
