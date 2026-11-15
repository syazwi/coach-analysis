import { FrameDetector } from './detector.js';
import { Tracker } from './tracking.js';
import { BallDetector } from './ball.js';
import { seekVideo } from './util.js';
import { areaOf, CROP_MAX } from './court.js';

/**
 * Walks the video at cfg.fps, runs pose estimation (optionally on two crops),
 * tracks player identities (seeded by player calibration) and the ball (using ball calibration).
 */
export async function processVideo(match, video, { onStatus, onProgress, onFrame, isCancelled }) {
  const { cfg, cal, players } = match;
  const vw = video.videoWidth, vh = video.videoHeight;

  onStatus?.('Loading pose model (first run downloads ~5–30 MB)…');
  const area = areaOf(cfg);
  const detector = await FrameDetector.create({ model: cfg.model, crops: cfg.crops, nPlayers: players.length, cal, vw, vh, mode: 'VIDEO', area });

  const tracker = new Tracker(players);
  const ball = cfg.ball ? new BallDetector(vw, vh, cal, cfg.ballCal || null, CROP_MAX) : null;
  // game segments chosen in "Game time" (older analyses: a single start/end range)
  const segments = (cfg.segments?.length ? cfg.segments : [{ start: cfg.rangeStart || 0, end: cfg.rangeEnd || video.duration }])
    .map(g => ({ start: Math.max(0, g.start), end: Math.min(video.duration, g.end || video.duration) }))
    .filter(g => g.end > g.start);
  const step = 1 / cfg.fps;
  const totalLen = segments.reduce((s, g) => s + (g.end - g.start), 0);
  const samples = [];
  const t0 = performance.now();
  let done = 0;

  onStatus?.(`Analyzing frames (${segments.length} segment${segments.length > 1 ? 's' : ''})…`);
  try {
    outer: for (const seg of segments) {
    if (ball) ball.prev = null; // no motion diff across a skipped gap
    for (let t = seg.start; t <= seg.end; t += step) {
      if (isCancelled?.()) break outer;
      await seekVideo(video, t);
      const assigned = tracker.update(t, detector.detect(video, step * 1000));
      const b = ball ? ball.detect(video, t) : null;
      const sample = {
        t: +t.toFixed(3),
        p: assigned.map(d => (d ? { lm: d.lm, cx: +d.cx.toFixed(2), cy: +d.cy.toFixed(2), conf: +d.conf.toFixed(2) } : null)),
        b: b ? [+b[0].toFixed(4), +b[1].toFixed(4)] : null,
      };
      samples.push(sample);
      done += step;
      const frac = Math.min(1, done / Math.max(0.001, totalLen));
      const elapsed = (performance.now() - t0) / 1000;
      onProgress?.(frac, elapsed / Math.max(frac, 1e-3) - elapsed);
      onFrame?.(sample);
    }
    }
  } finally {
    detector.close();
  }
  return samples;
}
