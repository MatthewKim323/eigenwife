import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const code = await readFile(new URL('../src/eye/web/iphone-protocol.js', import.meta.url), 'utf8');
const {GazeSmoother, CursorMotion} = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

function noisyFixation(strength) {
  const smoother = new GazeSmoother({strength});
  let seed = 239;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const normal = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, random()))) * Math.cos(2 * Math.PI * random());
  const raw = [], filtered = [];
  for (let i = 0; i < 1000; i++) {
    const p = {x: 600 + normal() * 35, y: 400 + normal() * 35, t: i * 200};
    const q = smoother.update(p);
    if (i > 20) { raw.push(Math.hypot(p.x - 600, p.y - 400)); filtered.push(Math.hypot(q.x - 600, q.y - 400)); }
  }
  const rms = a => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
  return {raw: rms(raw), filtered: rms(filtered)};
}

test('steady mode cuts stationary 5 Hz fixation RMS by at least 45 percent', t => {
  const result = noisyFixation('steady');
  t.diagnostic(JSON.stringify(result));
  assert.ok(result.filtered < result.raw * .55);
});

test('responsive mode still reduces jitter and has less damping than steady', () => {
  const steady = noisyFixation('steady'), responsive = noisyFixation('responsive');
  assert.ok(responsive.filtered < responsive.raw * .8);
  assert.ok(responsive.filtered > steady.filtered);
});

for (const strength of ['steady', 'responsive']) {
  test(`${strength}: isolated large spike does not move a stable fixation`, () => {
    const s = new GazeSmoother({strength});
    s.update({x: 400, y: 300, t: 0});
    assert.deepEqual(s.update({x: 1000, y: 900, t: 200}), {x: 400, y: 300});
    assert.deepEqual(s.update({x: 400, y: 300, t: 400}), {x: 400, y: 300});
    assert.deepEqual(s.update({x: 400, y: 300, t: 600}), {x: 400, y: 300});
  });
  test(`${strength}: confirmed 500 point gaze shift lands within 30 points at 200 ms and 2 at 400 ms`, () => {
    const s = new GazeSmoother({strength});
    s.update({x: 0, y: 0, t: 0});
    assert.deepEqual(s.update({x: 300, y: 400, t: 200}), {x: 0, y: 0});
    const confirmed = s.update({x: 300, y: 400, t: 400});
    assert.ok(Math.hypot(300 - confirmed.x, 400 - confirmed.y) < 30);
    const settled = s.update({x: 300, y: 400, t: 600});
    assert.ok(Math.hypot(300 - settled.x, 400 - settled.y) < 2);
  });
}

test('reset and long gaps discard previous position and candidate history', () => {
  const s = new GazeSmoother();
  s.update({x: 0, y: 0, t: 0});
  s.update({x: 500, y: 500, t: 200});
  s.reset();
  assert.deepEqual(s.update({x: 700, y: 300, t: 210}), {x: 700, y: 300});
  assert.deepEqual(s.update({x: 100, y: 900, t: 710}), {x: 100, y: 900});
});

test('nonincreasing timestamps cannot confirm a spike or corrupt the clock', () => {
  const s = new GazeSmoother();
  s.update({x: 0, y: 0, t: 100});
  s.update({x: 500, y: 500, t: 300});
  assert.deepEqual(s.update({x: 500, y: 500, t: 300}), {x: 0, y: 0});
  assert.deepEqual(s.update({x: 500, y: 500, t: 200}), {x: 0, y: 0});
  assert.deepEqual(s.update({x: 0, y: 0, t: 500}), {x: 0, y: 0});
  assert.throws(() => s.update({x: NaN, y: 0, t: 700}), TypeError);
  assert.deepEqual(s.update({x: 0, y: 0, t: 700}), {x: 0, y: 0});
});


test('cursor motion stays continuous between 5 Hz packets without overshoot', () => {
  const m = new CursorMotion();
  m.setTarget({x:0,y:0}, 0);
  m.setTarget({x:500,y:300}, 0);
  let previous = 0;
  for (let t=16; t<=320; t+=16) {
    const p=m.step(t);
    assert.ok(p.x > previous && p.x < 500);
    previous=p.x;
  }
  assert.ok(previous > 490);
  const before=m.step(320), velocity={...m.velocity};
  m.setTarget({x:800,y:100},320);
  assert.deepEqual(m.point,before);
  assert.deepEqual(m.velocity,velocity);
});

test('cursor motion is independent of display refresh rate', () => {
  const run = frames => {
    const m=new CursorMotion();
    m.setTarget({x:0,y:0},0);m.setTarget({x:600,y:400},0);
    for(let i=1;i<=frames;i++)m.step(i*200/frames);
    return m.point;
  };
  const a=run(12),b=run(24);
  assert.ok(Math.hypot(a.x-b.x,a.y-b.y)<1e-8);
});

test('cursor reset discards position and velocity after tracking loss', () => {
  const m=new CursorMotion();m.setTarget({x:0,y:0},0);m.setTarget({x:600,y:400},1);m.step(50);
  m.reset();assert.equal(m.step(60),null);
  m.setTarget({x:900,y:100},80);
  assert.deepEqual(m.step(90),{x:900,y:100});
  assert.deepEqual(m.velocity,{x:0,y:0});
});
