from eye.features import Eye, Features
from eye.profile import FaceProfile


def features(ear_l=0.30, ear_r=0.30, bs=(0.1, 0.1), brow=0.05, jaw=0.02):
    left = Eye(u=0, v=0, lid=0.35, ear=ear_l, width=40, iris=(0, 0))
    right = Eye(u=0, v=0, lid=0.35, ear=ear_r, width=40, iris=(0, 0))
    return Features(
        t=0.0, left=left, right=right, yaw=0, pitch=0, roll=0, pos=(0, 0, -55), bs_blink=bs, nose=(0, 0), brow=brow, jaw=jaw
    )


def test_ear_closure_spans_open_to_shut():
    p = FaceProfile(mix=0.0, ear_open_l=0.30, ear_open_r=0.30, ear_closed_l=0.06, ear_closed_r=0.06)
    assert p.closure(features(0.30, 0.30)) == (0.0, 0.0)
    cl, cr = p.closure(features(0.06, 0.18))
    assert cl == 1.0 and 0.4 < cr < 0.6


def test_looking_down_does_not_read_as_closed():
    """Lids drop when you look at the bottom of the screen; the baseline follows."""
    p = FaceProfile(mix=0.0, ear_open_l=0.30, ear_open_r=0.30, ear_slope_l=-0.04, ear_slope_r=-0.04, ear_closed_l=0.06, ear_closed_r=0.06)
    looking_down = features(0.28, 0.28)
    assert p.closure(looking_down, gaze_y=0.5)[0] > 0.05  # naive: partly closed
    assert p.closure(looking_down, gaze_y=1.0)[0] == 0.0  # adjusted for gaze: wide open


def test_swap_flips_blendshape_sides():
    p = FaceProfile(mix=1.0, bs_open_l=0.1, bs_open_r=0.1, bs_closed_l=0.7, bs_closed_r=0.7)
    assert p.closure(features(bs=(0.7, 0.1))) == (1.0, 0.0)
    p.swap = True
    assert p.closure(features(bs=(0.7, 0.1))) == (0.0, 1.0)


def test_mix_averages_the_two_signals():
    p = FaceProfile(mix=0.5, ear_open_l=0.3, ear_closed_l=0.06, bs_open_l=0.1, bs_closed_l=0.7)
    cl, _ = p.closure(features(ear_l=0.06, bs=(0.1, 0.1)))  # shape says shut, blendshape says open
    assert abs(cl - 0.5) < 0.01


def test_expression_levels_normalize():
    p = FaceProfile(brow_neutral=0.05, brow_raised=0.65, jaw_neutral=0.02, jaw_open=0.62)
    assert p.brow_level(features(brow=0.65)) == 1.0
    assert p.brow_level(features(brow=0.05)) == 0.0
    assert abs(p.jaw_level(features(jaw=0.32)) - 0.5) < 0.02


def test_roundtrip_through_arrays():
    p = FaceProfile(mix=0.5, swap=True, wink_l=True, click_s=0.42, calibrated=True)
    back = FaceProfile.from_arrays(p.to_arrays())
    assert back == p
