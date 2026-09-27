# Browser gaze upgrade follow-through

## Scope

Make crowded webpages usable through explicit disambiguation, then verify the unpacked Chrome extension on a normal page. Keep the active tracking model from the previous validated implementation; no new accuracy claim without fresh human measurements.

## Acceptance

- Nearby controls can be listed only on an explicit keyboard command.
- Numbered selection focuses and reports the intended current DOM element, never clicks it.
- Loss, stale gaze, scroll, changed layout, and removed/disabled elements prevent obsolete confirmation.
- Shared demo and extension include the same updated module and instructions.
- Extension loading requires action-time confirmation under the computer-use installation policy; finish the build/tests before asking.

## Status

Dense-target implementation complete; 40 browser/extension tests passed. User approved loading and testing the local extension. Installed in Chrome with ID `mpiilahdpllffioegckmmghkhabgcgoc`; localhost server restarted with that exact origin allowed. Real example.com page displayed the injected controls and live tracker status. A follow-up fixes focus-switch interruption: pause the stream while Chrome is inactive, retain the panel, and resume only on the same approved tab.

## Final verification

- 46 Node browser/extension tests passed; extension build, content/background syntax checks, and whitespace checks passed. No tracker-model changes this turn.
- Chrome visibly confirmed Eye DOM Selector version0.2.0 reloaded, ID `mpiilahdpllffioegckmmghkhabgcgoc`.
- Before final reload, injected controls and live gaze status were observed on example.com and Google; user ran drift correction on Google (reported applied, held-out correction estimate1.21°, not independent accuracy).
- Final reload revokes per-tab approval as intended. Re-enabling Google after reload could not be completed reliably through the browser UI tool; leave the user on Google and have them choose Eye DOM Selector → Enable this tab → enter fullscreen. Local tracker remains running with exact extension origin allowed.
- Numbered-choice behavior is covered by automated tests; complete live selection/activation was not verified.
