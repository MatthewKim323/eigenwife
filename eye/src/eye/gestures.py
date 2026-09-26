"""Blink, wink, and expression gestures.

Built on what the research says actually works (see RESEARCH.md):

* A spontaneous blink is only fully shut for ~50 ms and a quick deliberate
  blink looks almost the same, so only a *held* closure carries intent.
  Holding both eyes shut past `click_s` (~0.3 s, personalized) is a click.
* You can't see while your eyes are shut, so hold time is tiered and each tier
  announces itself with a sound while you're still holding: open after the
  first tone for a left click, after the second for a right click. Past
  `pause_s` it toggles pause.
* Winks fail for a lot of people (only 5 of 15 could wink each eye in one
  study) and MediaPipe tends to read them as partly symmetric, so they're
  off unless calibration showed clean winks.
* Every trigger has hysteresis plus a refractory period (single-threshold
  triggers "Geiger counter" repeat-fire, see GameFace #39).

An "episode" runs from the moment either eye starts closing until both are
open again. While one is running, `closing` is True: the cursor should
freeze, since gaze estimates go bad as the lids come down.
"""

from __future__ import annotations

from dataclasses import dataclass

OPEN, BOTH, LEFT, RIGHT, UNSURE = "open", "both", "left", "right", "unsure"


@dataclass
class GestureConfig:
    onset: float = 0.25  # closure that starts an episode (and freezes the cursor)
    close_on: float = 0.55  # closure at which an eye counts as shut...
    close_off: float = 0.35  # ...and stays shut until it drops below this
    smile_boost: float = 0.10  # smiling squints the eyes; raise thresholds this much at full smile
    click_s: float = 0.35  # both eyes shut at least this long: left click (profile overrides)
    right_click_s: float = 1.20  # ...at least this long: right click
    pause_s: float = 2.50  # ...this long: toggle pause (fires while still shut)
    wink_margin: float = 0.30  # a winking eye must be this much more closed than the other
    wink_min_s: float = 0.20
    wink_max_s: float = 0.90
    open_frames: int = 2  # consecutive open frames that end an episode
    majority: float = 0.6  # share of shut frames that must agree on the kind
    refractory_s: float = 0.40
    brow_on: float = 0.55  # normalized brow raise to start a brow hold...
    brow_off: float = 0.30  # ...and to re-arm after
    brow_hold_s: float = 0.50
    mouth_on: float = 0.50
    mouth_off: float = 0.25
    mouth_hold_s: float = 0.60


@dataclass
class Gesture:
    kind: str
    t_start: float  # when the gesture began (eyes started closing, brows went up...)
    t: float  # when it fired


# Feedback-only events (no action attached): a hold tier was reached.
TIER_CLICK, TIER_RIGHT = "tier_click", "tier_right"


class Hold:
    """Fires once when a value stays above `on` for `hold_s`; re-arms below `off`."""

    def __init__(self, on: float, off: float, hold_s: float):
        self.on, self.off, self.hold_s = on, off, hold_s
        self.active = False
        self.since = 0.0
        self.fired = False

    def update(self, t: float, value: float) -> bool:
        if not self.active:
            if value >= self.on:
                self.active, self.since, self.fired = True, t, False
        elif value < self.off:
            self.active = False
        if self.active and not self.fired and t - self.since >= self.hold_s:
            self.fired = True
            return True
        return False

    def progress(self, t: float) -> float:
        return 0.0 if not self.active or self.fired else min((t - self.since) / self.hold_s, 1.0)


class GestureDetector:
    def __init__(self, cfg: GestureConfig | None = None, winks: tuple[bool, bool] = (False, False)):
        self.cfg = cfg or GestureConfig()
        self.winks = winks
        self.brow = Hold(self.cfg.brow_on, self.cfg.brow_off, self.cfg.brow_hold_s)
        self.mouth = Hold(self.cfg.mouth_on, self.cfg.mouth_off, self.cfg.mouth_hold_s)
        self._last_fire = -1e9
        self.reset()

    def reset(self) -> None:
        """Forget any episode in progress (face lost, etc)."""
        self.closed_l = self.closed_r = False
        self.closing = False
        self.onset_t: float | None = None
        self.symbol = OPEN
        self._open_run = 0
        self._counts = {BOTH: 0, LEFT: 0, RIGHT: 0, UNSURE: 0}
        self._first_closed: float | None = None
        self._last_closed: float | None = None
        self._tiers: set[str] = set()
        self._fired_pause = False
        self._cancelled = False
        self._winks_ok = True
        self._last_t: float | None = None

    def cancel(self) -> None:
        """Keep tracking the episode but don't let it trigger anything."""
        if self.closing:
            self._cancelled = True

    @property
    def expression(self) -> bool:
        """A brow or mouth gesture is building up."""
        return self.brow.active or self.mouth.active

    def held(self, t: float) -> tuple[str, float]:
        """What the current closure looks like and how long it's been shut, for feedback."""
        if not self.closing or self._first_closed is None:
            return OPEN, 0.0
        return self._dominant(), t - self._first_closed

    def _dominant(self) -> str:
        c = self._counts
        both = c[BOTH] + c[UNSURE]
        if c[LEFT] > both and c[LEFT] > c[RIGHT]:
            return LEFT
        if c[RIGHT] > both and c[RIGHT] > c[LEFT]:
            return RIGHT
        return BOTH

    def _classify(self, cl: float, cr: float, boost: float) -> str:
        c = self.cfg
        self.closed_l = cl > (c.close_off if self.closed_l else c.close_on) + boost
        self.closed_r = cr > (c.close_off if self.closed_r else c.close_on) + boost
        if self.closed_l and self.closed_r:
            return BOTH
        if self.closed_l:
            return LEFT if cl - cr >= c.wink_margin else UNSURE
        if self.closed_r:
            return RIGHT if cr - cl >= c.wink_margin else UNSURE
        return OPEN

    def update_expressions(self, t: float, brow: float, jaw: float) -> list[Gesture]:
        events = []
        if self.brow.update(t, brow):
            events.append(Gesture("brow_hold", self.brow.since, t))
        if self.mouth.update(t, jaw):
            events.append(Gesture("mouth_hold", self.mouth.since, t))
        return events

    def update(self, t: float, cl: float, cr: float, smile: float = 0.0, winks_ok: bool = True) -> list[Gesture]:
        c = self.cfg
        dt = t - self._last_t if self._last_t is not None else 1 / 30
        self._last_t = t
        boost = c.smile_boost * min(max((smile - 0.3) / 0.4, 0.0), 1.0)
        symbol = self._classify(cl, cr, boost)
        self.symbol = symbol
        events: list[Gesture] = []
        opened = symbol == OPEN and max(cl, cr) < c.onset + boost

        if not self.closing:
            if opened:
                return events
            self.closing = True
            self.onset_t = t
            self._open_run = 0
            self._counts = {BOTH: 0, LEFT: 0, RIGHT: 0, UNSURE: 0}
            self._first_closed = self._last_closed = None
            self._tiers = set()
            self._fired_pause = False
            self._cancelled = False
            self._winks_ok = True
        self._winks_ok &= winks_ok

        if opened:
            self._open_run += 1
            if self._open_run >= c.open_frames:
                events.extend(self._finish(t, dt))
            return events
        self._open_run = 0
        if symbol == OPEN:
            return events

        self._counts[symbol] += 1
        if self._first_closed is None:
            self._first_closed = t
        self._last_closed = t
        if self._cancelled or self._fired_pause or self._dominant() != BOTH:
            return events
        held = t - self._first_closed + dt
        for tier, limit in ((TIER_CLICK, c.click_s), (TIER_RIGHT, c.right_click_s)):
            if held >= limit and tier not in self._tiers:
                self._tiers.add(tier)
                events.append(Gesture(tier, self.onset_t, t))
        if held >= c.pause_s and t - self._last_fire >= c.refractory_s:
            self._fired_pause = True
            self._last_fire = t
            events.append(Gesture("long_close", self.onset_t, t))
        return events

    def _finish(self, t: float, dt: float) -> list[Gesture]:
        c = self.cfg
        onset = self.onset_t
        self.closing = False
        self.onset_t = None
        if self._cancelled or self._fired_pause or self._first_closed is None:
            return []
        if onset - self._last_fire < c.refractory_s:
            return []
        n = sum(self._counts.values())
        duration = self._last_closed - self._first_closed + dt
        kind = None
        winks = self.winks if self._winks_ok else (False, False)
        if self._counts[LEFT] >= c.majority * n:
            if winks[0] and c.wink_min_s <= duration <= c.wink_max_s:
                kind = "wink_left"
        elif self._counts[RIGHT] >= c.majority * n:
            if winks[1] and c.wink_min_s <= duration <= c.wink_max_s:
                kind = "wink_right"
        elif self._counts[BOTH] + self._counts[UNSURE] >= c.majority * n:
            if c.click_s <= duration < c.right_click_s:
                kind = "long_blink"
            elif c.right_click_s <= duration < c.pause_s:
                kind = "longer_blink"
        if kind is None:
            return []
        self._last_fire = t
        return [Gesture(kind, onset, t)]
