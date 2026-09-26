from eye.snap import Target


def test_target_geometry():
    t = Target(100, 100, 80, 30, "AXButton")
    assert t.center == (140, 115)
    assert t.contains(140, 115) and not t.contains(190, 115)
    assert t.distance(140, 115) == 0
    assert t.distance(200, 115) == 20
    assert round(t.distance(200, 160), 1) == round((20**2 + 30**2) ** 0.5, 1)
