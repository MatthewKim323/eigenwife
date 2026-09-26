from eye.gestures import TIER_CLICK, TIER_RIGHT, GestureConfig, GestureDetector, Hold

FPS = 30.0
OPEN = (0.5, 0.05, 0.05)


def run(segments, cfg=None, winks=(False, False), smile=0.0):
    """segments: [(seconds, left_closure, right_closure), ...] sampled at 30 fps."""
    det = GestureDetector(cfg, winks=winks)
    t = 0.0
    kinds, closing = [], []
    for seconds, cl, cr in segments:
        for _ in range(round(seconds * FPS)):
            t += 1 / FPS
            kinds += [e.kind for e in det.update(t, cl, cr, smile=smile)]
            closing.append(det.closing)
    return kinds, closing


def actions(kinds):
    return [k for k in kinds if not k.startswith("tier")]


def test_spontaneous_blink_is_ignored_but_freezes():
    kinds, closing = run([OPEN, (0.15, 0.95, 0.95), OPEN])
    assert kinds == []
    assert any(closing) and not closing[-1]


def test_held_blink_clicks_and_announces_the_tier_first():
    kinds, _ = run([OPEN, (0.6, 0.95, 0.9), OPEN])
    assert kinds == [TIER_CLICK, "long_blink"]


def test_holding_past_the_second_tone_right_clicks():
    kinds, _ = run([OPEN, (1.5, 0.95, 0.95), OPEN])
    assert kinds == [TIER_CLICK, TIER_RIGHT, "longer_blink"]


def test_holding_longest_toggles_pause_and_nothing_on_release():
    kinds, _ = run([OPEN, (2.8, 0.95, 0.95), OPEN])
    assert actions(kinds) == ["long_close"]


def test_winks_are_off_until_calibration_enables_them():
    assert actions(run([OPEN, (0.4, 0.9, 0.2), OPEN])[0]) == []
    assert actions(run([OPEN, (0.4, 0.9, 0.2), OPEN], winks=(True, True))[0]) == ["wink_left"]
    assert actions(run([OPEN, (0.4, 0.15, 0.85), OPEN], winks=(True, True))[0]) == ["wink_right"]


def test_wink_only_counts_when_the_other_eye_stays_open_enough():
    # Other eye squints along but stays below the gap: still a wink.
    assert actions(run([OPEN, (0.4, 0.9, 0.5), OPEN], winks=(True, True))[0]) == ["wink_left"]
    # Both eyes closed the same amount is a blink, not a wink.
    assert actions(run([OPEN, (0.6, 0.9, 0.85), OPEN], winks=(True, True))[0]) == ["long_blink"]


def test_wink_suppressed_when_the_head_is_turned():
    det = GestureDetector(winks=(True, True))
    t = 0.0
    kinds = []
    for seconds, cl, cr, ok in ((0.3, 0.05, 0.05, True), (0.4, 0.9, 0.2, False), (0.3, 0.05, 0.05, True)):
        for _ in range(round(seconds * FPS)):
            t += 1 / FPS
            kinds += [e.kind for e in det.update(t, cl, cr, winks_ok=ok)]
    assert actions(kinds) == []


def test_smiling_raises_the_threshold():
    squint = [OPEN, (0.6, 0.62, 0.62), OPEN]
    assert actions(run(squint)[0]) == ["long_blink"]
    assert actions(run(squint, smile=1.0)[0]) == []


def test_cancel_blocks_the_episode():
    det = GestureDetector()
    t = 0.0
    kinds = []
    for i in range(round(0.7 * FPS)):
        t += 1 / FPS
        kinds += [e.kind for e in det.update(t, 0.9, 0.9)]
        if i == 3:
            det.cancel()
    for _ in range(4):
        t += 1 / FPS
        kinds += [e.kind for e in det.update(t, 0.05, 0.05)]
    assert actions(kinds) == []


def test_single_open_frame_does_not_split_a_hold():
    kinds, _ = run([OPEN, (0.3, 0.95, 0.95), (1 / FPS, 0.1, 0.1), (0.3, 0.95, 0.95), OPEN])
    assert actions(kinds) == ["long_blink"]


def test_refractory_blocks_an_immediate_repeat():
    cfg = GestureConfig(refractory_s=1.0)
    kinds, _ = run([OPEN, (0.5, 0.95, 0.95), (0.2, 0.05, 0.05), (0.5, 0.95, 0.95), OPEN], cfg)
    assert actions(kinds) == ["long_blink"]


def test_two_blinks_with_a_gap_both_click():
    kinds, _ = run([OPEN, (0.5, 0.95, 0.95), (0.5, 0.05, 0.05), (0.5, 0.95, 0.95), OPEN])
    assert actions(kinds) == ["long_blink", "long_blink"]


def test_asymmetric_onset_is_still_a_blink():
    kinds, _ = run([OPEN, (1 / FPS, 0.9, 0.2), (0.5, 0.95, 0.95), OPEN], winks=(True, True))
    assert actions(kinds) == ["long_blink"]


def test_expression_holds_fire_once_and_rearm():
    det = GestureDetector()
    fired = []
    t = 0.0
    for seconds, brow in ((1.0, 0.8), (0.3, 0.05), (1.0, 0.8)):
        for _ in range(round(seconds * FPS)):
            t += 1 / FPS
            fired += [e.kind for e in det.update_expressions(t, brow, 0.0)]
    assert fired == ["brow_hold", "brow_hold"]


def test_hold_needs_the_full_duration():
    h = Hold(0.5, 0.3, 0.5)
    t = 0.0
    fired = 0
    for _ in range(10):  # 0.33s
        t += 1 / FPS
        fired += h.update(t, 0.9)
    assert fired == 0
    assert 0 < h.progress(t) < 1
    for _ in range(10):
        t += 1 / FPS
        fired += h.update(t, 0.9)
    assert fired == 1
