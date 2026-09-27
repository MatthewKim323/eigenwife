// eye-client.js: gaze from `eye serve` into a web page. No dependencies.
//
//   import { EyeClient } from "http://127.0.0.1:8765/eye-client.js";
//   const eye = new EyeClient();                 // tracks every [data-gaze] element
//   eye.on("fixation", ({ el, ms }) => ...);     // a fixation landed on an element
//   eye.stats();                                 // { photo_1: { dwellMs, visits, ... }, ... }
//   await eye.calibrate();                       // 5 "look here" dots, fixes drift
//
// Screen points map safely only in fullscreen at 100% browser zoom.
// Reject unknown viewport geometry instead of learning browser chrome as gaze drift.

const DEFAULT_URL = "ws://127.0.0.1:8765/ws";

export class EyeClient {
  constructor({ url = DEFAULT_URL, selector = "[data-gaze]", root = document,
    transport = (address) => new WebSocket(address), gazeSmoother = null } = {}) {
    this.url = url;
    this.selector = selector;
    this.root = root;
    this.transport = transport;
    this.gazeSmoother = gazeSmoother;
    this.handlers = {};
    this.display = null;
    this.ptPerDeg = 49;
    this.connected = false;
    this.face = false;
    this.calibrated = false;
    this.canCalibrate = false;
    this.corrected = false;
    this.gaze = null; // latest { x, y } in page (client) px, or null
    this.current = null; // element under the current fixation
    this._stats = new Map(); // key -> { dwellMs, visits, fixations, longestMs, firstAt, lastAt }
    this._lastGazeT = null;
    this._lastFixEl = null;
    this._pending = [];
    this._closed = false;
    this._candidate = null;
    this._semantic = null;
    this._nextId = 1;
    this._calibrating = false;
    this._geometryChanged = () => {
      this._clear(this._lastGazeT, "geometry changed");
      if (this._calibrating) this._calibrationAborted = true;
      this._status();
    };
    window.addEventListener("resize", this._geometryChanged);
    document.addEventListener("fullscreenchange", this._geometryChanged);
    window.visualViewport?.addEventListener("resize", this._geometryChanged);
    this.connect();
  }

  // events: status, gaze, fixation, fixation_end, enter, leave, calib_result, message
  on(type, fn) {
    (this.handlers[type] ||= []).push(fn);
    return () => (this.handlers[type] = this.handlers[type].filter((f) => f !== fn));
  }

  _fire(type, detail) {
    for (const fn of this.handlers[type] || []) {
      try {
        fn(detail);
      } catch (e) {
        console.error(`[eye] ${type} handler`, e);
      }
    }
  }

  connect() {
    const ws = this.transport(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      for (const m of this._pending.splice(0)) ws.send(m);
      this._status();
    };
    ws.onclose = () => {
      this.connected = false;
      this.face = false;
      this._clear(this._lastGazeT, "disconnected");
      this._status();
      if (!this._closed) this._reconnect = setTimeout(() => this.connect(), 1000);
    };
    ws.onmessage = (e) => this._message(JSON.parse(e.data));
  }

  close() {
    this._closed = true;
    this.connected = false;
    this.face = false;
    this._calibrationAborted = true;
    this._calibrationOverlay?.remove();
    clearTimeout(this._reconnect);
    clearTimeout(this._staleTimer);
    window.removeEventListener("resize", this._geometryChanged);
    document.removeEventListener("fullscreenchange", this._geometryChanged);
    window.visualViewport?.removeEventListener("resize", this._geometryChanged);
    this._clear(this._lastGazeT, "closed");
    this.ws?.close();
  }

  send(msg) {
    if (this._closed) return;
    const text = JSON.stringify(msg);
    if (this.connected) this.ws.send(text);
    else this._pending.push(text);
  }

  status() {
    const geometry = this.geometry();
    return {
      connected: this.connected,
      face: this.face,
      calibrated: this.calibrated,
      canCalibrate: this.canCalibrate,
      corrected: this.corrected,
      accuracyDeg: this.accuracyDeg,
      uncertaintyDeg: this.uncertaintyDeg,
      uncertaintySource: this.uncertaintySource,
      accuracyValidated: this.accuracyValidated ?? false,
      ...geometry,
      valid: this.connected && this.face && this.calibrated && geometry.geometryValid && this._sampleValid === true,
      quality: this._quality ?? "unknown",
      guidance: geometry.reason ? null : this._guidance ?? null,
      pose: this._pose ?? null,
      calibrating: this._calibrating,
      reason: geometry.reason ?? this._reason ?? null,
    };
  }

  _status() { this._fire("status", this.status()); }

  setGazeSmoother(smoother) {
    this._clear(this._lastGazeT, "smoothing changed");
    this.gazeSmoother = smoother;
    this._status();
  }

  geometry() {
    const d = this.display;
    let reason = null;
    let viewportX = 0;
    let viewportY = 0;
    if (!d) reason = "waiting for display geometry";
    else if (document.fullscreenElement !== document.documentElement)
      reason = "enter fullscreen to enable gaze mapping";
    else if (Math.abs(window.screen.width - d.w) > 2 || Math.abs(window.screen.height - d.h) > 2)
      reason = `browser display ${window.screen.width}×${window.screen.height} differs from calibrated display ${d.w}×${d.h}`;
    else if (Math.abs((window.visualViewport?.scale ?? 1) - 1) > 0.001 ||
      (d.scale && Math.abs(window.devicePixelRatio - d.scale) > 0.05))
      reason = `browser zoom differs from 100% (device scale ${window.devicePixelRatio}, expected ${d.scale})`;
    else if ((Math.abs(window.screenX - d.x) > 2 && Math.abs(window.screenX - window.screen.availLeft) > 2) ||
      (Math.abs(window.screenY - d.y) > 2 && Math.abs(window.screenY - window.screen.availTop) > 2))
      reason = "move this window to the calibrated display";
    else {
      // macOS may reserve the menu bar or camera-notch area even for a page in
      // fullscreen. Chrome then reports a shorter CSS viewport at 100% zoom.
      // Only accept a viewport matching the full screen or the OS usable area.
      const full = Math.abs(window.innerWidth - d.w) <= 2 && Math.abs(window.innerHeight - d.h) <= 2;
      const available = Math.abs(window.innerWidth - window.screen.availWidth) <= 2 &&
        Math.abs(window.innerHeight - window.screen.availHeight) <= 2 &&
        d.w - window.innerWidth <= 80 && d.h - window.innerHeight <= 80;
      if (available && !full) {
        viewportX = window.screen.availLeft - d.x;
        viewportY = window.screen.availTop - d.y;
      } else if (!full) {
        reason = `fullscreen viewport ${window.innerWidth}×${window.innerHeight} differs from display ${d.w}×${d.h} and usable area ${window.screen.availWidth}×${window.screen.availHeight}; close side panels or devtools`;
      }
      if (!reason && (viewportX < -2 || viewportY < -2 ||
        viewportX + window.innerWidth > d.w + 2 || viewportY + window.innerHeight > d.h + 2))
        reason = "browser viewport is outside the calibrated display";
    }
    return { geometryValid: !reason, reason, viewportX, viewportY };
  }

  toPage(x, y) {
    const g = this.geometry();
    if (!g.geometryValid) return null;
    return { x: x - this.display.x - g.viewportX, y: y - this.display.y - g.viewportY };
  }

  toScreen(x, y) {
    const g = this.geometry();
    if (!g.geometryValid) return null;
    return { x: x + this.display.x + g.viewportX, y: y + this.display.y + g.viewportY };
  }

  hit(px, py) {
    if (px < 0 || py < 0 || px >= window.innerWidth || py >= window.innerHeight) return null;
    const top = document.elementFromPoint(px, py);
    const direct = top?.closest(this.selector);
    if (!direct || !this.root.contains(direct)) return null;
    const degrees = this.uncertaintyDeg ?? this.accuracyDeg;
    if (!Number.isFinite(degrees)) return null;
    const uncertainty = Math.max(0, degrees) * this.ptPerDeg;
    for (const el of this.root.querySelectorAll(this.selector)) {
      if (el === direct || el.contains(direct) || direct.contains(el)) continue;
      const style = window.getComputedStyle(el);
      if (style.visibility !== "visible" || style.display === "none" || Number(style.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      const left = Math.max(0, r.left), right = Math.min(window.innerWidth, r.right);
      const upper = Math.max(0, r.top), lower = Math.min(window.innerHeight, r.bottom);
      if (right <= left || lower <= upper) continue;
      const x = Math.max(left, Math.min(px, right - 0.01));
      const y = Math.max(upper, Math.min(py, lower - 0.01));
      const visible = document.elementFromPoint(x, y);
      if (!visible || !el.contains(visible)) continue;
      if (Math.hypot(px - x, py - y) <= uncertainty) return null;
    }
    return direct;
  }

  key(el) {
    return el.dataset.gaze || el.id || null;
  }

  // stats per [data-gaze] key: dwell time, visits (revisits = visits - 1), fixations
  stats() {
    const out = {};
    for (const [k, s] of this._stats) out[k] = { ...s, revisits: Math.max(s.visits - 1, 0) };
    return out;
  }

  resetStats() {
    this._stats.clear();
    this._lastFixEl = null;
  }

  _stat(el) {
    const k = this.key(el);
    if (!k) return null;
    if (!this._stats.has(k))
      this._stats.set(k, { dwellMs: 0, visits: 0, fixations: 0, longestMs: 0, firstAt: null, lastAt: null });
    return this._stats.get(k);
  }

  _message(m) {
    switch (m.type) {
      case "hello":
        this.display = m.display;
        this.face = m.face ?? false;
        this.ptPerDeg = m.display.ptPerDeg;
        this.calibrated = m.calibrated;
        this.canCalibrate = m.canCalibrate === true;
        this.corrected = m.corrected;
        this.accuracyDeg = m.accuracyDeg;
        this.uncertaintyDeg = m.uncertaintyDeg;
        this.uncertaintySource = m.uncertaintySource;
        this.accuracyValidated = m.accuracyValidated ?? false;
        this._status();
        break;
      case "face":
        this.face = m.present;
        if (!m.present) this._clear(m.t, "face lost");
        this._status();
        break;
      case "gaze":
        this._gaze(m);
        break;
      // Backend fixations describe signal stability. Semantic fixations below
      // follow visible DOM targets independently, including small eye movements.
      case "fixation_start":
      case "fixation_end":
        break;
      case "calib_result":
        if (m.corrected !== undefined) this.corrected = m.corrected;
        if (m.applied) this.accuracyDeg = null;
        if ("uncertaintyDeg" in m) this.uncertaintyDeg = m.uncertaintyDeg;
        if ("uncertaintySource" in m) this.uncertaintySource = m.uncertaintySource;
        if ("accuracyValidated" in m) this.accuracyValidated = m.accuracyValidated;
        this.send({ type: "hello" });
        this._fire("calib_result", m);
        this._status();
        break;
    }
    this._fire("message", m);
  }

  _endSemantic(t) {
    const f = this._semantic;
    if (!f) return;
    const ms = Math.max(0, (t ?? f.lastT) - f.t);
    const s = this._stat(f.el);
    if (s) s.longestMs = Math.max(s.longestMs, ms);
    this._fire("fixation_end", { ...f, key: this.key(f.el), t: t ?? f.lastT, ms });
    this._semantic = null;
  }

  _clear(t, reason) {
    this.gazeSmoother?.reset();
    clearTimeout(this._staleTimer);
    this._endSemantic(this._semantic?.lastT ?? t);
    if (this.current) this._fire("leave", { el: this.current, key: this.key(this.current) });
    this.current = null;
    this.gaze = null;
    this._sampleValid = false;
    this._candidate = null;
    this._lastGazeT = null;
    this._lastFixEl = null;
    this._reason = reason;
    if (this._lostReason !== reason) this._fire("lost", { t, reason });
    this._lostReason = reason;
  }

  _checkStale(now = Date.now()) {
    if (this._sampleValid && now - this._receivedAt >= 500) {
      this._clear(this._lastGazeT, "camera samples stopped");
      this._status();
    }
  }

  _gaze(m) {
    if (this.gazeSmoother && this._lastGazeT !== null && m.valid !== false && m.t <= this._lastGazeT) return;
    const sampleValid = m.valid !== false && Number.isFinite(m.x) && Number.isFinite(m.y) && Number.isFinite(m.t) && !m.blink;
    let p = sampleValid ? this.toPage(m.x, m.y) : null;
    const valid = sampleValid && !!p && !this._calibrating && this.face && this.calibrated;
    const reason = !sampleValid ? (m.reason ?? "tracking unavailable") : !p ? this.geometry().reason
      : this._calibrating ? "calibrating" : !this.face ? "face lost" : !this.calibrated ? "uncalibrated" : (m.reason ?? null);
    const quality = m.quality ?? "unknown";
    const changed = this._sampleValid !== valid || this._reason !== reason || this._quality !== quality || this._guidance !== (m.guidance ?? null);
    this._guidance = m.guidance ?? null;
    this._pose = m.pose ?? null;
    this._quality = quality;
    if (!valid) {
      this._clear(m.t, reason);
      if (changed) this._status();
      return;
    }
    if (this._lastGazeT !== null && (m.t <= this._lastGazeT || m.t - this._lastGazeT >= (this.gazeSmoother ? 500 : 250)))
      this._clear(this._lastGazeT, "sample gap");
    const raw = p;
    if (this.gazeSmoother) p = this.gazeSmoother.update({ ...p, t: m.t });
    this._sampleValid = true;
    this._reason = reason;
    this._lostReason = null;
    if (changed) this._status();
    this.gaze = p;
    this._receivedAt = Date.now();
    clearTimeout(this._staleTimer);
    this._staleTimer = setTimeout(() => this._checkStale(), 500);
    this._staleTimer.unref?.();
    const el = this.hit(p.x, p.y);
    if (el !== this.current) {
      this._endSemantic(this._semantic?.lastT ?? m.t);
      if (this.current) {
        this._fire("leave", { el: this.current, key: this.key(this.current) });
        this._fire("lost", { t: m.t, reason: el ? "target_changed" : "ambiguous_target" });
      }
      this.current = el;
      this._candidate = el ? { el, t: m.t } : null;
      if (el) this._fire("enter", { el, key: this.key(el) });
    }
    if (el && this._candidate && !this._semantic && m.t - this._candidate.t >= 150) {
      this._semantic = { id: this._nextId++, el, t: this._candidate.t, lastT: m.t, x: p.x, y: p.y };
      const s = this._stat(el);
      if (s) {
        s.fixations += 1;
        if (el !== this._lastFixEl) s.visits += 1;
        s.firstAt ??= this._candidate.t;
        s.lastAt = m.t;
        s.dwellMs += m.t - this._candidate.t;
      }
      this._lastFixEl = el;
      this._fire("fixation", { ...this._semantic, key: this.key(el) });
    } else if (this._semantic) {
      const s = this._stat(el);
      if (s) { s.dwellMs += m.t - this._semantic.lastT; s.lastAt = m.t; }
      this._semantic.lastT = m.t;
    }
    this._lastGazeT = m.t;
    this._fire("gaze", { x: p.x, y: p.y, raw, blink: false, el, key: el && this.key(el),
      fix: this._semantic ? { id: this._semantic.id, ms: m.t - this._semantic.t } : null, t: m.t });
  }

  // Quick in-app calibration: shows "look here" dots, the server fits a drift
  // correction on top of the saved calibration. ~1.8 s per dot.
  async calibrate({
    points = [
      [0.5, 0.5],
      [0.12, 0.15],
      [0.88, 0.15],
      [0.88, 0.85],
      [0.12, 0.85],
    ],
    glideMs = 450,
    settleMs = 500,
    sampleMs = 900,
    label = "LOOK HERE",
    validateOnly = false,
    recenterOnly = false,
    pointLabels = [],
    pointMetadata = [],
    blockStartWaitMs = 0,
  } = {}) {
    if (!this.connected || (!this.calibrated && (validateOnly || recenterOnly || !this.canCalibrate)))
      return { ok: false, error: "connect and complete base calibration first" };
    if (this._calibrating) return { ok: false, error: "calibration already running" };
    if (document.fullscreenElement !== document.documentElement) {
      try { await document.documentElement.requestFullscreen(); }
      catch { return { ok: false, error: "fullscreen permission is required for accurate mapping" }; }
    }
    const geometry = this.geometry();
    if (this._closed) return { ok: false, error: "eye client is closed" };
    if (!geometry.geometryValid) return { ok: false, error: geometry.reason };
    this._calibrating = true;
    this._calibrationAborted = false;
    this._clear(this._lastGazeT, "calibrating");
    const signature = () => [window.screenX, window.screenY, window.innerWidth, window.innerHeight, window.visualViewport?.scale ?? 1].join();
    const initialGeometry = signature();
    const check = () => {
      if (this._calibrationAborted || !this.connected || !this.geometry().geometryValid || signature() !== initialGeometry)
        throw new Error("calibration cancelled: connection or display geometry changed");
    };
    const overlay = document.createElement("div");
    this._calibrationOverlay = overlay;
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:rgba(8,8,12,.92);cursor:none;" +
      "font:600 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.2em;color:#fff";
    const dot = document.createElement("div");
    dot.style.cssText =
      "position:absolute;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;" +
      `background:#fff;box-shadow:0 0 24px #fff8;transition:left ${glideMs}ms cubic-bezier(.4,0,.2,1),top ${glideMs}ms cubic-bezier(.4,0,.2,1),transform ${sampleMs}ms linear`;
    const text = document.createElement("div");
    text.textContent = label;
    text.style.cssText = "position:absolute;left:50%;bottom:24px;transform:translateX(-50%);width:90%;text-align:center;line-height:1.6;opacity:.8";
    overlay.append(dot, text);
    document.body.append(overlay);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const place = (px, py) => {
      dot.style.left = `${px}px`;
      dot.style.top = `${py}px`;
    };
    const request = (msg, type, matches = () => true) => new Promise((resolve, reject) => {
      const off = this.on("message", reply => {
        if (reply.type !== type || !matches(reply)) return;
        clearTimeout(timer);
        off();
        resolve(reply);
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error("no reply from eye serve; check the connection and try again"));
      }, 3000);
      this.send(msg);
    });
    const progress = (index, attempt, reply = null) => {
      const detail = { index, total: points.length, attempt, samples: reply?.samples ?? 0,
        coverage: reply?.coverage ?? null, validateOnly, done: false };
      this._fire("calib_progress", detail);
      text.textContent = `${pointLabels[index] || label} · ${index + 1}/${points.length} · ${attempt > 1 ? `RETRY ${attempt - 1}/2` : "HOLD YOUR GAZE"}`;
    };
    try {
      this.send({ type: "calib_begin", validateOnly, recenterOnly });
      place(window.innerWidth / 2, window.innerHeight / 2);
      await wait(600);
      for (const [index, [fx, fy]] of points.entries()) {
        const px = fx * window.innerWidth;
        const py = fy * window.innerHeight;
        place(px, py);
        if (pointMetadata[index]?.blockStart && blockStartWaitMs > 0) {
          text.textContent = pointLabels[index] || label;
          await wait(blockStartWaitMs);
          check();
        }
        for (let attempt = 1; attempt <= 3; attempt++) {
          progress(index, attempt);
          dot.style.transform = "scale(1)";
          await wait(glideMs + settleMs);
          check();
          const s = this.toScreen(px, py);
          this.send({ type: "calib_target", x: s.x, y: s.y, retry: attempt > 1, ...(pointMetadata[index] ? {episode: pointMetadata[index]} : {}) });
          dot.style.transform = "scale(.35)";
          await wait(sampleMs);
          check();
          const requestId = this._nextId++;
          const reply = await request({ type: "calib_target_end", validateOnly, requestId },
            "calib_point", m => m.requestId === requestId);
          check();
          const usable = reply.ok && reply.samples >= 5 && (!validateOnly || reply.coverage >= 0.8);
          if (usable) break;
          const cause = Object.entries(reply.rejected ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0];
          const guidance = cause === "head_pose_outside_calibration"
            ? this._guidance || "return to your calibrated head position; if this keeps happening, run a fresh base calibration"
            : (cause === "blink" || cause === "blink_or_settling") ? "keep your eyes open while the dot shrinks"
            : "keep your face visible and check the camera";
          if (attempt === 3) throw new Error(`target ${index + 1}/${points.length} still has too few usable frames after 3 attempts (${reply.samples} samples, ${Math.round((reply.coverage ?? 0) * 100)}% coverage); ${guidance}`);
          text.textContent = `RETRYING THIS DOT · ${guidance}`;
          await wait(1200);
        }
      }
      check();
      return await request({ type: "calib_finish", validateOnly, ...(recenterOnly ? { recenterOnly: true } : {}) }, "calib_result", m => !m.reset);
    } catch (error) {
      if (this.connected) {
        this.send({ type: "calib_target_end" });
        this.send({ type: "calib_begin" }); // discard incomplete points without applying a correction
      }
      return { ok: false, error: error.message };
    } finally {
      this._calibrating = false;
      this._fire("calib_progress", { done: true, validateOnly });
      overlay.remove();
      this._calibrationOverlay = null;
      this._status();
    }
  }

  validate() {
    // Fresh positions, not the five correction-fit targets. No mapping is fit.
    return this.calibrate({ validateOnly: true, label: "VALIDATION: LOOK HERE", points: [
      [0.2, 0.25], [0.5, 0.2], [0.8, 0.25], [0.75, 0.5], [0.8, 0.8],
      [0.5, 0.75], [0.2, 0.8], [0.25, 0.5], [0.5, 0.55],
    ] });
  }

  resetCalibration() {
    this.send({ type: "calib_reset" });
  }
}
