# Eye DOM Selector for Chrome

This extension draws a gaze highlight over an eligible page control. After 350 ms
of stable, unambiguous gaze, **Alt+Enter** selects the control, focuses it, and
shows a CSS selector and semantic descriptor. It never clicks automatically.
Use the ordinary keyboard action appropriate to the focused control to activate it.

## Run

1. From `eye/`, run `node browser-extension/build.mjs`.
2. In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load
   unpacked**, and select `eye/browser-extension/dist` in this repository.
3. Open the extension popup. It shows the exact command containing its extension
   ID. Stop any existing eye tracker, then run that command from the `eye` folder:

   ```sh
   uv run --extra appearance eye serve --extension-id YOUR_EXTENSION_ID
   ```

4. Open a regular webpage, click the extension, and choose **Enable this tab**.
   Close the popup and click **enter fullscreen** in the page panel. Stay on the
   calibrated display at 100% browser zoom.
5. Use **correct drift** if needed, then **measure accuracy**. Look at a well-spaced
   control. Amber means a candidate is settling; green means it can be selected
   with Alt+Enter. The selector appears in the panel after confirmation.
6. For crowded controls, look near the group and press **Alt+Space**. A short
   numbered list opens; press **1–9** to select and focus a listed control, or
   **Escape** to dismiss it. Selection still does not click. Layout changes or
   tracking loss dismiss the list.
7. **Stop**, navigation, or changing tabs disables the session. Enable the desired
   tab again to resume. Switching away from Chrome pauses the stream; returning
   to the same enabled tab resumes it.

The tracker demo at `http://127.0.0.1:8765/` has the same DOM targeting without
installing an extension. It is the easiest place to test first.

## Boundaries

- Chrome 116+; top-document light DOM only. Cross-origin iframes, shadow-root
  controls, Chrome internal pages, and extension-store pages are not supported.
- Uses `activeTab` + `scripting`, with localhost as the sole host permission.
  There is no persistent access to every website. Only the explicitly enabled
  tab receives gaze. Page content/selection descriptions are not sent to the
  gaze server or any cloud service.
- The server accepts the exact configured extension origin only for `/ws`.
  Normal website origins remain blocked. Never add an unrestricted origin wildcard.
- Fullscreen is deliberate: ordinary window toolbar offsets are not a reliable
  screen-to-DOM coordinate transform. Mapping pauses if geometry is unknown.
- Dense controls inside the estimated error radius remain automatically unassigned;
  Alt+Space provides explicit numbered disambiguation. A highlight
  is an estimate, not proof of intended selection. Unmeasured uncertainty disables
  targeting. Fresh live validation is needed after setup changes.
- CSS selectors describe the current DOM. Re-resolve and check identity before
  using a descriptor after a navigation or page update. No activation is implied
  by receiving a selection event.

## Implementation

`build.mjs` packages the shared dependency-free EyeClient and GazeDOMTargets into
an isolated-world content script. The service worker owns the localhost WebSocket
and forwards only the gaze protocol. It never receives DOM descriptors.
The page panel handles fullscreen/calibration through explicit user actions.

Chrome references: [activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
and [service-worker WebSockets](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets).
