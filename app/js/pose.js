// MediaPipe Pose Landmarker (runs in the browser via WASM + WebGL).
const VER = '0.10.14';
const BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}`;
const MODELS = {
  lite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  heavy: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task',
};

let modPromise = null, visionPromise = null;

async function getVision() {
  modPromise ??= import(`${BASE}/vision_bundle.mjs`);
  const mod = await modPromise;
  visionPromise ??= mod.FilesetResolver.forVisionTasks(`${BASE}/wasm`);
  return { mod, vision: await visionPromise };
}

export async function createLandmarker(model = 'lite', numPoses = 3, runningMode = 'VIDEO') {
  const { mod, vision } = await getVision();
  const opts = delegate => ({
    baseOptions: { modelAssetPath: MODELS[model] || MODELS.lite, delegate },
    runningMode,
    numPoses,
    minPoseDetectionConfidence: 0.35,
    minPosePresenceConfidence: 0.35,
    minTrackingConfidence: 0.35,
  });
  try {
    return await mod.PoseLandmarker.createFromOptions(vision, opts('GPU'));
  } catch (e) {
    console.warn('GPU delegate failed, falling back to CPU', e);
    return await mod.PoseLandmarker.createFromOptions(vision, opts('CPU'));
  }
}

// MediaPipe 33-landmark indices used across the app
export const L = {
  nose: 0, ls: 11, rs: 12, le: 13, re: 14, lw: 15, rw: 16,
  lh: 23, rh: 24, lk: 25, rk: 26, la: 27, ra: 28, lheel: 29, rheel: 30, lfoot: 31, rfoot: 32,
};

export const BONES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28], [27, 29], [28, 30], [29, 31], [30, 32], [27, 31], [28, 32],
  // hands: wrist -> pinky (17/18), index (19/20), thumb (21/22)
  [15, 17], [17, 19], [15, 19], [15, 21], [16, 18], [18, 20], [16, 20], [16, 22],
];
