const backend = document.querySelector('#backend');
let changed = false;
const renderSource = () => {
  const iphone = backend.value === 'iphone';
  document.querySelector('#command').textContent = iphone
    ? `uv run --extra appearance python -m eye.iphone_server --extension-id ${chrome.runtime.id}`
    : `uv run --extra appearance eye serve --extension-id ${chrome.runtime.id}`;
  document.querySelector('#source-help').textContent = iphone
    ? 'First calibrate your mounted iPhone in the local console at http://127.0.0.1:8767/. Then enable this tab.'
    : 'Use your saved Mac webcam calibration. Start the local tracker before enabling this tab.';
};
backend.onchange = () => { changed = true; renderSource(); };
renderSource();
chrome.runtime.sendMessage({type:'get_backend'}).then(response => {
  if (!changed && ['webcam','iphone'].includes(response?.backend)) {
    backend.value = response.backend;
    renderSource();
  }
}).catch(() => {});
for (const type of ['enable', 'disable']) document.querySelector(`#${type}`).onclick = async () => {
  const status = document.querySelector('#status');
  changed = true;
  try {
    const response = await chrome.runtime.sendMessage({type, ...(type === 'enable' ? {backend:backend.value} : {})});
    status.textContent = response?.ok ? (type === 'enable' ? `Enabled with ${response.backend === 'iphone' ? 'iPhone' : 'Mac webcam'}. Close this popup to use the page controls.` : 'Stopped.') : response?.error ?? 'Could not connect.';
  } catch (error) { status.textContent = error.message; }
};
