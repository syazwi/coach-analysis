import { FrameDetector } from './detector.js';
import { Tracker } from './tracking.js';
import { BallDetector } from './ball.js';
import { seekVideo } from './util.js';

/**
 * Walks the video at cfg.fps, runs pose estimation (optionally on two crops),
 * tracks player identities (seeded by player calibration) and the ball (using ball calibration).
 */
export async function processVideo(match, video, { onStatus, onProgress, onFrame, isCancelled }) {
  const { cfg, cal, players } = match;
  const vw = video.videoWidth, vh = video.videoHeight;

  onStatus?.('Loading pose model (first run downloads ~5–30 MB)…');
  const detector = await FrameDetector.create({ model: cfg.model, crops: cfg.crops, nPlayers: players.length, cal, vw, vh, mode: 'VIDEO' });

  const tracker = new Tracker(players);
  const ball = cfg.ball ? new BallDetector(vw, vh, cal, cfg.ballCal || null) : null;
  const start = Math.max(0, cfg.rangeStart || 0);
  const end = Math.min(video.duration, cfg.rangeEnd || video.duration);
  const step = 1 / cfg.fps;
  const samples = [];
  const t0 = performance.now();

  onStatus?.('Analyzing frames…');
  try {
    for (let t = start; t <= end; t += step) {
      if (isCancelled?.()) break;
      await seekVideo(video, t);
      const assigned = tracker.update(t, detector.detect(video, step * 1000));
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
  } finally {
    detector.close();
  }
  return samples;
}
