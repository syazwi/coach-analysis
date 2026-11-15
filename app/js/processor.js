import { FrameDetector } from './detector.js';
import { Tracker } from './tracking.js';
import { BallDetector } from './ball.js';
import { seekVideo, median } from './util.js';
import { areaOf, CROP_MAX } from './court.js';
import { toGrid } from './mask.js';
import { CameraCalibrationTracker } from './camera.js';

/** Every analysis time step across the game segments: [{ t, seg }]. */
export function frameTimes(segments, step) {
  const out = [];
  segments.forEach((g, seg) => { for (let t = g.start; t <= g.end + 1e-9; t += step) out.push({ t, seg }); });
  return out;
}

/**
 * Order in which frames are processed. Tracking starts at the calibration frame (where every
 * player was identified) and runs forward to the end, then backward from there to the start,
 * so identities are locked exactly where the coach drew them.
 * Returns { forward: [indices], backward: [indices] }.
 */
export function processingOrder(times, seedT) {
  const idx = times.map((_, i) => i);
  if (!Number.isFinite(seedT) || !times.length) return { forward: idx, backward: [] };
  let i0 = times.findIndex(f => f.t >= seedT - 1e-6);
  if (i0 < 0) i0 = times.length - 1;
  return { forward: idx.slice(i0), backward: idx.slice(0, i0).reverse() };
}

/**
 * Walks the video at cfg.fps, runs pose estimation (optionally on court-half crops), follows each
 * player's skeleton (seeded by player calibration) and the ball (using ball calibration).
 */
export async function processVideo(match, video, { onStatus, onProgress, onFrame, isCancelled }) {
  const { cfg, cal, players } = match;
  const vw = video.videoWidth, vh = video.videoHeight;

  onStatus?.('Loading pose model (first run downloads ~5–30 MB)…');
  const area = areaOf(cfg);
  const detector = await FrameDetector.create({ model: cfg.model, crops: cfg.crops, nPlayers: players.length, cal, vw, vh, mode: 'VIDEO', area, follow: true });
  const ignore = cfg.ignore?.cells?.length ? toGrid(cfg.ignore) : null; // eraser zones
  detector.setMask(ignore);

  const trackOpts = { trackBy: cfg.trackBy || 'skeleton' };
  const ball = cfg.ball ? new BallDetector(vw, vh, cal, cfg.ballCal || null, CROP_MAX) : null;
  if (ball) ball.mask = ignore;
  // game segments chosen in "Game time" (older analyses: a single start/end range)
  const segments = (cfg.segments?.length ? cfg.segments : [{ start: cfg.rangeStart || 0, end: cfg.rangeEnd || video.duration }])
    .map(g => ({ start: Math.max(0, g.start), end: Math.min(video.duration, g.end || video.duration) }))
    .filter(g => g.end > g.start);
  const step = 1 / cfg.fps;
  const times = frameTimes(segments, step);
  const seedTimes = players.map(p => p.seed?.t).filter(Number.isFinite);
  const { forward, backward } = processingOrder(times, seedTimes.length ? median(seedTimes) : NaN);
  const byIndex = new Array(times.length).fill(null);
  const t0 = performance.now();
  let done = 0;

  // one pass in a direction; time runs "virtually" forward for the tracker in both
  async function pass(order, dir) {
    if (!order.length) return true;
    const tracker = new Tracker(players, trackOpts);
    const camera = new CameraCalibrationTracker(cal, vw, vh);
    const tRef = times[order[0]].t;
    let prevSeg = -1;
    // Backward tracking starts from the same calibrated frame as the forward pass,
    // then follows camera motion in reverse toward the beginning.
    if (dir < 0 && forward.length) {
      await seekVideo(video, times[forward[0]].t);
      camera.update(video);
    }
    for (const i of order) {
      if (isCancelled?.()) return false;
      const { t, seg } = times[i];
      if (seg !== prevSeg) {
        if (ball) ball.prev = null; // no motion diff across a skipped gap
      }
      prevSeg = seg;
      const vt = dir > 0 ? t : tRef + (tRef - t);
      await seekVideo(video, t);
      const cameraState = camera.update(video);
      detector.setCalibration(cameraState.cal);
      ball?.setCalibration(cameraState.cal);
      tracker.setCameraTransform(cameraState.transform);
      const assigned = tracker.update(vt, detector.detect(video, step * 1000));
      // Follow/acquire: search a missed player around their saved calibration box first,
      // then around their last tracked skeleton once tracking has started.
      for (const { si, box } of tracker.followTargets(vt, assigned)) {
        for (const d of detector.detectBox(video, box, { pad: 0, all: true }).sort((a, b) => tracker.cost(tracker.slots[si], a, 1, vt) - tracker.cost(tracker.slots[si], b, 1, vt))) {
          if (tracker.claim(si, vt, d, assigned)) break;
        }
      }
      const b = ball ? ball.detect(video, t) : null;
      const sample = {
        t: +t.toFixed(3),
        c: cameraState.cal.imgPts.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]),
        cm: +cameraState.confidence.toFixed(2),
        p: assigned.map(d => (d ? { lm: d.lm, cx: +d.cx.toFixed(2), cy: +d.cy.toFixed(2), conf: +d.conf.toFixed(2) } : null)),
        b: b ? [+b[0].toFixed(4), +b[1].toFixed(4)] : null,
      };
      byIndex[i] = sample;
      done++;
      const frac = done / Math.max(1, times.length);
      const elapsed = (performance.now() - t0) / 1000;
      onProgress?.(frac, elapsed / Math.max(frac, 1e-3) - elapsed);
      onFrame?.(sample);
    }
    return true;
  }

  onStatus?.(`Following camera and players${backward.length ? ' from the calibration frame' : ''} (${segments.length} segment${segments.length > 1 ? 's' : ''})…`);
  try {
    if (await pass(forward, 1)) {
      if (backward.length) onStatus?.('Following camera and players back to the start…');
      await pass(backward, -1);
    }
  } finally {
    detector.close();
  }
  return byIndex.filter(Boolean);
}
