import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const code = await readFile(new URL('../src/eye/web/eye-client.js', import.meta.url), 'utf8');
const { EyeClient } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

function setup(options = {}) {
  const listeners = new Map();
  const events = { addEventListener: (k, f) => listeners.set(k, f), removeEventListener() {} };
  const elements = [];
  const documentElement = { requestFullscreen: async () => { document.fullscreenElement = documentElement; } };
  globalThis.window = { ...events, innerWidth: 1000, innerHeight: 800, screenX: 0, screenY: 0,
    devicePixelRatio: 2,
    screen: { width: 1000, height: 800, availWidth: 1000, availHeight: 800, availLeft: 0, availTop: 0 },
    visualViewport: { ...events, scale: 1 }, getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }) };
  globalThis.document = { ...events, documentElement, fullscreenElement: documentElement,
    contains: el => elements.includes(el), querySelectorAll: () => elements,
    elementFromPoint: (x, y) => [...elements].reverse().find(el => {
      const r = el.getBoundingClientRect(); return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
    }) ?? null };
  globalThis.WebSocket = class { send() {} close() {} };
  const client = new EyeClient(options);
  client.connected = true;
  client._message({ type: 'hello', display: { x: 0, y: 0, w: 1000, h: 800, scale: 2, ptPerDeg: 49 }, calibrated: true, face: true, accuracyDeg: 0.1 });
  const region = (key, left, right) => {
    const el = { dataset: { gaze: key }, closest: () => el, contains: other => other === el,
      getBoundingClientRect: () => ({ left, right, top: 0, bottom: 800, width: right-left, height: 800 }) };
    elements.push(el); return el;
  };
  const gaze = (x, t, extra = {}) => client._message({ type: 'gaze', x, y: 400, t, valid: true, ...extra });
  return { client, region, gaze, elements };
}

test('optional smoothing drives cursor and hit testing together while messages stay raw', () => {
  let resets = 0;
  const smoother = {reset() {resets++;}, update: p => ({x:100,y:p.y})};
  const {client, region, gaze} = setup({gazeSmoother:smoother});
  const left = region('left', 0, 300);
  region('right', 700, 1000);
  let output, message;
  client.on('gaze', value => output = value);
  client.on('message', value => message = value);
  gaze(900, 1000);
  assert.equal(output.x, 100);
  assert.equal(output.el, left);
  assert.equal(output.raw.x, 900);
  assert.equal(message.x, 900);
  gaze(850, 1300); // Irregular 5 Hz delivery must not repeatedly erase smoothing.
  assert.equal(resets, 0);
  gaze(850, 1800);
  assert.equal(resets, 1);
  gaze(850, 1900, {valid:false});
  assert.equal(resets, 2);
  client.setGazeSmoother(null);
  gaze(900, 2000);
  assert.equal(output.x, 900);
  client.close();
});

test('mapping accepts known fullscreen geometry and rejects chrome, zoom and wrong display', () => {
  const { client } = setup();
  assert.deepEqual(client.toPage(120, 240), { x: 120, y: 240 });
  document.fullscreenElement = null;
  assert.equal(client.toPage(120, 240), null);
  document.fullscreenElement = document.documentElement;
  window.innerWidth = 800;
  assert.equal(client.geometry().geometryValid, false);
  window.innerWidth = 1000; window.visualViewport.scale = 1.2;
  assert.equal(client.geometry().geometryValid, false);
  window.visualViewport.scale = 1; window.devicePixelRatio = 1.8;
  assert.match(client.geometry().reason, /zoom/);
  window.devicePixelRatio = 2; window.screenX = 1000;
  assert.equal(client.geometry().geometryValid, false);
});

test('100% zoom with a macOS reserved top strip maps screen points into the usable fullscreen viewport', () => {
  const { client } = setup();
  window.screen.availTop = 24;
  window.screen.availHeight = 776;
  window.innerHeight = 776;
  window.screenY = 24; // Chrome can report the usable-area origin in fullscreen.
  assert.equal(client.geometry().geometryValid, true);
  assert.deepEqual(client.toPage(120, 124), { x: 120, y: 100 });
  assert.deepEqual(client.toScreen(120, 100), { x: 120, y: 124 });
  window.innerHeight = 600;
  assert.match(client.geometry().reason, /viewport/);
  assert.doesNotMatch(client.geometry().reason, /zoom/);
});

test('semantic target changes within a backend fixation and preserves capture time', () => {
  const { client, region, gaze } = setup();
  region('left', 0, 500); region('right', 500, 1000);
  const starts = [], ends = [];
  client.on('fixation', e => starts.push(e)); client.on('fixation_end', e => ends.push(e));
  gaze(450, 1000); gaze(450, 1150); gaze(450, 1200);
  gaze(550, 1250); gaze(550, 1400);
  assert.deepEqual(starts.map(e => [e.key, e.t]), [['left', 1000], ['right', 1250]]);
  assert.equal(ends[0].t, 1200); assert.equal(ends[0].ms, 200);
  assert.equal(client.stats().left.dwellMs, 200);
});

test('uncertain boundaries, offscreen rectangles and occlusion cannot force wrong targets', () => {
  const { client, region } = setup();
  const left = region('left', 0, 490); region('right', 510, 1000);
  client.accuracyDeg = 1;
  assert.equal(client.hit(480, 400), null);
  assert.equal(client.hit(400, 400), left);
  assert.equal(client.hit(500, 400), null); // no nearest-target snapping
  assert.equal(client.hit(-1, 400), null);
  client.accuracyDeg = null;
  assert.equal(client.hit(400, 400), null); // unverified accuracy is not certainty
});

test('face loss, invalid coordinates, blink and sample gaps clear attention without hidden dwell', () => {
  for (const loss of ['face', 'invalid', 'blink', 'gap']) {
    const { client, region, gaze } = setup(); region('target', 0, 1000);
    const ends = []; client.on('fixation_end', e => ends.push(e));
    gaze(400, 1000); gaze(400, 1150);
    if (loss === 'face') client._message({ type: 'face', present: false, t: 1200 });
    if (loss === 'invalid') client._message({ type: 'gaze', valid: false, t: 1200, reason: 'head_pose_outside_calibration' });
    if (loss === 'blink') gaze(400, 1200, { blink: true, valid: false });
    if (loss === 'gap') gaze(400, 5000);
    assert.equal(ends.length, 1, loss); assert.equal(ends[0].ms, 150, loss);
    assert.equal(client.stats().target.dwellMs, 150, loss);
  }
});

test('calibration training error never masquerades as independently validated accuracy', () => {
  const { client } = setup();
  client._message({ type: 'calib_result', applied: true, currentDeg: 1, afterDeg: 0.1, looDeg: 0.5 });
  assert.equal(client.accuracyDeg, null);
});

test('offscreen and covered regions do not make a visible target ambiguous', () => {
  const { client, region } = setup();
  const target = region('target', 0, 1000);
  region('offscreen', -20, -1);
  const covered = region('covered', 100, 200);
  // A non-gaze overlay covers the competing region.
  const overlay = { closest: () => null };
  document.elementFromPoint = (x) => x >= 100 && x < 200 ? overlay : target;
  client.accuracyDeg = 3;
  assert.equal(client.hit(250, 400), target);
  assert.equal(client.hit(150, 400), null);
  assert.equal(covered.contains(overlay), false);
});

test('geometry changes cancel quick calibration without applying an incomplete fit', async () => {
  const { client } = setup();
  const sent = [];
  const nativeTimeout = globalThis.setTimeout;
  globalThis.setTimeout = fn => { queueMicrotask(fn); return 0; };
  document.createElement = () => ({ style: {}, append() {}, remove() {} });
  document.body = { append() {} };
  client.send = msg => {
    sent.push(msg.type);
    if (msg.type === 'calib_target') window.innerWidth = 900;
  };
  try {
    const result = await client.calibrate({ points: [[0.5, 0.5]], glideMs: 0, settleMs: 0, sampleMs: 0 });
    assert.equal(result.ok, false);
    assert.match(result.error, /geometry changed/);
    assert.equal(sent.includes('calib_finish'), false);
    assert.equal(client._calibrating, false);
  } finally { globalThis.setTimeout = nativeTimeout; }
});

test('conservative uncertainty supports targeting without claiming corrected accuracy', () => {
  const { client, region } = setup(); const left = region('left', 0, 490); region('right', 510, 1000);
  client._message({ type: 'calib_result', applied: true, uncertaintyDeg: 1, uncertaintySource: 'conservative_estimate' });
  assert.equal(client.accuracyDeg, null);
  assert.equal(client.hit(400, 400), left);
  assert.equal(client.hit(480, 400), null);
  assert.equal(client.status().uncertaintySource, 'conservative_estimate');
});

test('validation samples fresh targets and asks server to measure without fitting', async () => {
  const { client } = setup();
  const sent = [];
  const nativeTimeout = globalThis.setTimeout;
  globalThis.setTimeout = fn => { queueMicrotask(fn); return 0; };
  document.createElement = () => ({ style: {}, append() {}, remove() {} });
  document.body = { append() {} };
  client.send = msg => {
    sent.push(msg);
    if (msg.type === 'calib_target_end') client._message({ type: 'calib_point', requestId: msg.requestId, samples: 20, coverage: 1, ok: true });
    if (msg.type === 'calib_finish') client._message({ type: 'calib_result', ok: true, applied: false,
      validationOnly: true, validation: { meanDeg: 2, p90Deg: 3, worstDeg: 4 }, accuracyValidated: true,
      uncertaintyDeg: 3, uncertaintySource: 'current_live_validation' });
  };
  try {
    const result = await client.validate();
    assert.equal(result.validationOnly, true);
    assert.equal(result.validation.meanDeg, 2);
    assert.equal(sent.filter(m => m.type === 'calib_target').length, 9);
    assert.equal(sent.find(m => m.type === 'calib_finish').validateOnly, true);
    assert.equal(sent.find(m => m.type === 'calib_begin').validateOnly, true);
    assert.equal(sent.some(m => m.type === 'hello'), true);
    assert.equal(client.status().accuracyValidated, true);
  } finally { globalThis.setTimeout = nativeTimeout; }
});

test('unchanged invalid samples emit one loss and status, then recover', () => {
  const { client, region, gaze } = setup(); region('target', 0, 1000);
  const losses = [], statuses = [];
  client.on('lost', e => losses.push(e)); client.on('status', e => statuses.push(e));
  const invalid = { valid: false, reason: 'head_pose_outside_calibration', quality: 'invalid' };
  gaze(400, 1000, invalid); gaze(400, 1100, invalid); gaze(400, 1200, invalid);
  assert.equal(losses.length, 1); assert.equal(statuses.length, 1);
  gaze(400, 1300, { quality: 'usable' });
  assert.equal(client.status().reason, null); assert.equal(client.status().valid, true);
  assert.equal(statuses.length, 2);
});

test('target changes clear the old referent before a new semantic fixation starts', () => {
  const { client, region, gaze } = setup(); region('left', 0, 490); region('right', 510, 1000);
  const events = [];
  for (const kind of ['fixation', 'fixation_end', 'lost']) client.on(kind, e => events.push([kind, e.reason ?? e.key]));
  gaze(400, 1000); gaze(400, 1150);
  gaze(600, 1200); gaze(600, 1350);
  gaze(500, 1400);
  assert.deepEqual(events, [
    ['fixation', 'left'], ['fixation_end', 'left'], ['lost', 'target_changed'],
    ['fixation', 'right'], ['fixation_end', 'right'], ['lost', 'ambiguous_target'],
  ]);
});

test('a stalled camera clears attention before any later sample arrives', () => {
  const { client, region, gaze } = setup(); region('target', 0, 1000);
  gaze(400, 1000); gaze(400, 1150);
  const losses = []; client.on('lost', e => losses.push(e));
  client._checkStale(client._receivedAt + 501);
  assert.equal(client.current, null);
  assert.equal(client.gaze, null);
  assert.equal(client.stats().target.dwellMs, 150);
  assert.equal(losses[0].reason, 'camera samples stopped');
  client.close();
});


async function calibrationFixture(replies, run) {
  const { client } = setup();
  const sent = [], progress = [];
  const nativeTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => ms === 3000 ? nativeTimeout(fn, ms) : (queueMicrotask(fn), 0);
  document.createElement = () => ({ style: {}, append() {}, remove() {} });
  document.body = { append() {} };
  client.on('calib_progress', p => progress.push(p));
  let attempt = 0;
  client.send = msg => {
    sent.push(msg);
    if (msg.type === 'calib_target_end' && msg.requestId != null) {
      // Ignore unrelated replies even while a target request is outstanding.
      client._message({ type: 'calib_point', requestId: -1, ok: false });
      client._message({ type: 'calib_point', requestId: msg.requestId, ...replies(attempt++) });
    }
    if (msg.type === 'calib_finish') client._message({ type: 'calib_result', ok: true, applied: false });
  };
  try { await run(client, sent, progress); }
  finally { globalThis.setTimeout = nativeTimeout; client.close(); }
}

test('quick calibration retries only the failed dot, with bounded progress and correlated replies', async () => {
  await calibrationFixture(i => i === 1 ? { ok: false, samples: 2, coverage: 0.2, rejected: { blink: 8 } }
    : { ok: true, samples: 15, coverage: 0.9 }, async (client, sent, progress) => {
    const result = await client.calibrate({ glideMs: 0, settleMs: 0, sampleMs: 0 });
    assert.equal(result.ok, true);
    const targets = sent.filter(m => m.type === 'calib_target');
    assert.equal(targets.length, 6);
    assert.deepEqual(targets.filter(m => m.retry).map(m => [m.x, m.y]), [[120, 120]]);
    assert.equal(progress.filter(p => p.attempt === 2).length, 1);
    assert.equal(progress.at(-1).done, true);
    assert.equal(client._calibrating, false);
  });
});

test('persistent rejection stops after three attempts, discards incomplete fit, and explains recovery', async () => {
  await calibrationFixture(() => ({ ok: false, samples: 0, coverage: 0, rejected: { head_pose_outside_calibration: 25 } }),
    async (client, sent, progress) => {
      const result = await client.calibrate({ glideMs: 0, settleMs: 0, sampleMs: 0 });
      assert.equal(result.ok, false);
      assert.match(result.error, /target 1\/5.*3 attempts.*head position/);
      assert.equal(sent.filter(m => m.type === 'calib_target').length, 3);
      assert.equal(sent.some(m => m.type === 'calib_finish'), false);
      assert.equal(sent.at(-1).type, 'calib_begin');
      assert.equal(progress.at(-1).done, true);
    });
});

test('validation retries poor coverage even with enough samples and never fits', async () => {
  await calibrationFixture(i => ({ ok: true, samples: 20, coverage: i === 0 ? 0.5 : 0.9 }),
    async (client, sent) => {
      const result = await client.validate();
      assert.equal(result.ok, true);
      assert.equal(sent.filter(m => m.type === 'calib_target').length, 10);
      assert.equal(sent.filter(m => m.type === 'calib_target').filter(m => m.retry).length, 1);
      assert.equal(sent.find(m => m.type === 'calib_finish').validateOnly, true);
    });
});

test('live head pose guidance is exposed and clears after recovery', () => {
  const { client, gaze } = setup();
  gaze(400, 1000, { valid: false, reason: 'head_pose_outside_calibration', guidance: 'raise your head', pose: { pitch: -20 } });
  assert.equal(client.status().guidance, 'raise your head');
  assert.deepEqual(client.status().pose, { pitch: -20 });
  gaze(400, 1100);
  assert.equal(client.status().guidance, null);
  client.close();
});

test('a missing target reply aborts and removes its listener instead of finishing an incomplete fit', async () => {
  const { client } = setup();
  const sent = [];
  const nativeTimeout = globalThis.setTimeout;
  globalThis.setTimeout = fn => { queueMicrotask(fn); return 0; };
  document.createElement = () => ({ style: {}, append() {}, remove() {} });
  document.body = { append() {} };
  client.send = msg => sent.push(msg);
  try {
    const result = await client.calibrate({ glideMs: 0, settleMs: 0, sampleMs: 0 });
    assert.equal(result.ok, false);
    assert.match(result.error, /no reply from eye serve/);
    assert.equal(sent.some(m => m.type === 'calib_finish'), false);
    assert.equal(client.handlers.message.length, 0);
    assert.equal(client._calibrating, false);
    assert.equal(sent.at(-1).type, 'calib_begin');
  } finally { globalThis.setTimeout = nativeTimeout; client.close(); }
});

test('close aborts calibration and prevents detached transports from queuing commands', () => {
  const {client} = setup();
  let removed = false;
  client._calibrating = true;
  client._calibrationOverlay = {remove() { removed = true; }};
  client.close();
  assert.equal(removed, true);
  assert.equal(client.connected, false);
  assert.equal(client.face, false);
  assert.equal(client._calibrationAborted, true);
  client.send({type: 'calib_finish'});
  assert.equal(client._pending.length, 0);
});

test('custom transport receives gaze using the same validity and geometry checks', () => {
  setup();
  const wire = {send() {}, close() {}};
  const client = new EyeClient({transport: () => wire});
  wire.onopen();
  wire.onmessage({data: JSON.stringify({type:'hello', display:{x:0,y:0,w:1000,h:800,scale:2,ptPerDeg:49}, calibrated:true, face:true, accuracyDeg:.1})});
  wire.onmessage({data: JSON.stringify({type:'gaze',x:500,y:400,t:10,valid:true})});
  assert.deepEqual(client.gaze, {x:500,y:400});
  wire.onmessage({data: JSON.stringify({type:'gaze',t:20,valid:false,reason:'blink'})});
  assert.equal(client.gaze, null);
  client.close();
});

test('explicit backend capability permits first calibration without claiming calibrated gaze', async () => {
  await calibrationFixture(() => ({ok:true, samples:20, coverage:1}), async (client, sent) => {
    client._message({type:'hello', display:client.display, face:true, calibrated:false, canCalibrate:true});
    assert.equal(client.status().canCalibrate, true);
    assert.equal(client.status().calibrated, false);
    const validation = await client.validate();
    assert.equal(validation.ok, false);
    assert.equal(sent.length, 0);
    const result = await client.calibrate({points:[[.5,.5]], glideMs:0, settleMs:0, sampleMs:0});
    assert.equal(result.ok, true);
    assert.equal(sent.some(m => m.type === 'calib_finish'), true);
    assert.equal(client.status().calibrated, false);
    assert.equal(client.status().valid, false);
  });
});

test('first calibration capability defaults off and is revoked by a subsequent hello', async () => {
  const {client} = setup();
  const hello = {type:'hello', display:client.display, calibrated:false};
  client._message({...hello, canCalibrate:true});
  client._message(hello);
  assert.equal(client.status().canCalibrate, false);
  assert.equal((await client.calibrate()).ok, false);
  client._message({...hello, canCalibrate:'true'});
  assert.equal((await client.calibrate()).ok, false);
  client.close();
});

test('pose episode metadata follows its target through retries and labels follow block order', async () => {
  await calibrationFixture(i => ({ok:i !== 0, samples:i === 0 ? 0 : 20, coverage:i === 0 ? 0 : 1}),
    async (client, sent) => {
      const nodes = [];
      document.createElement = () => {const node = {style:{}, append(){}, remove(){}}; nodes.push(node); return node;};
      const episodes = [{pose:'neutral', block:0, blockStart:true, seed:123}, {pose:'left', block:1, blockStart:true, seed:123}];
      const labels = ['CENTERED', 'SHIFT LEFT'];
      const shown = [];
      client.on('calib_progress', () => {queueMicrotask(() => shown.push(nodes[2]?.textContent));});
      const result = await client.calibrate({points:[[.5,.5],[.12,.15]], pointMetadata:episodes,
        pointLabels:labels, blockStartWaitMs:1, glideMs:0, settleMs:0, sampleMs:0});
      assert.equal(result.ok, true);
      const targets = sent.filter(m => m.type === 'calib_target');
      assert.deepEqual(targets.map(m => m.episode), [episodes[0], episodes[0], episodes[1]]);
      assert.deepEqual(targets.map(m => m.retry), [false,true,false]);
      assert.equal(shown.some(s => s?.startsWith('CENTERED')), true);
      assert.equal(shown.some(s => s?.startsWith('SHIFT LEFT')), true);
      assert.deepEqual(episodes, [{pose:'neutral', block:0, blockStart:true, seed:123}, {pose:'left', block:1, blockStart:true, seed:123}]);
    });
});

test('recenter is an explicit finish command and cannot bootstrap an uncalibrated backend', async () => {
  await calibrationFixture(() => ({ok:true, samples:20, coverage:1}), async (client, sent) => {
    const result = await client.calibrate({points:[[.5,.5]], recenterOnly:true, glideMs:0, settleMs:0, sampleMs:0});
    assert.equal(result.ok, true);
    assert.deepEqual(sent.find(m => m.type === 'calib_finish'), {type:'calib_finish', validateOnly:false, recenterOnly:true});
    assert.deepEqual(sent.find(m => m.type === 'calib_begin'), {type:'calib_begin', validateOnly:false, recenterOnly:true});
    client._message({type:'hello', display:client.display, face:true, calibrated:false, canCalibrate:true});
    sent.length = 0;
    assert.equal((await client.calibrate({recenterOnly:true})).ok, false);
    assert.equal(sent.length, 0);
  });
});

test('cancellation during the posture instruction wait discards the episode before sampling or fitting', async () => {
  await calibrationFixture(() => ({ok:true, samples:20, coverage:1}), async (client, sent) => {
    const fastTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms) => fastTimeout(() => {
      if (ms === 2500) client._calibrationAborted = true;
      fn();
    }, ms);
    try {
      const result = await client.calibrate({points:[[.5,.5]], recenterOnly:true,
        pointLabels:['SHIFT LEFT'], pointMetadata:[{pose:'left',blockStart:true}], blockStartWaitMs:2500,
        glideMs:0, settleMs:0, sampleMs:0});
      assert.equal(result.ok, false);
      assert.match(result.error, /calibration cancelled/);
      assert.equal(sent.some(m => m.type === 'calib_target' || m.type === 'calib_finish'), false);
      assert.deepEqual(sent.map(m => m.type), ['calib_begin','calib_target_end','calib_begin']);
      assert.equal(client._calibrating, false);
      assert.equal(client._calibrationOverlay, null);
    } finally {globalThis.setTimeout = fastTimeout;}
  });
});
