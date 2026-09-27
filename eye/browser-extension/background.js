// Only the user-enabled tab receives gaze. No page scripts, URLs, or DOM data
// are sent to the tracker; selection stays inside the content script.
const TRACKERS = Object.freeze({webcam: 'ws://127.0.0.1:8765/ws', iphone: 'ws://127.0.0.1:8767/ws'});
let approvedBackend = 'webcam';
let approvedTab = null;
let port = null;
let socket = null;
let retry = null;
let generation = 0;
let paused = false;
let focusGeneration = 0;
function pause(reason = 'window_blur') {
  paused = true;
  clearTimeout(retry);
  retry = null;
  const old = socket; socket = null; old?.close();
  try { port?.postMessage({type: 'paused', reason}); } catch { stop(); }
}
function stop() {
  generation += 1;
  focusGeneration += 1;
  paused = false;
  approvedTab = null;
  approvedBackend = 'webcam';
  clearTimeout(retry);
  const old = socket; socket = null; old?.close();
  const oldPort = port; port = null;
  try { oldPort?.postMessage({type: 'disabled'}); } catch {}
  oldPort?.disconnect();
}
function connect() {
  clearTimeout(retry);
  if (paused || socket || !port || approvedTab === null) return;
  const ws = new WebSocket(TRACKERS[approvedBackend]);
  socket = ws;
  ws.onopen = () => { if (socket === ws) port?.postMessage({type: 'open'}); };
  ws.onmessage = (event) => {
    if (socket !== ws || !port) return;
    try { port.postMessage({type: 'sample', data: JSON.parse(event.data)}); } catch { stop(); }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    try { port?.postMessage({type: 'offline'}); } catch { stop(); return; }
    retry = setTimeout(connect, 1500);
  };
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // Only extension popup messages, never page/content messages, authorize access.
  if (sender.tab || sender.id !== chrome.runtime.id || sender.url !== `chrome-extension://${chrome.runtime.id}/popup.html`) return;
  if (message.type === 'get_backend') { reply({ok: true, backend: approvedBackend}); return; }
  if (message.type === 'disable') { stop(); reply({ok: true}); return; }
  if (message.type !== 'enable') return;
  const backend = message.backend ?? 'webcam';
  if (!['webcam', 'iphone'].includes(backend)) { reply({ok: false, error: 'Choose webcam or iPhone.'}); return; }
  stop();
  const requestGeneration = generation;
  (async () => {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab?.id || !/^https?:\/\//.test(tab.url ?? '')) throw new Error('Open a regular http/https page first.');
    if (requestGeneration !== generation) throw new Error('Enable cancelled.');
    approvedBackend = backend;
    approvedTab = tab.id;
    try {
      await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ['content.js']});
      if (requestGeneration !== generation) throw new Error('Enable cancelled.');
      reply({ok: true, backend});
    } catch (error) { if (requestGeneration === generation) stop(); throw error; }
  })().catch(error => reply({ok: false, error: error.message}));
  return true;
});
chrome.runtime.onConnect.addListener((incoming) => {
  if (incoming.sender?.id !== chrome.runtime.id || port || incoming.name !== 'eye-dom' || incoming.sender?.tab?.id !== approvedTab ||
      incoming.sender?.frameId !== 0) { incoming.disconnect(); return; }
  port = incoming;
  incoming.onDisconnect.addListener(() => { if (port === incoming) stop(); });
  incoming.onMessage.addListener(message => {
    if (port !== incoming || socket?.readyState !== WebSocket.OPEN) return;
    // Explicit user-triggered calibration uses the same protocol as our demo.
    const command = sanitizeCommand(message);
    if (command) socket.send(JSON.stringify(command));
  });
  if (paused) incoming.postMessage({type: 'paused', reason: 'window_blur'});
  else connect();
});
chrome.tabs.onActivated.addListener(({tabId}) => { if (approvedTab !== null && tabId !== approvedTab) stop(); });
chrome.tabs.onRemoved.addListener(tabId => { if (tabId === approvedTab) stop(); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId === approvedTab && change.status === 'loading') stop();
});
chrome.windows.onFocusChanged.addListener(windowId => {
  const requestFocus = ++focusGeneration;
  if (windowId === chrome.windows.WINDOW_ID_NONE) { pause(); return; }
  if (approvedTab === null) { paused = false; return; }
  // Close the transport immediately, even when moving straight between browser
  // windows; only a fresh active-tab check can resume this approval.
  pause('checking_active_tab');
  const requestGeneration = generation;
  const requestTab = approvedTab;
  chrome.tabs.query({active: true, windowId}).then(([tab]) => {
    if (requestFocus !== focusGeneration || requestGeneration !== generation || approvedTab !== requestTab) return;
    if (tab?.id !== requestTab) { stop(); return; }
    paused = false;
    connect();
  }).catch(() => {
    if (requestFocus === focusGeneration && requestGeneration === generation) pause('focus_check_failed');
  });
});

function sanitizeCommand(message) {
  if (!message || typeof message !== 'object') return null;
  const {type} = message;
  if (['hello', 'calib_begin', 'calib_reset'].includes(type)) return {type};
  if (type === 'calib_target') {
    if (!Number.isFinite(message.x) || !Number.isFinite(message.y)) return null;
    return {type, x: message.x, y: message.y, retry: message.retry === true};
  }
  if (type === 'calib_target_end') {
    const result = {type, validateOnly: message.validateOnly === true};
    if (Number.isSafeInteger(message.requestId) && message.requestId >= 0) result.requestId = message.requestId;
    return result;
  }
  if (type === 'calib_finish') {
    const result = {type, validateOnly: message.validateOnly === true};
    if (approvedBackend === 'iphone' && !result.validateOnly && message.recenterOnly === true) result.recenterOnly = true;
    return result;
  }
  return null;
}
