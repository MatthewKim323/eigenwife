import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source = await readFile(new URL('../browser-extension/background.js', import.meta.url), 'utf8');
const event = () => ({handlers: [], addListener(fn) { this.handlers.push(fn); }, fire(...args) { return this.handlers.map(fn => fn(...args)); }});
function setup() {
  const timers = new Map(), sockets = [], injected = [];
  let timerId = 0;
  const chrome = {runtime: {id: 'approved-extension', onMessage: event(), onConnect: event()}, tabs: {query: async () => [{id: 7, url:'https://example.com'}], onActivated:event(), onRemoved:event(), onUpdated:event()}, windows: {WINDOW_ID_NONE: -1, onFocusChanged:event()}, scripting: {executeScript: async args => injected.push(args)}};
  class Socket {
    static OPEN = 1;
    constructor(url) {this.url = url; this.readyState = 0; this.sent = []; sockets.push(this);}
    open() { this.readyState=1; this.onopen?.(); }
    send(data) {this.sent.push(JSON.parse(data));}
    close() {this.readyState=3; this.closed = true; this.onclose?.();}
  }
  vm.runInNewContext(source, {chrome, WebSocket:Socket, setTimeout(fn) { timers.set(++timerId,fn); return timerId; }, clearTimeout(id) {timers.delete(id);}});
  const request = (type, sender = {id:chrome.runtime.id, url:`chrome-extension://${chrome.runtime.id}/popup.html`}, payload = {}) => new Promise(resolve => chrome.runtime.onMessage.fire({type, ...payload}, sender, resolve));
  function port(overrides={}) {
    const p = {name:'eye-dom', sender:{id:chrome.runtime.id, tab:{id:7}, frameId:0}, onDisconnect:event(), onMessage:event(), messages:[], disconnected:false, postMessage(value) {if(this.disconnected) throw Error('closed'); this.messages.push(value);}, disconnect() {if(this.disconnected) return; this.disconnected=true; this.onDisconnect.fire();}, ...overrides};
    chrome.runtime.onConnect.fire(p); return p;
  }
  const runTimers = () => {const tasks=[...timers.values()]; timers.clear(); tasks.forEach(fn=>fn());};
  return {chrome, timers, sockets, injected, request, port, runTimers};
}

test('only popup enable approves active top-frame tab; other ports rejected', async () => {
  const s=setup();
  assert.equal(s.port().disconnected,true); assert.equal(s.sockets.length,0);
  const reply=await s.request('enable'); assert.equal(reply.ok,true); assert.equal(s.injected[0].target.tabId,7);
  for(const sender of [{id:'other',tab:{id:7},frameId:0},{id:s.chrome.runtime.id,tab:{id:8},frameId:0},{id:s.chrome.runtime.id,tab:{id:7},frameId:1}]) assert.equal(s.port({sender}).disconnected,true);
  const p=s.port(); assert.equal(p.disconnected,false); assert.equal(s.sockets.length,1);
  s.sockets[0].open(); assert.equal(p.messages[0].type,'open');
  assert.equal(s.port().disconnected,true); // A duplicate cannot tear down the authorized port.
  assert.equal(p.disconnected,false);
  await s.request('disable');
});

test('content cannot authorize access and internal browser pages cannot be enabled', async () => {
  const s=setup(); let replied=false;
  s.chrome.runtime.onMessage.fire({type:'enable'},{id:s.chrome.runtime.id,tab:{id:7}},()=>replied=true);
  await Promise.resolve(); assert.equal(replied,false); assert.equal(s.injected.length,0);
  s.chrome.tabs.query=async()=>[{id:7,url:'chrome://settings'}];
  assert.equal((await s.request('enable')).ok,false); assert.equal(s.injected.length,0);
});

test('command allowlist strips unrelated page data and validates calibration payloads', async () => {
  const s=setup(); await s.request('enable'); const p=s.port(); const ws=s.sockets[0]; ws.open();
  p.onMessage.fire({type:'click',selector:'#pay'});
  p.onMessage.fire({type:'calib_target',x:NaN,y:2});
  p.onMessage.fire({type:'calib_begin',url:'private-page',label:'secret'});
  p.onMessage.fire({type:'calib_target',x:120,y:240,retry:true,html:'private'});
  p.onMessage.fire({type:'calib_target_end',requestId:8,validateOnly:true,secret:'no'});
  p.onMessage.fire({type:'calib_finish',validateOnly:true,selector:'#private'});
  assert.deepEqual(ws.sent,[{type:'calib_begin'},{type:'calib_target',x:120,y:240,retry:true},{type:'calib_target_end',validateOnly:true,requestId:8},{type:'calib_finish',validateOnly:true}]);
  await s.request('disable');
});

test('tab navigation, switch, or closure revoke approval and transport', async () => {
  for(const trigger of [s=>s.chrome.tabs.onUpdated.fire(7,{status:'loading'}),s=>s.chrome.tabs.onActivated.fire({tabId:8}),s=>s.chrome.tabs.onRemoved.fire(7)]) {
    const s=setup(); await s.request('enable'); const p=s.port(); const ws=s.sockets[0]; ws.open(); trigger(s);
    assert.equal(p.disconnected,true); assert.equal(ws.closed,true); s.runTimers(); assert.equal(s.sockets.length,1); assert.equal(s.port().disconnected,true);
  }
});

test('tracker outage reconnects only while enabled; port disconnect cancels pending retry', async () => {
  const s=setup(); await s.request('enable'); const p=s.port(); s.sockets[0].open(); s.sockets[0].close();
  assert.equal(p.messages.at(-1).type,'offline'); assert.equal(s.timers.size,1);
  s.runTimers(); assert.equal(s.sockets.length,2);
  s.sockets[1].open(); s.sockets[1].close(); assert.equal(s.timers.size,1);
  p.disconnect(); assert.equal(s.timers.size,0); s.runTimers(); assert.equal(s.sockets.length,2);
});

test('enable completion cannot resurrect authorization after explicit stop', async () => {
  const s=setup(); let completeInjection, signalStarted;
  const started=new Promise(resolve=>signalStarted=resolve);
  s.chrome.scripting.executeScript=()=>new Promise(resolve=>{completeInjection=resolve; signalStarted();});
  const pending=s.request('enable'); await started;
  await s.request('disable'); completeInjection();
  assert.equal((await pending).ok,false); assert.equal(s.port().disconnected,true); assert.equal(s.sockets.length,0);
});

test('window blur pauses socket but retains panel and approval; same tab focus resumes once', async () => {
  const s=setup(); await s.request('enable'); const p=s.port(); const ws=s.sockets[0]; ws.open();
  s.chrome.windows.onFocusChanged.fire(-1);
  assert.equal(ws.closed,true); assert.equal(p.disconnected,false);
  assert.equal(p.messages.at(-1).type,'paused');
  s.runTimers(); assert.equal(s.sockets.length,1);
  p.onMessage.fire({type:'hello'}); assert.equal(ws.sent.length,0);
  ws.onmessage({data:JSON.stringify({type:'gaze'})});
  assert.equal(p.messages.at(-1).type,'paused');
  s.chrome.windows.onFocusChanged.fire(1); await Promise.resolve();
  assert.equal(s.sockets.length,2); assert.equal(p.disconnected,false);
  s.sockets[1].open(); assert.equal(p.messages.at(-1).type,'open');
  await s.request('disable'); assert.equal(p.disconnected,true);
});

test('blur cancels outage reconnect and stop still revokes a paused panel', async () => {
  const s=setup(); await s.request('enable'); const p=s.port(); s.sockets[0].open(); s.sockets[0].close();
  assert.equal(s.timers.size,1);
  s.chrome.windows.onFocusChanged.fire(-1);
  assert.equal(s.timers.size,0); s.runTimers(); assert.equal(s.sockets.length,1);
  await s.request('disable'); assert.equal(p.disconnected,true);
  s.chrome.windows.onFocusChanged.fire(1); await Promise.resolve();
  assert.equal(s.sockets.length,1); assert.equal(s.port().disconnected,true);
});

test('stale focus queries cannot resume after another blur or revoke newer focus', async () => {
  const s=setup(); await s.request('enable'); const p=s.port(); s.sockets[0].open();
  const pending=[];
  s.chrome.tabs.query=()=>new Promise(resolve=>pending.push(resolve));
  s.chrome.windows.onFocusChanged.fire(-1);
  s.chrome.windows.onFocusChanged.fire(1);
  s.chrome.windows.onFocusChanged.fire(-1);
  pending.shift()([{id:7}]); await Promise.resolve();
  assert.equal(s.sockets.length,1); assert.equal(p.disconnected,false);
  s.chrome.windows.onFocusChanged.fire(1);
  s.chrome.windows.onFocusChanged.fire(2);
  pending.pop()([{id:7}]); await Promise.resolve();
  assert.equal(s.sockets.length,2);
  pending.shift()([{id:8}]); await Promise.resolve();
  assert.equal(p.disconnected,false); assert.equal(s.sockets.length,2);
  await s.request('disable');
});

test('focusing another window tab revokes; failed focus check remains paused', async () => {
  const s=setup(); await s.request('enable'); const p=s.port(); s.sockets[0].open();
  s.chrome.tabs.query=async()=>{throw Error('window closed');};
  s.chrome.windows.onFocusChanged.fire(1); await Promise.resolve(); await Promise.resolve();
  assert.equal(s.sockets.length,1); assert.equal(p.disconnected,false);
  assert.equal(p.messages.at(-1).reason,'focus_check_failed');
  s.chrome.tabs.query=async()=>[{id:8}];
  s.chrome.windows.onFocusChanged.fire(2); await Promise.resolve();
  assert.equal(p.disconnected,true); assert.equal(s.port().disconnected,true);
});

test('content connecting during blur remains paused and cannot open a socket', async () => {
  const s=setup(); await s.request('enable');
  s.chrome.windows.onFocusChanged.fire(-1); const p=s.port();
  assert.equal(p.disconnected,false); assert.equal(s.sockets.length,0);
  assert.equal(p.messages.at(-1).type,'paused');
  s.chrome.windows.onFocusChanged.fire(1); await Promise.resolve();
  assert.equal(s.sockets.length,1);
  await s.request('disable');
});

test('pending focus query cannot reconnect after explicit stop', async () => {
  const s=setup(); await s.request('enable'); const p=s.port(); s.sockets[0].open();
  let finish;
  s.chrome.tabs.query=()=>new Promise(resolve=>finish=resolve);
  s.chrome.windows.onFocusChanged.fire(1);
  await s.request('disable'); finish([{id:7}]); await Promise.resolve();
  assert.equal(p.disconnected,true); assert.equal(s.sockets.length,1);
  assert.equal(s.port().disconnected,true);
});

test('popup selects only fixed tracker endpoints and revocation restores the webcam default', async () => {
  const s=setup();
  const enabled=await s.request('enable', undefined, {backend:'iphone'});
  assert.equal(enabled.backend,'iphone');
  assert.equal((await s.request('get_backend')).backend,'iphone');
  const p=s.port(); const first=s.sockets[0]; first.open();
  assert.equal(first.url,'ws://127.0.0.1:8767/ws');
  first.close(); s.runTimers();
  assert.equal(s.sockets[1].url,'ws://127.0.0.1:8767/ws');
  s.chrome.tabs.onActivated.fire({tabId:8});
  assert.equal(p.disconnected,true);
  assert.equal((await s.request('get_backend')).backend,'webcam');
  await s.request('enable'); s.port();
  assert.equal(s.sockets.at(-1).url,'ws://127.0.0.1:8765/ws');
  await s.request('disable');
});

test('arbitrary backend URLs and non-popup extension pages cannot change an approved source', async () => {
  const s=setup(); await s.request('enable'); const p=s.port(); s.sockets[0].open();
  for (const backend of ['ws://attacker.test/ws','ws://127.0.0.1:8767/ws','constructor',{},false]) {
    assert.equal((await s.request('enable', undefined, {backend})).ok,false);
  }
  assert.equal(p.disconnected,false); assert.equal(s.sockets.length,1);
  let replied=false;
  for (const sender of [{id:s.chrome.runtime.id}, {id:s.chrome.runtime.id,url:`chrome-extension://${s.chrome.runtime.id}/other.html`},
    {id:s.chrome.runtime.id,url:`chrome-extension://${s.chrome.runtime.id}/popup.html`,tab:{id:7}}]) {
    s.chrome.runtime.onMessage.fire({type:'enable',backend:'iphone'},sender,()=>replied=true);
  }
  await Promise.resolve();
  assert.equal(replied,false); assert.equal(s.injected.length,1);
  p.onMessage.fire({type:'enable',backend:'iphone'});
  assert.equal(s.sockets[0].sent.length,0);
  await s.request('disable');
});

test('changing backend revokes the old port and stale injection cannot override the newer choice', async () => {
  const s=setup(); await s.request('enable'); const old=s.port(); s.sockets[0].open();
  await s.request('enable',undefined,{backend:'iphone'});
  assert.equal(old.disconnected,true); assert.equal(s.sockets[0].closed,true);
  s.port(); assert.equal(s.sockets.at(-1).url,'ws://127.0.0.1:8767/ws');
  await s.request('disable');
  const pending=[];
  s.chrome.tabs.query=()=>new Promise(resolve=>pending.push(resolve));
  const a=s.request('enable',undefined,{backend:'iphone'});
  const b=s.request('enable',undefined,{backend:'webcam'});
  pending[1]([{id:7,url:'https://example.com'}]);
  assert.equal((await b).ok,true);
  pending[0]([{id:7,url:'https://example.com'}]);
  assert.equal((await a).ok,false);
  s.port(); assert.equal(s.sockets.at(-1).url,'ws://127.0.0.1:8765/ws');
  await s.request('disable');
});

test('popup sends the selected source and displays its matching launch command', async () => {
  const popupSource=await readFile(new URL('../browser-extension/popup.js',import.meta.url),'utf8');
  const nodes=new Map(['backend','command','source-help','enable','disable','status'].map(id=>[id,{value:id==='backend'?'webcam':'',textContent:''}]));
  const calls=[];
  const chrome={runtime:{id:'test-id',async sendMessage(message){calls.push(message);return {ok:true,backend:message.backend??'webcam'};}}};
  vm.runInNewContext(popupSource,{document:{querySelector:selector=>nodes.get(selector.slice(1))},chrome});
  await Promise.resolve();
  assert.match(nodes.get('command').textContent,/eye serve --extension-id test-id/);
  nodes.get('backend').value='iphone'; nodes.get('backend').onchange();
  assert.match(nodes.get('command').textContent,/python -m eye.iphone_server --extension-id test-id/);
  await nodes.get('enable').onclick();
  assert.equal(calls.at(-1).backend,'iphone');
  assert.match(nodes.get('status').textContent,/Enabled with iPhone/);
  const manifest=JSON.parse(await readFile(new URL('../browser-extension/manifest.json',import.meta.url),'utf8'));
  assert.equal(manifest.content_security_policy.extension_pages.split('connect-src ')[1], 'ws://127.0.0.1:8765 ws://127.0.0.1:8767');
});

test('recenter command is allowed only for the iPhone source and never during validation', async () => {
  const s=setup(); await s.request('enable',undefined,{backend:'iphone'});
  const p=s.port(); const ws=s.sockets[0]; ws.open();
  p.onMessage.fire({type:'calib_finish',recenterOnly:true});
  p.onMessage.fire({type:'calib_finish',recenterOnly:true,validateOnly:true});
  p.onMessage.fire({type:'calib_finish',recenterOnly:'true'});
  assert.deepEqual(ws.sent,[{type:'calib_finish',validateOnly:false,recenterOnly:true},
    {type:'calib_finish',validateOnly:true},{type:'calib_finish',validateOnly:false}]);
  await s.request('enable'); const webcam=s.port(); s.sockets.at(-1).open();
  webcam.onMessage.fire({type:'calib_finish',recenterOnly:true});
  assert.deepEqual(s.sockets.at(-1).sent,[{type:'calib_finish',validateOnly:false}]);
  await s.request('disable');
});

async function contentFixture() {
  const entry=await readFile(new URL('../browser-extension/content-entry.js',import.meta.url),'utf8');
  const nodes=new Map(['status','selection','setup','fullscreen','drift','validate','stop'].map(id=>[id,{textContent:'',disabled:false}]));
  const shadow={querySelector:selector=>nodes.get(selector.slice(1)),innerHTML:''};
  const host={dataset:{},style:{},attachShadow:()=>shadow,remove(){}};
  let navigation=0;
  class Client {
    constructor(){this.handlers={};this.calls=[];this.current={connected:false,calibrated:false};}
    on(type,fn){(this.handlers[type]??=[]).push(fn);return()=>{};}
    status(){return this.current;}
    emit(type,value){if(type==='status')this.current=value;for(const fn of this.handlers[type]??[])fn(value);}
    async calibrate(options){this.calls.push({method:'calibrate',options});return{ok:true,applied:true,recenterOnly:options?.recenterOnly};}
    async validate(){this.calls.push({method:'validate'});return{ok:true,validation:{meanDeg:1}};}
    close(){}
  }
  const context={EyeClient:Client,GazeDOMTargets:class{on(){}destroy(){}},Element:class{},
    document:{createElement:()=>host,documentElement:{append(){},async requestFullscreen(){navigation++;}}},
    window:{addEventListener(){},removeEventListener(){}},chrome:{}};
  vm.runInNewContext(entry,context);
  return {eye:context.__eyeDOM.eye,nodes,navigation:()=>navigation};
}

test('iPhone panel requires console calibration then sends center-only recenter without navigation', async () => {
  const {eye,nodes,navigation}=await contentFixture();
  eye.emit('status',{connected:true,calibrated:false,canCalibrate:true});
  eye.emit('message',{type:'hello',backend:{name:'iphone-arkit'}});
  assert.equal(nodes.get('drift').textContent,'recenter');
  assert.equal(nodes.get('drift').disabled,true);
  assert.match(nodes.get('setup').textContent,/First calibrate at http:\/\/127.0.0.1:8767/);
  await nodes.get('drift').onclick(); assert.equal(eye.calls.length,0);
  eye.emit('status',{connected:true,calibrated:true});
  await nodes.get('drift').onclick();
  const call=eye.calls.at(-1);
  assert.equal(call.method,'calibrate'); assert.equal(call.options.recenterOnly,true);
  assert.equal(JSON.stringify(call.options.points),'[[0.5,0.5]]');
  assert.equal(call.options.sampleMs,2200); assert.equal(call.options.settleMs,800);
  assert.match(nodes.get('selection').textContent,/center offset corrected/);
  assert.equal(nodes.get('setup').textContent,'');
  assert.equal(navigation(),0);
  await nodes.get('validate').onclick(); assert.equal(eye.calls.at(-1).method,'validate');
  eye.emit('status',{connected:false,calibrated:true});
  assert.equal(nodes.get('drift').disabled,true);
});

test('webcam panel preserves existing drift correction and does not claim an unsupported recenter succeeded', async () => {
  const {eye,nodes}=await contentFixture();
  eye.emit('status',{connected:true,calibrated:true});
  eye.emit('message',{type:'hello',backend:{name:'mgazenet'}});
  await nodes.get('drift').onclick();
  assert.equal(nodes.get('drift').textContent,'correct drift');
  assert.equal(eye.calls.at(-1).options,undefined);
  assert.match(nodes.get('selection').textContent,/drift correction applied/);
  eye.emit('message',{type:'hello',backend:{name:'iphone-arkit'}});
  eye.calibrate=async()=>({ok:true,applied:false,reason:'offset too large'});
  await nodes.get('drift').onclick();
  assert.match(nodes.get('selection').textContent,/current mapping unchanged: offset too large/);
});
