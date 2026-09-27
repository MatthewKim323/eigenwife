"""Bind optional image features to the calibration that learned their mapping."""

from dataclasses import dataclass

from .features import GAZE_FEATURES


@dataclass(frozen=True)
class AppearanceFactory:
    """Create the runtime on the tracker thread; metadata needs no runtime."""

    @property
    def metadata(self):
        from .appearance import FEATURE_COUNT, FINGERPRINT
        return {"name": "mgazenet", "fingerprint": FINGERPRINT, "feature_count": FEATURE_COUNT}

    def __call__(self):
        from .appearance import MGazeNetFeatures
        return MGazeNetFeatures()


def for_calibration(calibration):
    if calibration is None:
        return None
    meta = calibration.meta.get("feature_backend", {"name": "landmarks"})
    if meta.get("name") == "landmarks":
        if calibration.model.n_features > len(GAZE_FEATURES):
            raise RuntimeError("calibration has image features but no matching backend metadata")
        return None
    factory = AppearanceFactory()
    if meta != factory.metadata or calibration.model.n_features != len(GAZE_FEATURES) + meta["feature_count"]:
        raise RuntimeError("calibration appearance backend/version differs; use matching weights or recalibrate")
    return factory
