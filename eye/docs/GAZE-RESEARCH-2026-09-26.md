# Webcam Gaze Tracking: Research and Recommended Experiments

Research date: September 26, 2026. This report supersedes the deployment recommendations in `eye/RESEARCH.md`; that older document combines different benchmarks and describes an older implementation. No model replacement was installed during this research.

## Recommendation

Keep the current landmark model as a baseline. Fix the calibration recovery flow, then benchmark a pretrained appearance-based model with personal screen calibration. More dots and stronger smoothing alone are not a convincing route to robust tracking. A replacement must demonstrate improvement on this laptop, with head movement and after a restart.

The immediate product target should be reliable selection among large screen regions. Reliable word-level or small-button targeting has not been demonstrated.

## Evidence from this laptop

The saved second fresh run (`calib-20260926-143304.npz`, kept privately outside the repository) contains 1,480 training samples. Independent validation reports:

| Measure | Result |
|---|---:|
| Mean frame error | 154.79 screen points |
| 90th percentile frame error | 284.17 screen points |
| Worst frame error | 575.57 screen points |
| Neutral-head mean error | 102.84 screen points |
| Moving-head mean error | 187.25 screen points |
| Usable validation coverage | 559/569 frames, 98.24% |
| Observed validation targets | 14/14 |

The mean is approximately 3.21° using the application's assumed 55 cm viewing distance. Screen points are not physical Retina pixels, and the angular conversion is not an independently measured viewing distance.

The failed validation-completeness check has a specific cause: one center target had 15/25 usable frames (60%) because of a roughly 0.33-second blink. All other targets had 100% coverage. The per-target 80% requirement is reasonable for reporting coverage, but the fixed 0.85-second acquisition window and full-redo workflow are poor recovery behavior. Retry the affected target and preserve the rejected-frame accounting.

After restart, a diagnostic sample measured yaw around −21.5°, outside the saved gate of approximately −7.0° to +13.3°. Several position/roll dimensions were outside their bounds too. This explains the immediate dropout; it does not establish that remaining inside the gate would give acceptable accuracy. The gate is a hand-built envelope, not a calibrated probability of correctness.

## What the research supports

**Landmarks are not a trained gaze estimator.** Google explicitly distinguishes iris landmark tracking from determining where someone is looking. Our current mapping uses 16 eye/head measurements and linear ridge regression; the saved calibration provides its screen mapping. This is a useful inexpensive baseline, but face detection success does not prove gaze accuracy. [Google Research](https://research.google/blog/mediapipe-iris-real-time-iris-tracking-depth-estimation/)

**Head movement and viewing distance need explicit treatment.** Research on image normalization shows that accounting for geometric variation matters for appearance-based estimation. A face-aligned landmark frame is not equivalent to the complete image normalization expected by a pretrained model. Preserve each candidate's preprocessing conventions. [Zhang, Sugano, and Bulling, ETRA 2018](https://www.collaborative-ai.org/publications/zhang18_etra/)

**Personalized image models are credible candidates, not guaranteed fixes.** FAZE learns representations from eye imagery and adapts to individuals with few labeled calibration samples. A separate study of 65 participants using home webcams reported its best fixation accuracy at 2.4° and precision at 0.47°. That study processed recordings offline; its fixation metric and runtime are not directly comparable with our per-frame live error. [FAZE authors](https://research.nvidia.com/publication/2019-10_few-shot-adaptive-gaze-estimation), [Saxena et al., Behavior Research Methods](https://link.springer.com/article/10.3758/s13428-023-02190-6)

**Do not overgeneralize the older report's 31° figure.** The cited 2026 preprint reports ridge angular RMSE of 3.78° still and 31.07° with pose changes in a particular 33-run evaluation at about 100 cm. That evaluation has partial participant overlap. It illustrates a failure mode; it is not an expected accuracy for every landmark implementation or a direct comparison with this laptop. [EMC-Gaze preprint, Table 1 and limitations](https://arxiv.org/html/2603.12388v1)

## Candidates to benchmark

| Candidate | Why test it | Limits of the evidence |
|---|---|---|
| Current linear landmark ridge | Existing transport, low cost, reproducible baseline | Narrow learned pose coverage; observed motion sensitivity |
| GazeFollower | Webcam system with pretrained image model and personal calibration | Paper reports 1.11 cm calibrated and 0.92 cm after fine-tuning in its evaluation, not this setup; repository is CC BY-NC-SA and fine-tuning code requires contacting authors |
| FAZE | Published few-shot personalization and a webcam demo | Older dependency stack; Mac latency and integration need measurement |
| MobileGaze/L2CS family | Available gaze-direction models and ONNX path | Direction output still needs screen mapping; Gaze360 metrics cannot be treated as calibrated laptop point accuracy |

GazeFollower is the most directly relevant research comparator, subject to its noncommercial terms. Its reported results are not a promise of equal performance here. [Paper](https://doi.org/10.1145/3729410), [official repository](https://github.com/GanchengZhu/GazeFollower)

MobileGaze's author reports 11.33° MAE for ResNet-34 and 12.58° for MobileOne S0 on its Gaze360 task. The older local report's blanket 3.9–6° comparison should not be used to choose these weights. Verify exact checkpoint provenance: Gaze360's own license restricts database/models and trained derivatives to research use. [Author documentation](https://yakhyo.github.io/blog/2024/09/gaze-estimation/), [Gaze360 terms](https://github.com/erkil1452/gaze360/blob/master/LICENSE.md)

## Implementation order

1. **Repair acquisition and feedback.** Show face/pose readiness before starting. Retry a low-coverage target after a blink; use bounded acquisition time and an actionable failure message. Explain which direction to reposition when the pose gate rejects input.
2. **Separate accuracy from availability.** Report pixel/point mean, median, p90, usable-frame coverage, and rejection reasons. Keep static and moving-head scores separate. Retain full target coverage checks.

   Also select regression hyperparameters using screen-distance or angular error. Current cross-validation uses Euclidean normalized coordinates, which treat a full screen width and height equally despite their different physical sizes. Balance target/pose conditions when comparing models.
3. **Add one appearance-model adapter.** Keep the websocket and browser code. Run the candidate alongside the baseline from the same camera frames, applying the model's specified image preprocessing and a small personal screen mapping. Benchmark actual Apple Silicon inference latency before selecting it.
4. **Collect one shared evaluation session.** The current archives save landmarks, blendshapes, transforms and timing—not RGB frames or eye crops—so they cannot be replayed through image models. Compute both models' features during one new session, or explicitly support local image/crop recording for offline comparisons. No upload is needed.
5. **Test the actual UI task.** Evaluate correct/incorrect/abstained tile assignments, time to acquire a tile, and recovery after leaning or looking away. Use fresh targets, repeat after 5–10 minutes, and test a process restart. Do not tune on the final validation targets.

Proposed acceptance targets, not published guarantees: at least 95% correct classifications among emitted four-tile selections, at least 90% coverage during instructed on-screen viewing, and a material p90 error improvement over the baseline without unacceptable lag. Report both correctness and abstention so a system that withholds everything cannot appear successful.

Until those tests pass, the defensible claim is that the camera and transport work and calibration data were collected. Reliable attention tracking remains unproven.
