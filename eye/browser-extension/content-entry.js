// Runs in Chrome's isolated world. Re-enabling replaces any prior installation.
globalThis.__eyeDOM?.destroy();
const host = document.createElement('div');
host.dataset.eyeUi = 'true';
host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483646';
const shadow = host.attachShadow({mode:'closed'});
shadow.innerHTML = `<style>:host{all:initial}section{width:290px;padding:14px;border-radius:12px;background:#121722;color:#eef4ff;font:13px/1.45 system-ui;box-shadow:0 3px 20px #0008}button{font:inherit;margin:3px;padding:6px;border:1px solid #8d9bb6;border-radius:5px;background:#25324b;color:white;cursor:pointer}p{margin:6px 0}code{display:block;overflow-wrap:anywhere;max-height:80px;overflow:auto;user-select:text;font-size:11px}small{color:#b5c4de}</style><section><strong>eye · DOM selector</strong><p id="status" role="status">connecting to local tracker…</p><button id="fullscreen">enter fullscreen</button><button id="drift">correct drift</button><button id="validate">measure accuracy</button><button id="stop">stop</button><p><small>look to highlight · Alt+Enter selects and focuses<br>Alt+Space opens nearby choices · 1–9 chooses<br>ordinary Enter/Space activates the focused control</small></p><p id="setup"></p><code id="selection">no selection</code></section>`;
document.documentElement.append(host);
let channel;
let destroyed = false;
function transport() {
  channel = chrome.runtime.connect({name:'eye-dom'});
  const state = {send(text) { channel.postMessage(JSON.parse(text)); }, close() { channel.disconnect(); }};
  channel.onMessage.addListener(message => {
    if (destroyed) return;
    if (message.type === 'open') state.onopen?.();
    else if (message.type === 'sample') state.onmessage?.({data:JSON.stringify(message.data)});
    else if (message.type === 'offline' || message.type === 'paused') {
      // Background owns reconnection. Keep this bridge alive and clear stale gaze.
      eye.connected = false; eye.face = false;
      eye._clear(null, message.type === 'paused' ? 'paused while Chrome is inactive' : 'local tracker disconnected; check extension ID and server'); eye._status();
    } else if (message.type === 'disabled') destroy();
  });
  channel.onDisconnect.addListener(() => { if (!destroyed) destroy(); });
  return state;
}
const eye = new EyeClient({transport, selector:'[data-eye-never-match]'});
const dom = new GazeDOMTargets(eye);
const status = shadow.querySelector('#status');
const selection = shadow.querySelector('#selection');
let iphone = false;
let busy = false;
let latestStatus = eye.status();
function refreshControls() {
  shadow.querySelector('#drift').textContent = iphone ? 'recenter' : 'correct drift';
  shadow.querySelector('#setup').textContent = iphone && !latestStatus.calibrated
    ? 'First calibrate at http://127.0.0.1:8767/ with the phone fixed beside your screen. Return here and enable this tab afterward.' : '';
  for (const id of ['drift','validate']) shadow.querySelector(`#${id}`).disabled = busy || !latestStatus.connected || !latestStatus.calibrated;
}
eye.on('message', message => {
  if (message.type === 'hello') { iphone = message.backend?.name === 'iphone-arkit'; refreshControls(); }
});
eye.on('status', value => {
  latestStatus = value;
  status.textContent = value.valid ? 'tracking · look at a distinct control' : value.guidance || value.reason || (value.connected ? 'waiting for usable gaze' : 'local tracker unavailable; check server and extension ID');
  refreshControls();
});
refreshControls();
dom.on('candidate', candidate => {
  if (!candidate) return;
  // Detailed descriptors are surfaced only when the user explicitly selects.
});
dom.on('select', selected => {
  selection.textContent = JSON.stringify(selected.descriptor ?? selected, (key, value) =>
    value instanceof Element ? undefined : value, 2);
});
shadow.querySelector('#fullscreen').onclick = () => document.documentElement.requestFullscreen().catch(error => {status.textContent=error.message;});
for (const [id, validateOnly] of [['drift',false],['validate',true]]) shadow.querySelector(`#${id}`).onclick = async () => {
  if (busy || !latestStatus.connected || !latestStatus.calibrated) { refreshControls(); return; }
  busy = true; refreshControls();
  try {
    const result = validateOnly ? await eye.validate() : iphone
      ? await eye.calibrate({points:[[.5,.5]], recenterOnly:true, sampleMs:2200, settleMs:800,
          label:'LOOK AT THE CENTER · KEEP YOUR HEAD COMFORTABLE AND STILL'})
      : await eye.calibrate();
    if (!result.ok) status.textContent = result.error || 'calibration incomplete';
    else if (validateOnly) {
      const v = result.validation ?? {};
      selection.textContent = `measured error: mean ${v.meanDeg ?? '?'}°, p90 ${v.p90Deg ?? '?'}°, worst ${v.worstDeg ?? '?'}°. coverage ${Number.isFinite(v.coverage) ? Math.round(v.coverage * 100) : '?'}%. mapping unchanged.`;
      status.textContent = 'accuracy measured';
    } else if (iphone) {
      selection.textContent = result.recenterOnly && result.applied
        ? 'center offset corrected. measure accuracy on separate targets next; recentering is not proof of accuracy.'
        : `current mapping unchanged: ${result.reason || 'receiver did not apply recentering'}`;
      status.textContent = 'recenter check finished';
    } else {
      selection.textContent = `${result.applied ? 'drift correction applied' : 'kept current mapping'}; held-out estimate ${result.looDeg ?? '?'}°. ${result.reason || 'measure accuracy next.'}`;
      status.textContent = 'correction check finished';
    }
  } catch(error) { status.textContent=error.message; }
  finally { busy = false; refreshControls(); }
};
function destroy() {
  if (destroyed) return;
  destroyed=true;
  dom.destroy(); eye.close(); host.remove();
  window.removeEventListener('pagehide',destroy);
  if (globalThis.__eyeDOM?.destroy === destroy) delete globalThis.__eyeDOM;
}
shadow.querySelector('#stop').onclick = destroy;
window.addEventListener('pagehide',destroy);
globalThis.__eyeDOM = {destroy, eye, targets:dom};
