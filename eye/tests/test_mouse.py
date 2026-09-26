from eye.mouse import Mouse


def test_double_click_counting():
    m = Mouse(dry_run=True, double_click_s=0.9, double_click_px=12)
    assert m.click(100, 100) == 1
    assert m.click(105, 102) == 2  # close enough in time and space
    assert m.click(400, 400) == 1  # somewhere else starts over
    assert m.click(400, 400, button="right") == 1
