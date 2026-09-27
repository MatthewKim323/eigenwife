import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('../src/eye/web/iphone-protocol.js',import.meta.url),'utf8');
const {calibrationPlan,validationPlan}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
test('repeated pose blocks cover identical targets with reproducible randomized order',()=>{
 const p=calibrationPlan(12); assert.deepEqual(p,calibrationPlan(12)); assert.equal(p.points.length,27);
 const grid=p.points.slice(0,9).map(JSON.stringify).sort();
 for(let i=0;i<3;i++) {assert.deepEqual(p.points.slice(i*9,i*9+9).map(JSON.stringify).sort(),grid);assert.equal(p.pointMetadata[i*9].blockStart,true);}
 assert.notDeepEqual(p.points,calibrationPlan(13).points);
 assert.equal(new Set(p.pointMetadata.map(x=>x.pose)).size,3);
});
test('validation is fresh, spread across screen and disjoint from training',()=>{
 const train=new Set(calibrationPlan(12).points.map(JSON.stringify));const v=validationPlan(12);
 assert.equal(v.validateOnly,true); assert.equal(new Set(v.points.map(JSON.stringify)).size,9);
 assert.ok(v.points.every(p=>!train.has(JSON.stringify(p))&&p.every(x=>x>0&&x<1)));
 for(let axis=0;axis<2;axis++)assert.ok(Math.max(...v.points.map(p=>p[axis]))-Math.min(...v.points.map(p=>p[axis]))>.5);
 assert.notDeepEqual(v.points,validationPlan(13).points);
});
