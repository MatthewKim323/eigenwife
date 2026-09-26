// eye-client.js: gaze from `eye serve` into a web page. No dependencies.
//
//   import { EyeClient } from "http://127.0.0.1:8765/eye-client.js";
//   const eye = new EyeClient();                 // tracks every [data-gaze] element
//   eye.on("fixation", ({ el, ms }) => ...);     // a fixation landed on an element
//   eye.stats();                                 // { photo_1: { dwellMs, visits, ... }, ... }
//   await eye.calibrate();                       // 5 "look here" dots, fixes drift
//
// The server speaks macOS screen points. Browsers at 100% zoom use the same
// units for window.screenX / screenY, so screen -> page is a subtraction of the
// window origin and the browser chrome. Fullscreen / kiosk makes that exact.
// Anything left over (a bottom toolbar, zoom) is absorbed by `calibrate()`,
// because its targets go through the same conversion.

const DEFAULT_URL = "ws://127.0.0.1:8765/ws";

export class EyeClient {
  constructor({ url = DEFAULT_URL, selector = "[data-gaze]", snapDeg = 2.0, root = document } = {}) {
    this.url = url;
    this.selector = selector;
    this.snapDeg = snapDeg;
    this.root = root;
    this.handlers = {};
    this.display = null;
    this.ptPerDeg = 49;
    this.connected = false;
    this.face = false;
    this.calibrated = false;
    this.corrected = false;
    this.gaze = null; // latest { x, y } in page (client) px, or null
    this.current = null; // element under the current fixation
    this._stats = new Map(); // key -> { dwellMs, visits, fixations, longestMs, firstAt, lastAt }
    this._lastGazeT = null;
    this._lastFixEl = null;
    this._fixEl = new Map(); // fixation id -> element
    this._pending = [];
    this._closed = false;
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
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      for (const m of this._pending.splice(0)) ws.send(m);
      this._status();
    };
    ws.onclose = () => {
      this.connected = false;
      this.face = false;
      this._status();
      if (!this._closed) setTimeout(() => this.connect(), 1000);
    };
    ws.onmessage = (e) => this._message(JSON.parse(e.data));
  }

  close() {
    this._closed = true;
    this.ws?.close();
  }

  send(msg) {
    const text = JSON.stringify(msg);
    if (this.connected) this.ws.send(text);
    else this._pending.push(text);
  }

  _status() {
    this._fire("status", {
      connected: this.connected,
      face: this.face,
      calibrated: this.calibrated,
      corrected: this.corrected,
      accuracyDeg: this.accuracyDeg,
    });
  }

  // coordinates
  chrome() {
    // Browser UI sits above the page; assume none at the sides or bottom.
    return { left: (window.outerWidth - window.innerWidth) / 2, top: window.outerHeight - window.innerHeight };
  }

  toPage(x, y) {
    const c = this.chrome();
    return { x: x - window.screenX - c.left, y: y - window.screenY - c.top };
  }

  toScreen(px, py) {
    const c = this.chrome();
    return { x: px + window.screenX + c.left, y: py + window.screenY + c.top };
  }

  hit(px, py) {
    const snap = this.snapDeg * this.ptPerDeg;
    let best = null;
    let bestD = Infinity;
    for (const el of this.root.querySelectorAll(this.selector)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const dx = Math.max(r.left - px, 0, px - r.right);
      const dy = Math.max(r.top - py, 0, py - r.bottom);
      const d = Math.hypot(dx, dy);
      // Inside beats near; among overlapping, the smaller (more specific) one wins.
      const score = d === 0 ? -1 / (r.width * r.height) : d;
      if (d <= snap && score < bestD) {
        best = el;
        bestD = score;
      }
    }
    return best;
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
        this.ptPerDeg = m.display.ptPerDeg;
        this.calibrated = m.calibrated;
        this.corrected = m.corrected;
        this.accuracyDeg = m.accuracyDeg;
        this._status();
        break;
      case "face":
        this.face = m.present;
        this._status();
        break;
      case "gaze":
        this._gaze(m);
        break;
      case "fixation_start": {
        const p = this.toPage(m.x, m.y);
        const el = this.hit(p.x, p.y);
        this._fixEl.set(m.id, el);
        if (el) {
          const s = this._stat(el);
          if (s) {
            s.fixations += 1;
            if (el !== this._lastFixEl) s.visits += 1;
            s.firstAt ??= m.t;
            s.lastAt = m.t;
          }
        }
        this._lastFixEl = el;
        this._fire("fixation", { id: m.id, el, key: el && this.key(el), x: p.x, y: p.y, t: m.t });
        break;
      }
      case "fixation_end": {
        const el = this._fixEl.get(m.id) ?? null;
        this._fixEl.delete(m.id);
        const s = el && this._stat(el);
        if (s) s.longestMs = Math.max(s.longestMs, m.ms);
        const p = this.toPage(m.x, m.y);
        this._fire("fixation_end", { id: m.id, el, key: el && this.key(el), ms: m.ms, x: p.x, y: p.y, t: m.t });
        break;
      }
      case "calib_result":
        if (m.corrected !== undefined) this.corrected = m.corrected;
        this._fire("calib_result", m);
        this._status();
        break;
    }
    this._fire("message", m);
  }

  _gaze(m) {
    const p = this.toPage(m.x, m.y);
    this.gaze = p;
    const el = m.blink ? this.current : this.hit(p.x, p.y);
    if (!m.blink && this._lastGazeT !== null && this.current) {
      const s = this._stat(this.current);
      // Cap the step so a stall (face lost, tab hidden) doesn't count as dwell.
      if (s) s.dwellMs += Math.min(m.t - this._lastGazeT, 100);
    }
    this._lastGazeT = m.t;
    if (el !== this.current) {
      if (this.current) this._fire("leave", { el: this.current, key: this.key(this.current) });
      this.current = el;
      if (el) this._fire("enter", { el, key: this.key(el) });
    }
    this._fire("gaze", { x: p.x, y: p.y, blink: m.blink, el, key: el && this.key(el), fix: m.fix, t: m.t });
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
  } = {}) {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:rgba(8,8,12,.92);cursor:none;" +
      "font:600 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.2em;color:#fff";
    const dot = document.createElement("div");
    dot.style.cssText =
      "position:absolute;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;" +
      `background:#fff;box-shadow:0 0 24px #fff8;transition:left ${glideMs}ms cubic-bezier(.4,0,.2,1),top ${glideMs}ms cubic-bezier(.4,0,.2,1),transform ${sampleMs}ms linear`;
    const text = document.createElement("div");
    text.textContent = label;
    text.style.cssText = "position:absolute;transform:translate(-50%,28px);white-space:nowrap;opacity:.7";
    overlay.append(dot, text);
    document.body.append(overlay);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const place = (px, py) => {
      dot.style.left = text.style.left = `${px}px`;
      dot.style.top = text.style.top = `${py}px`;
    };
    const result = new Promise((resolve) => {
      const off = this.on("calib_result", (m) => {
        if (m.reset) return;
        off();
        resolve(m);
      });
    });
    try {
      this.send({ type: "calib_begin" });
      place(window.innerWidth / 2, window.innerHeight / 2);
      await wait(600);
      for (const [fx, fy] of points) {
        const px = fx * window.innerWidth;
        const py = fy * window.innerHeight;
        dot.style.transform = "scale(1)";
        place(px, py);
        await wait(glideMs + settleMs);
        const s = this.toScreen(px, py);
        this.send({ type: "calib_target", x: s.x, y: s.y });
        dot.style.transform = "scale(.35)";
        await wait(sampleMs);
        this.send({ type: "calib_target_end" });
      }
      this.send({ type: "calib_finish" });
      return await Promise.race([result, wait(3000).then(() => ({ ok: false, error: "no reply from eye serve" }))]);
    } finally {
      overlay.remove();
    }
  }

  resetCalibration() {
    this.send({ type: "calib_reset" });
  }
}
