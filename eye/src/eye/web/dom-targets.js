// DOM intent adapter for EyeClient. Coordinates must already be validated viewport pixels.
// Selection emits a descriptor and focuses the target; it NEVER invokes click().
export const TARGET_SELECTOR = 'a[href],button,input:not([type="hidden"]),select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[tabindex]:not([tabindex="-1"])';

const distance = (x, y, r) => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));

// A conservative uncertainty-disc test: a neighboring target inside the same error
// radius prevents assignment, even when the central estimate hits a target exactly.
export function nearbyTargets(targets, { x, y, radius }) {
  if (![x, y, radius].every(Number.isFinite) || radius < 0) return [];
  return targets.map(target => ({ ...target, distance: distance(x, y, target.rect) }))
    .filter(target => target.distance <= Math.max(8, radius))
    .sort((a, b) => a.distance - b.distance);
}

export function rankTargets(targets, { x, y, radius }) {
  if (![x, y, radius].every(Number.isFinite) || radius < 0) return null;
  const ranked = nearbyTargets(targets, { x, y, radius });
  if (!ranked.length || ranked.length > 1 && ranked[1].distance <= ranked[0].distance + radius) return null;
  return ranked[0];
}

export function describeElement(el) {
  const doc = el.ownerDocument;
  const escape = value => doc.defaultView.CSS.escape(value);
  let selector;
  if (el.id && doc.querySelectorAll(`#${escape(el.id)}`).length === 1) selector = `#${escape(el.id)}`;
  else {
    const parts = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const tag = node.localName;
      const siblings = node.parentElement ? [...node.parentElement.children].filter(sibling => sibling.localName === tag) : [node];
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(node) + 1})`);
      if (node === doc.documentElement) break;
    }
    selector = parts.join(' > ');
  }
  return {
    selector,
    tag: el.localName,
    role: el.getAttribute('role') || ({ button: 'button', a: 'link', textarea: 'textbox', select: 'combobox', input: 'input' }[el.localName] ?? null),
    // Never expose form values: descriptors can be consumed by browser agents.
    label: (el.getAttribute('aria-label') || el.labels?.[0]?.textContent || (!['input', 'textarea', 'select'].includes(el.localName) && el.textContent) || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 160),
  };
}

export class GazeDOMTargets {
  constructor(eye, { document: doc = globalThis.document, stableMs = 350, staleMs = 450, focusOnSelect = true } = {}) {
    this.eye = eye;
    this.doc = doc;
    this.win = doc.defaultView;
    this.stableMs = stableMs;
    this.staleMs = staleMs;
    this.focusOnSelect = focusOnSelect;
    this.handlers = new Map();
    this.candidate = null;
    this.overlay = doc.createElement('div');
    this.overlay.setAttribute('aria-hidden', 'true');
    this.overlay.setAttribute('data-eye-ui', '');
    this.overlay.setAttribute('data-eye-overlay', '');
    Object.assign(this.overlay.style, { position: 'fixed', pointerEvents: 'none', zIndex: '2147483647', display: 'none', border: '3px solid #fbbf24', borderRadius: '8px', boxSizing: 'border-box', boxShadow: '0 0 0 4px #fbbf2422' });
    doc.body.appendChild(this.overlay);
    this.panel = doc.createElement('div');
    this.panel.setAttribute('data-eye-ui', '');
    this.panel.setAttribute('role', 'status');
    Object.assign(this.panel.style, { position: 'fixed', right: '16px', top: '16px', zIndex: '2147483647', display: 'none', pointerEvents: 'none', background: '#111827', color: '#fff', padding: '16px', borderRadius: '12px', font: '16px/1.6 system-ui', maxWidth: '360px', whiteSpace: 'pre-wrap', boxShadow: '0 4px 24px #0006' });
    doc.body.appendChild(this.panel);
    this.clear = () => this._clear();
    this.keydown = event => {
      if (event.repeat) return;
      if (event.altKey && (event.code === 'Space' || event.key === ' ')) {
        if (this.openChoices()) event.preventDefault();
        return;
      }
      if (this.choices && event.key === 'Escape') { this._dismissChoices(); event.preventDefault(); return; }
      if (this.choices && !event.altKey && !event.ctrlKey && !event.metaKey && /^[1-9]$/.test(event.key)) {
        // Consume the choice key even if the target has become invalid.
        event.preventDefault();
        this.choose(Number(event.key) - 1);
        return;
      }
      if (event.altKey && event.key === 'Enter' && !event.repeat && this.confirm()) event.preventDefault();
    };
    this.unsubscribe = [eye.on('gaze', gaze => this.update(gaze)), eye.on('lost', this.clear), eye.on('status', status => { if (!status.valid) this.clear(); })];
    this.win.addEventListener('scroll', this.clear, true);
    this.win.addEventListener('resize', this.clear);
    this.win.addEventListener('blur', this.clear);
    doc.addEventListener('visibilitychange', this.clear);
    doc.addEventListener('keydown', this.keydown);
    this.observer = new this.win.MutationObserver(records => {
      const ownUI = node => node === this.overlay || node === this.panel || node.parentElement?.closest('[data-eye-ui]') || node.closest?.('[data-eye-ui]');
      if (records.some(record => !ownUI(record.target) && !(record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].length && [...record.addedNodes, ...record.removedNodes].every(ownUI)))) this.clear();
    });
    this.observer.observe(doc.body, { childList: true, subtree: true, attributes: true, characterData: true });
  }

  on(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  _emit(type, detail) { for (const handler of this.handlers.get(type) ?? []) handler(detail); }

  _targets() {
    const elements = [...this.doc.querySelectorAll(TARGET_SELECTOR)].filter(el => {
      const style = this.win.getComputedStyle(el);
      return (typeof el.checkVisibility !== 'function' || el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) && !el.disabled && !el.closest('[inert],[aria-hidden="true"],[data-eye-ui]') && el.getAttribute('aria-disabled') !== 'true' && style.visibility === 'visible' && style.display !== 'none' && Number(style.opacity) !== 0;
    });
    const actionable = new Set(elements);
    const wrappers = new Set();
    for (const el of elements) {
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        if (actionable.has(parent)) wrappers.add(parent);
      }
    }
    return elements.flatMap(el => {
      // Prefer the innermost actionable element when wrappers are also focusable.
      if (wrappers.has(el)) return [];
      const rect = el.getBoundingClientRect();
      const visible = { left: Math.max(0, rect.left), top: Math.max(0, rect.top), right: Math.min(this.win.innerWidth, rect.right), bottom: Math.min(this.win.innerHeight, rect.bottom) };
      if (visible.right <= visible.left || visible.bottom <= visible.top) return [];
      const hit = this.doc.elementFromPoint((visible.left + visible.right) / 2, (visible.top + visible.bottom) / 2);
      if (!hit || !el.contains(hit)) return []; // Occluded controls cannot be selected.
      return [{ el, rect: visible }];
    });
  }

  update(gaze) {
    const degrees = this.eye.uncertaintyDeg ?? this.eye.accuracyDeg;
    const radius = Number.isFinite(degrees) && degrees >= 0 && Number.isFinite(this.eye.ptPerDeg) && this.eye.ptPerDeg > 0 ? degrees * this.eye.ptPerDeg : NaN;
    if (![gaze.x, gaze.y, radius].every(Number.isFinite) || gaze.x < 0 || gaze.y < 0 || gaze.x >= this.win.innerWidth || gaze.y >= this.win.innerHeight) return this._clear();
    if (gaze.blink || !Number.isFinite(gaze.t)) return this._clear();
    const now = Date.now();
    if (this.latestGaze && (gaze.t <= this.latestGaze.t || gaze.t - this.latestGaze.t > 250)) this._clear();
    this.latestGaze = { ...gaze, radius, receivedAt: now };
    clearTimeout(this.timer);
    this.timer = setTimeout(this.clear, this.staleMs);
    this.timer.unref?.();
    const winner = rankTargets(this._targets(), { ...gaze, radius });
    if (!winner) return this._clearCandidate();
    const previous = this.candidate;
    if (!previous || previous.el !== winner.el || gaze.t <= previous.lastT || gaze.t - previous.lastT > 250) {
      this.candidate = { ...winner, since: gaze.t, stable: false };
    }
    Object.assign(this.candidate, winner, { gaze: { ...gaze, radius }, lastT: gaze.t, receivedAt: now });
    this.candidate.stable = gaze.t - this.candidate.since >= this.stableMs;
    const r = winner.rect;
    Object.assign(this.overlay.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px`, borderColor: this.candidate.stable ? '#6ee7b7' : '#fbbf24' });
    // Emit only semantic changes: text updates in consumers otherwise cause a
    // mutation/invalidation feedback loop on every camera frame.
    if (!previous || previous.el !== winner.el || this.lastStable !== this.candidate.stable) {
      this.lastStable = this.candidate.stable;
      this._emit('candidate', { element: winner.el, ...describeElement(winner.el), stable: this.candidate.stable, uncertaintyPx: radius });
    }
  }

  openChoices() {
    const gaze = this.latestGaze;
    if (!gaze || Date.now() - gaze.receivedAt >= this.staleMs) { this._clear(); return false; }
    const nearby = nearbyTargets(this._targets(), gaze);
    if (!nearby.length) { this._dismissChoices(); return false; }
    this.choices = nearby.slice(0, 9).map(target => ({ ...target, descriptor: describeElement(target.el) }));
    this.choiceGaze = { ...gaze };
    this.panel.textContent = `Choose a nearby control (1–${this.choices.length}); Escape cancels.\n` + this.choices.map((target, i) => `${i + 1}. ${target.descriptor.label || target.descriptor.role || target.descriptor.tag}`).join('\n') + (nearby.length > 9 ? '\nMore controls nearby: look closer to narrow the choices.' : '');
    this.panel.style.display = 'block';
    this._emit('choices', this.choices.map(({ descriptor }, i) => ({ ...descriptor, number: i + 1 })));
    return true;
  }

  choose(index) {
    const choice = this.choices?.[index];
    if (!Number.isInteger(index) || !choice) return false;
    if (!this.latestGaze || Date.now() - this.latestGaze.receivedAt >= this.staleMs || !this.doc.contains(choice.el)) { this._clear(); return false; }
    const current = nearbyTargets(this._targets(), this.choiceGaze).find(target => target.el === choice.el);
    const descriptor = describeElement(choice.el);
    if (!current || ['left', 'right', 'top', 'bottom'].some(key => current.rect[key] !== choice.rect[key]) || JSON.stringify(descriptor) !== JSON.stringify(choice.descriptor)) { this._clear(); return false; }
    const detail = { element: choice.el, ...descriptor, uncertaintyPx: this.choiceGaze.radius, source: 'gaze-disambiguation' };
    this._clear();
    if (this.focusOnSelect) choice.el.focus({ preventScroll: true });
    this._emit('select', detail);
    return detail;
  }

  _dismissChoices() {
    const hadChoices = !!this.choices;
    this.choices = null;
    this.choiceGaze = null;
    this.panel.style.display = 'none';
    this.panel.textContent = '';
    if (hadChoices) this._emit('choices', null);
  }

  confirm() {
    if (this.choices) return false;
    const candidate = this.candidate;
    if (!candidate?.stable || Date.now() - candidate.receivedAt >= this.staleMs || !this.doc.contains(candidate.el)) return false;
    const current = rankTargets(this._targets(), candidate.gaze);
    if (current?.el !== candidate.el) { this._clear(); return false; }
    const detail = { element: candidate.el, ...describeElement(candidate.el), uncertaintyPx: candidate.gaze.radius, source: 'gaze-confirm' };
    // Re-arm only after a new stable gaze interval; keyboard repeat cannot confirm twice.
    this._clear();
    if (this.focusOnSelect) candidate.el.focus({ preventScroll: true });
    this._emit('select', detail);
    return detail;
  }

  _clear() {
    clearTimeout(this.timer);
    this.latestGaze = null;
    this._dismissChoices();
    this._clearCandidate();
  }

  _clearCandidate() {
    const hadCandidate = !!this.candidate;
    this.candidate = null;
    this.lastStable = false;
    this.overlay.style.display = 'none';
    if (hadCandidate) this._emit('candidate', null);
  }

  destroy() {
    this.clear();
    this.observer.disconnect();
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.win.removeEventListener('scroll', this.clear, true);
    this.win.removeEventListener('resize', this.clear);
    this.win.removeEventListener('blur', this.clear);
    this.doc.removeEventListener('visibilitychange', this.clear);
    this.doc.removeEventListener('keydown', this.keydown);
    this.overlay.remove();
    this.panel.remove();
    this.handlers.clear();
  }
}
