import { createLandmarker } from './pose.js';
import { cropRegions } from './court.js';
import { toDetection, filterDetections, Tracker } from './tracking.js';
import { BallDetector } from './ball.js';
import { seekVideo } from './util.js';

/**
 * Walks the video at cfg.fps, runs pose estimation (optionally on two crops),
 * tracks player identities and the ball. Returns compact samples.
 */
export async function processVideo(match, video, { onStatus, onProgress, onFrame, isCancelled }) {
  const { cfg, cal, players } = match;
  const vw = video.videoWidth, vh = video.videoHeight;
  const regions = cfg.crops ? cropRegions(cal, vw, vh) : [{ sx: 0, sy: 0, sw: vw, sh: vh }];
  const perRegionPoses = cfg.crops ? 3 : Math.min(6, players.length + 2);

  onStatus?.('Loading pose model (first run downloads ~5–30 MB)…');
  const landmarkers = [];
  for (let i = 0; i < regions.length; i++) landmarkers.push(await createLandmarker(cfg.model, perRegionPoses));

  const canvases = regions.map(r => {
    const scale = Math.min(2, 960 / Math.max(r.sw, r.sh));
    const c = document.createElement('canvas');
    c.width = Math.round(r.sw * scale); c.height = Math.round(r.sh * scale);
    return { c, ctx: c.getContext('2d') };
  });

  const tracker = new Tracker(players);
  const ball = cfg.ball ? new BallDetector(vw, vh, cal) : null;
  const start = Math.max(0, cfg.rangeStart || 0);
  const end = Math.min(video.duration, cfg.rangeEnd || video.duration);
  const step = 1 / cfg.fps;
  const samples = [];
  const t0 = performance.now();
  let lastTs = -1;

  onStatus?.('Analyzing frames…');
  for (let t = start; t <= end; t += step) {
    if (isCancelled?.()) break;
    await seekVideo(video, t);
    let ts = Math.round(t * 1000);
    if (ts <= lastTs) ts = lastTs + 1;
    lastTs = ts;

    const dets = [];
    regions.forEach((r, k) => {
      const { c, ctx } = canvases[k];
      ctx.drawImage(video, r.sx, r.sy, r.sw, r.sh, 0, 0, c.width, c.height);
      const res = landmarkers[k].detectForVideo(c, ts);
      for (const pose of res.landmarks || []) dets.push(toDetection(pose, r, vw, vh, cal));
    });
    const assigned = tracker.update(t, filterDetections(dets));
    const b = ball ? ball.detect(video, t) : null;
    const sample = {
      t: +t.toFixed(3),
      p: assigned.map(d => (d ? { lm: d.lm, cx: +d.cx.toFixed(2), cy: +d.cy.toFixed(2), conf: +d.conf.toFixed(2) } : null)),
      b: b ? [+b[0].toFixed(4), +b[1].toFixed(4)] : null,
    };
    samples.push(sample);

    const frac = (t - start) / Math.max(0.001, end - start);
    const elapsed = (performance.now() - t0) / 1000;
    onProgress?.(frac, elapsed / Math.max(frac, 1e-3) - elapsed);
    onFrame?.(sample);
  }
  landmarkers.forEach(l => l.close?.());
  return samples;
}
