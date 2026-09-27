import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const code = await readFile(new URL('../src/eye/web/dom-targets.js', import.meta.url), 'utf8');
const { rankTargets, GazeDOMTargets } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const target = (left, right) => ({ rect: { left, right, top: 0, bottom: 300 } });

test('uncertainty abstains between close controls; isolated controls remain selectable', () => {
  const a = target(0, 100), b = target(140, 240);
  assert.equal(rankTargets([a, b], { x: 90, y: 50, radius: 60 }), null);
  assert.deepEqual(rankTargets([a, b], { x: 20, y: 50, radius: 60 }).rect, a.rect);
  assert.equal(rankTargets([a], { x: 500, y: 50, radius: 60 }), null);
  assert.equal(rankTargets([a], { x: 20, y: 50, radius: NaN }), null);
});

function setup() {
  const eyeEvents = new Map(), listeners = new Map();
  const events = { addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); } };
  let observer;
  const win = { ...events, innerWidth: 1000, innerHeight: 800, CSS: { escape: s => s }, getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }), MutationObserver: class { constructor(fn) { observer = fn; } observe() {} disconnect() { this.disconnected = true; } } };
  const elements = [];
  const doc = { ...events, defaultView: win, body: { appendChild() {} }, createElement: () => ({ style: {}, setAttribute() {}, contains: () => false, remove() {} }), contains: el => elements.includes(el), querySelectorAll: selector => selector.startsWith('#') ? elements.filter(el => `#${el.id}` === selector) : elements,
    elementFromPoint: (x, y) => elements.find(el => { const r = el.getBoundingClientRect(); return x >= r.left && x < r.right && y >= r.top && y < r.bottom; }) };
  const eye = { uncertaintyDeg: 1, ptPerDeg: 30, on(name, fn) { eyeEvents.set(name, fn); return () => eyeEvents.delete(name); } };
  const add = (id, left, right) => {
    const el = { id, ownerDocument: doc, localName: 'button', textContent: id, getAttribute: () => null, closest: () => null, contains: other => other === el, getBoundingClientRect: () => ({ left, right, top: 0, bottom: 300 }), focus: () => el.focused = true, click: () => { throw Error('must never click'); } };
    elements.push(el); return el;
  };
  const adapter = new GazeDOMTargets(eye, { document: doc });
  const gaze = (x, t) => eyeEvents.get('gaze')({ x, y: 100, t });
  const settle = x => { gaze(x, 100); gaze(x, 300); gaze(x, 500); };
  return { adapter, eye, elements, doc, add, gaze, settle, eyeEvents, listeners, mutate: record => observer([record]) };
}

test('stable gaze requires explicit confirmation; emits semantic selector and focuses without click', () => {
  const s = setup(); const el = s.add('read', 0, 400); const selected = [];
  s.adapter.on('select', value => selected.push(value));
  s.gaze(100, 100); assert.equal(s.adapter.confirm(), false);
  s.gaze(100, 300); s.gaze(100, 500);
  assert.equal(selected.length, 0);
  assert.equal(s.adapter.overlay.style.pointerEvents, 'none');
  const result = s.adapter.confirm();
  assert.equal(result.selector, '#read'); assert.equal(result.role, 'button');
  assert.equal(el.focused, true); assert.equal(selected.length, 1);
  assert.equal(s.adapter.confirm(), false);
  s.adapter.destroy();
});

test('loss, scrolling, resize, and document mutation clear and disarm the target', () => {
  const s = setup(); s.add('read', 0, 400);
  for (const invalidate of [() => s.eyeEvents.get('lost')(), () => s.listeners.get('scroll')(), () => s.listeners.get('resize')(), () => s.mutate({ target: {} })]) {
    s.settle(100); assert.equal(s.adapter.candidate.stable, true);
    invalidate(); assert.equal(s.adapter.confirm(), false); assert.equal(s.adapter.overlay.style.display, 'none');
  }
  s.adapter.destroy(); assert.equal(s.eyeEvents.size, 0); assert.equal(s.listeners.size, 0);
});

test('stale gaze, sample gaps, and changed layout cannot confirm', () => {
  const s = setup(); const el = s.add('read', 0, 400);
  s.settle(100); s.adapter.candidate.receivedAt = Date.now() - 1000;
  assert.equal(s.adapter.confirm(), false);
  s.gaze(100, 1000); assert.equal(s.adapter.candidate.stable, false);
  s.settle(100); el.getBoundingClientRect = () => ({ left: 600, right: 900, top: 0, bottom: 300 });
  assert.equal(s.adapter.confirm(), false);
  s.adapter.destroy();
});

test('disabled and covered controls are excluded, invalid uncertainty abstains', () => {
  const s = setup(); const el = s.add('read', 0, 400);
  el.disabled = true; s.settle(100); assert.equal(s.adapter.candidate, null);
  el.disabled = false; s.doc.elementFromPoint = () => null;
  s.settle(100); assert.equal(s.adapter.candidate, null);
  s.doc.elementFromPoint = () => el; s.eye.uncertaintyDeg = NaN;
  s.settle(100); assert.equal(s.adapter.candidate, null);
  s.adapter.destroy();
});

test('Alt+Enter confirms only after stability; repeats never act', () => {
  const s = setup(); s.add('read', 0, 400); let prevented = false;
  s.settle(100);
  s.listeners.get('keydown')({ altKey: true, key: 'Enter', repeat: true });
  assert.ok(s.adapter.candidate);
  s.listeners.get('keydown')({ altKey: true, key: 'Enter', repeat: false, preventDefault: () => prevented = true });
  assert.equal(prevented, true); assert.equal(s.adapter.candidate, null);
  s.adapter.destroy();
});

 test('unknown error scale and nonfinite gaze never become zero-uncertainty targets', () => {
  const s = setup(); s.add('read', 0, 400);
  s.eye.uncertaintyDeg = null; s.eye.accuracyDeg = null;
  s.settle(100); assert.equal(s.adapter.candidate, null);
  s.eye.uncertaintyDeg = 1; s.eye.ptPerDeg = 0;
  s.settle(100); assert.equal(s.adapter.candidate, null);
  s.eye.ptPerDeg = 30; s.settle(NaN); assert.equal(s.adapter.candidate, null);
  s.adapter.destroy();
});

test('outside-viewport gaze cannot select an edge control', () => {
  const s=setup(); s.add('edge',0,400);
  s.settle(-1); assert.equal(s.adapter.candidate,null);
  s.eyeEvents.get('gaze')({x:100,y:-1,t:600}); assert.equal(s.adapter.candidate,null);
  s.eyeEvents.get('gaze')({x:1000,y:100,t:700}); assert.equal(s.adapter.candidate,null);
  s.adapter.destroy();
});

test('dense targets require explicit Alt+Space, then numbered focus without clicking', () => {
  const s = setup(); s.add('one', 0, 120); const second = s.add('two', 140, 240);
  const selections = [], choices = [];
  s.adapter.on('select', value => selections.push(value));
  s.adapter.on('choices', value => choices.push(value));
  s.settle(125);
  assert.equal(s.adapter.candidate, null);
  assert.equal(s.adapter.choices, undefined);
  let prevented = 0;
  s.listeners.get('keydown')({ altKey: true, code: 'Space', key: ' ', preventDefault: () => prevented++ });
  assert.equal(prevented, 1);
  assert.equal(s.adapter.choices.length, 2);
  assert.match(s.adapter.panel.textContent, /1\. one\n2\. two/);
  assert.equal(choices[0][1].selector, '#two');
  assert.equal(s.adapter.confirm(), false);
  s.gaze(160, 600); // Looking toward the panel must not reorder the snapshot.
  s.listeners.get('keydown')({ key: '2', preventDefault: () => prevented++ });
  assert.equal(prevented, 2);
  assert.equal(second.focused, true);
  assert.equal(selections[0].selector, '#two');
  assert.equal(selections[0].source, 'gaze-disambiguation');
  assert.equal(s.adapter.panel.style.display, 'none');
  assert.equal(choices.at(-1), null);
  s.adapter.destroy();
});

test('choices are capped and Escape dismisses without focus or selection', () => {
  const s = setup();
  for (let i = 0; i < 12; i++) s.add(`item${i}`, i * 20, i * 20 + 10);
  s.eye.uncertaintyDeg = 10;
  s.settle(100);
  assert.equal(s.adapter.openChoices(), true);
  assert.equal(s.adapter.choices.length, 9);
  assert.match(s.adapter.panel.textContent, /More controls nearby/);
  assert.equal(s.adapter.choose(9), false);
  s.listeners.get('keydown')({ key: 'Escape', preventDefault() {} });
  assert.equal(s.adapter.choices, null);
  assert.ok(s.elements.every(el => !el.focused));
  s.adapter.destroy();
});

test('loss, stale gaze, mutation, and scroll invalidate numbered selections', () => {
  const s = setup(); s.add('one', 0, 120); s.add('two', 140, 240);
  for (const invalidate of [
    () => s.eyeEvents.get('lost')(),
    () => { s.adapter.latestGaze.receivedAt = Date.now() - 1000; },
    () => s.mutate({ target: {} }),
    () => s.listeners.get('scroll')(),
    () => s.eyeEvents.get('status')({ valid: false }),
  ]) {
    s.settle(125); s.adapter.openChoices(); invalidate();
    assert.equal(s.adapter.choose(0), false);
    assert.ok(s.elements.every(el => !el.focused));
  }
  s.adapter.destroy();
});

test('number choice rechecks changed geometry, labels, disabled state, and occlusion synchronously', () => {
  for (const change of [
    (s, el) => { el.getBoundingClientRect = () => ({ left: 1, right: 121, top: 0, bottom: 300 }); },
    (s, el) => { el.textContent = 'different action'; },
    (s, el) => { el.disabled = true; },
    s => { s.doc.elementFromPoint = () => null; },
    s => { s.elements.shift(); },
  ]) {
    const s = setup(); const el = s.add('one', 0, 120); s.add('two', 140, 240);
    s.settle(125); s.adapter.openChoices(); change(s, el);
    assert.equal(s.adapter.choose(0), false);
    assert.equal(el.focused, undefined);
    s.adapter.destroy();
  }
});

test('panel UI mutations do not dismiss choices; repeated shortcuts never reopen or select', () => {
  const s = setup(); s.add('one', 0, 120); s.add('two', 140, 240);
  s.settle(125); s.adapter.openChoices();
  s.mutate({ target: s.adapter.panel });
  s.mutate({ target: s.doc.body, type: 'childList', addedNodes: [s.adapter.panel], removedNodes: [] });
  assert.equal(s.adapter.choices.length, 2);
  s.listeners.get('keydown')({ key: '1', repeat: true });
  assert.ok(s.elements.every(el => !el.focused));
  s.adapter.destroy();
});

test('form values and textarea default content never leak into choice descriptions', () => {
  const s = setup(); const el = s.add('secret', 0, 400);
  el.localName = 'textarea'; el.textContent = 'private default'; el.value = 'private live value';
  s.settle(100); s.adapter.openChoices();
  assert.equal(s.adapter.choices[0].descriptor.label, '');
  assert.doesNotMatch(s.adapter.panel.textContent, /private/);
  assert.equal(s.adapter.choose(0).label, '');
  s.adapter.destroy();
});
