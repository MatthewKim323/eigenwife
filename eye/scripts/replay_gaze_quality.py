"""Compare quality masks on the SAME frozen gaze model, without saving anything.

Run from eye: uv run --extra appearance python scripts/replay_gaze_quality.py SESSION --calibration MODEL
This retrospective report does not validate blink sensitivity: session archives
contain no video or human blink annotations. A changed acceptance mask changes
the population used to measure accuracy; newly accepted errors are shown.
"""
import argparse
import json
from pathlib import Path

import numpy as np

from eye import calibration as cal
from eye.features import gaze_vector
from eye.gaze_quality import fit_gaze_quality


def replay(session, calibration):
    rec, script, display, _ = cal.load_session(session)
    baseline = cal.load(calibration)
    profile, _ = cal.fit_profile(rec, script)
    fitting = fit_gaze_quality(profile, [rec.features[i] for i, cue in cal._label(rec, script, 0)
                                       if cue.step.kind in (cal.FIXATE, cal.HEAD)])
    rows = [(rec.features[i], cue) for i, cue in cal._label(rec, script, .05)
            if cue.step.kind == cal.VALIDATE
            and len(gaze_vector(rec.features[i])) == baseline.model.n_features]
    output = {"fit": fitting, "session": str(session), "frozen_model": str(calibration),
              "limitations": "retrospective; no human blink labels; finite face/model frames only", "regions": {}}
    for name, predicate in [("all", lambda y: True), ("upper", lambda y: y < .4), ("lower", lambda y: y > .6)]:
        subset = [(feature, cue) for feature, cue in rows if predicate(cue.y)]
        if not subset:
            continue
        old = np.array([max(baseline.profile.closure(feature, cue.y)) > .35 for feature, cue in subset])
        new = np.array([max(profile.gaze_closure(feature)) > .35 for feature, cue in subset])
        errors = np.array([np.linalg.norm((baseline.model.predict(gaze_vector(feature))[0] - [cue.x, cue.y])
                                         * [display["w"], display["h"]]) for feature, cue in subset])
        def metrics(mask):
            accepted = errors[mask]
            return dict(samples=int(mask.sum()), coverage=float(mask.mean()),
                        mean_points=float(np.mean(accepted)) if len(accepted) else None,
                        p90_points=float(np.percentile(accepted, 90)) if len(accepted) else None)
        output["regions"][name] = dict(total=len(subset), old=metrics(~old), new=metrics(~new),
                                        newly_accepted=metrics(old & ~new), common=metrics(~old & ~new))
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", type=Path)
    parser.add_argument("--calibration", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(replay(args.session, args.calibration), indent=2))
