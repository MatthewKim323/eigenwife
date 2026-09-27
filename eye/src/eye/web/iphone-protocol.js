// Reproducible target order; all blocks repeat the same positions to separate
// target location from posture. Validation gets separate jittered positions.
function rng(seed) {
  let x = seed >>> 0;
  return () => { x += 0x6D2B79F5; let t = x; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function shuffle(values, random) {
  const out = values.slice();
  for (let i=out.length-1;i>0;i--) {const j=Math.floor(random()*(i+1)); [out[i],out[j]]=[out[j],out[i]];}
  return out;
}
export function calibrationPlan(seed) {
  const random=rng(seed), grid=[.15,.5,.85].flatMap(y=>[.12,.5,.88].map(x=>[x,y]));
  const poses=[['neutral','COMFORTABLE CENTERED POSTURE'],['left','SHIFT YOUR HEAD SLIGHTLY LEFT · KEEP THE PHONE FIXED'],['right','SHIFT YOUR HEAD SLIGHTLY RIGHT · KEEP THE PHONE FIXED']];
  const points=[], pointLabels=[], pointMetadata=[];
  poses.forEach(([pose,label],block)=>shuffle(grid,random).forEach((p,i)=>{
    points.push(p); pointLabels.push(label+' · LOOK AT THE DOT'); pointMetadata.push({pose,block,blockStart:i===0,seed:seed>>>0});
  }));
  return {points,pointLabels,pointMetadata,sampleMs:1400,settleMs:600,glideMs:400,blockStartWaitMs:2500};
}
export function validationPlan(seed) {
  const random=rng(seed), points=[.24,.53,.78].flatMap(y=>[.22,.48,.78].map(x=>[x+(random()-.5)*.04,y+(random()-.5)*.04]));
  return {points:shuffle(points,random),validateOnly:true,label:'ACCURACY CHECK · LOOK AT THE DOT',sampleMs:1100};
}

// Screen-point smoothing only. Keep calibration/accuracy measurements upstream raw.
// A causal three-sample median rejects a single bad image prediction. Once a
// large shift survives that confirmation, two fast updates avoid a long EMA tail.
export class GazeSmoother {
  constructor({strength = 'steady', resetGapMs = 500} = {}) {
    if (!['steady', 'responsive'].includes(strength)) throw new RangeError('Unknown gaze smoothing strength');
    this.strength = strength;
    this.resetGapMs = resetGapMs;
    this.reset();
  }

  reset() {
    this.samples = [];
    this.point = null;
    this.lastT = null;
    this.fastUpdates = 0;
  }

  update({x, y, t}) {
    if (![x, y, t].every(Number.isFinite)) throw new TypeError('Gaze coordinates and timestamp must be finite');
    // Repeated or reordered packets must not advance either the median or clock.
    if (this.point && t <= this.lastT) return {...this.point};
    if (!this.point || t - this.lastT >= this.resetGapMs) {
      this.point = {x, y};
      this.samples = [{x, y}, {x, y}, {x, y}];
      this.lastT = t;
      this.fastUpdates = 0;
      return {...this.point};
    }
    const dt = t - this.lastT;
    this.lastT = t;
    this.samples.shift();
    this.samples.push({x, y});
    const median = key => this.samples.map(p => p[key]).sort((a, b) => a - b)[1];
    const target = {x: median('x'), y: median('y')};
    const distance = Math.hypot(target.x - this.point.x, target.y - this.point.y);
    if (distance >= 100) this.fastUpdates = 2;
    const moving = Math.max(0, Math.min(1, (distance - 40) / 60));
    const restTau = this.strength === 'steady' ? 600 : 300;
    const tau = this.fastUpdates > 0 ? 70 : restTau + (100 - restTau) * moving * moving;
    const alpha = 1 - Math.exp(-dt / tau);
    this.point = {
      x: this.point.x + alpha * (target.x - this.point.x),
      y: this.point.y + alpha * (target.y - this.point.y),
    };
    this.fastUpdates = Math.max(0, this.fastUpdates - 1);
    return {...this.point};
  }
}

// Exact critically damped motion between sparse predictions. Retargeting keeps
// velocity continuous; unlike short CSS transitions it never stops at each packet.
export class CursorMotion {
  constructor({omega = 20} = {}) { this.omega = omega; this.reset(); }
  reset() { this.point = null; this.target = null; this.velocity = {x:0,y:0}; this.t = null; }
  setTarget(point, t) {
    if (![point.x, point.y, t].every(Number.isFinite)) return;
    if (this.point) this.step(t);
    else { this.point = {...point}; this.t = t; }
    this.target = {...point};
  }
  step(t) {
    if (!this.point || !Number.isFinite(t) || t <= this.t) return this.point && {...this.point};
    const dt = (t - this.t) / 1000;
    this.t = t;
    for (const axis of ['x','y']) {
      const error = this.point[axis] - this.target[axis];
      const b = this.velocity[axis] + this.omega * error;
      const decay = Math.exp(-this.omega * dt);
      this.point[axis] = this.target[axis] + (error + b * dt) * decay;
      this.velocity[axis] = (this.velocity[axis] - this.omega * b * dt) * decay;
    }
    return {...this.point};
  }
}
