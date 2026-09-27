# iPhone gaze: research and implementation audit

Research date: 2026-09-26. This document separates measured results, published evidence, and proposed experiments. No runtime or calibration was changed during this research.

## Recommendation

Keep TrueDepth/ARKit for metric head and eye geometry, but stop treating its fused gaze estimate plus a linear fit as the final estimator. First benchmark better use of the geometry already transmitted; then compare a personalized appearance model using synchronized iPhone RGB images. Evaluate both on identical recorded observations and an untouched later session. More smoothing is not the priority.

## What our measurements establish

Latest independent validation: mean 120.99 screen points, p90 202.66, 100% accepted-sample coverage. Angular equivalents of 2.51°/4.21° assume 55 cm viewing distance and are not directly measured angles. Across targets, mean error ranges 73–239 points, while within-target RMS jitter is only 9–25 points. Remaining error is predominantly position-dependent bias. A stable but wrong cursor is still wrong.

The earlier 283.68-point mean and latest 120.99-point mean were produced after different calibrations as well as recentering. This is not a controlled estimate of recentering's benefit.

## What primary sources support

| Source | Evidence | Implication and limit |
|---|---|---|
| [Apple: lookAtPoint](https://developer.apple.com/documentation/arkit/arfaceanchor/lookatpoint) | An estimated gaze target in face coordinates, abstracted from left/right eye transforms. | It is a useful baseline signal, not a precision guarantee. |
| [Apple: TrueDepth capture](https://developer.apple.com/documentation/avfoundation/avcapturedevice/devicetype-swift.struct/builtintruedepthcamera) | TrueDepth combines infrared and YUV cameras and supplies aligned depth information. | Public depth/color capture is distinct from direct infrared pupil/glint imaging. The current app has no raw-IR video pipeline. |
| [Taore et al., Journal of Vision 2024](https://pmc.ncbi.nlm.nih.gov/articles/PMC11223623/) | ARKit iPad gaze has errors of several degrees, much worse than the comparison tracker; the study also reports retest variability and tracking failures. | Our approximate 2.5° result is plausible for this family of approach. Different hardware, tasks and measurement protocols prevent direct ranking. |
| [Google Research, personalized smartphone gaze](https://research.google/blog/accelerating-eye-movement-research-for-wellness-and-accessibility/) | Eye-image CNN plus personal regression reduced phone-screen error from 1.92 to 0.46 cm using about 30 seconds of calibration; reported angular equivalent 0.6–1° at 25–40 cm. | Strong evidence that learned eye appearance and personalization can outperform a generic estimate. These are phone-screen, near-frontal conditions—not an external laptop guarantee. |
| [FAZE, ICCV 2019](https://github.com/NVLabs/few_shot_gaze) | Released code and real-time demo for few-shot personalized gaze estimation. | A useful personalization reference, with older dependencies; not an accuracy promise for this setup. |
| [UniGaze, WACV 2026](https://github.com/ut-vision/UniGaze) | Released gaze-trained checkpoints, normalized-face inference and dataset normalization code. Model terms are explicitly noncommercial. | A concrete research challenger. Our existing B adapter can be reused; a larger model is not automatically a better end-to-end tracker. |
| [Open-domain gaze preprint, March 2026](https://arxiv.org/abs/2603.26945) | Reports improved robustness using appearance augmentation and multitask training, with a lightweight MobileNet model. | Supports testing illumination, glasses and occlusion robustness. I did not verify released runnable weights, so it is a methodological reference, not the first integration choice. |
| [COMETIC, CHI 2025 paper](https://pi.cs.tsinghua.edu.cn/wp-content/uploads/2025/06/3706598.3713936.pdf) | Uses filtered cursor interactions as gaze proxies for personalization; the published paper reports 27.2% improvement and 2.29° mean error. | Supports carefully filtered interactive correction. Mouse position is not always gaze. The author project page contains different figures; use the linked published paper rather than mixing results. |

## Specific deficiencies in our implementation

1. **Information discarded:** `iphone_tracking.py` uses eye translations for a midpoint but discards separate eye rotations, despite the native app sending both full transforms. A fused `lookAtPoint` ray may lose useful binocular disagreement and directional information. Separate eyes could also be noisier; compare rather than assume.
2. **Limited mapping:** the current model is degree-1 ridge on 12 features: direction, origin, and head rotation. Ray/screen intersection involves products and division; a linear map cannot represent the full relationship under movement. A full physical eye model also has identifiability problems, so do not fit an unconstrained pile of geometric parameters to one short sweep.
3. **Depth is not an explicit correction:** the phone supplies optional center-patch depth. Our estimator does not consume that statistic or camera intrinsics. ARKit metric pose may already benefit from depth, but the status text alone does not establish that our mapping uses a measured screen geometry.
4. **Calibration confounding:** fixed-order targets paired with gentle head movement can associate particular targets with particular poses. Repeated randomized targets across deliberately varied pose blocks are more informative than simply collecting more consecutive frames.
5. **Weak experimental reuse:** calibration features are cleared after fitting and models reset at disconnect. We cannot fairly compare multiple estimators on the exact same phone observations, so changes currently demand too many live recalibrations.
6. **Quality versus availability:** blink and packet checks do not establish stable fixation, in-range head pose, agreement between eyes, or a fixed phone mount. Report each of those separately from frame coverage.

No obvious camera/world multiplication or column-major decoding defect was found in this read-only audit. Independent validation uses frozen raw predictions and does not train on validation labels. However, repeated tuning against the same nine validation positions makes them a development set; retain a genuinely new final session.

## Next experiment, in order

1. **Record once, replay many candidates.** Start with a local feature-only recording: both eye transforms, face/camera transforms, target episode, pose block, capture and receive timestamps, frame validity, calibration version, and predictions. Keep phone images optional until the appearance experiment. Preserve completed reports across disconnects, without silently restoring a calibration after a changed mount.
2. **Remove confounding.** Randomize target order; repeat targets across a neutral-pose block and separate modest movement blocks. Include a head-only baseline to detect whether the estimator is predicting posture instead of eyes. Reserve later postures and a later session for evaluation.
3. **Compare geometry candidates.** Current fused ray; independent-eye directions with disagreement gating; ray slopes/projective features; constrained ray/plane geometry with personal visual-axis correction; a small regularized nonlinear residual model. Select on grouped development data, then freeze. No printed board is required for an empirical screen mapping.
4. **Add the appearance challenger.** Capture synchronized unmirrored RGB and native camera intrinsics with eye/head metadata. Correctly account for orientation, cropping, resolution, camera-axis conversion and distortion. Native intrinsics remove the need to guess focal length or require a printed board, but do not locate the laptop screen plane. Run the existing UniGaze-B adapter on the Mac first; compare learned representations plus personal regression against ARKit alone and their combination. Keep the original model normalization until a measured ablation justifies changing it.
5. **Judge the complete system.** Report target-macro mean/p90 error, coverage, pose-specific errors, drift, end-to-end age/latency, and correct DOM selection rate/time at defined target sizes. Measure raw and smoothed output separately. A model-only latency number is not capture-to-browser latency.

The existing UniGaze document reports prior synthetic/fixture timing, not iPhone accuracy: model/geometry inference around 13 ms, full landmark pipeline around 64 ms on the tested Mac setup. These measurements must be repeated on actual iPhone frames. Inspect `docs/GAZE-UNIGAZE.md` and `eye/src/eye/unigaze_backend.py` before integrating rather than rebuilding the adapter.

## Augmentation, heat maps and VLMs

Appearance augmentation is relevant once we have image-based training or adaptation: exposure, color, blur, noise and partial occlusion. Geometric augmentation must transform labels, intrinsics and pose consistently; arbitrary eye warps or feature noise cannot manufacture correct gaze supervision. Ordinary head translation while fixating a target supplies more defensible real variation.

A depth map estimates surfaces; it does not directly identify the personal visual axis. A gaze heat map can represent uncertainty over screen positions. These are different quantities and should remain separate in the design.

A general VLM is not the first gaze sensor to try. It may help interpret task context or describe candidate controls, but semantic plausibility must not override measured eye evidence. For browser targeting the DOM already gives exact element bounds and semantics. Test a specialized gaze estimator first, then use a calibrated spatial likelihood to rank visible DOM candidates with explicit confirmation and abstention.

## Decision gates

Proposed engineering targets, not literature promises: first demonstrate a substantial reproducible reduction from the 121-point baseline on an untouched session without reducing coverage; then measure correct selection on 80–120 point controls and ordinary small browser links separately. Record user task success rather than claiming that snapping proves the underlying gaze is accurate. If appearance fusion cannot materially improve this setup, present the measured ceiling and consider dedicated eye-tracking hardware instead of continuing an endless calibration loop.
