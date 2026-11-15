// Tracks global camera pan/zoom/rotation from static court-surface features and
// carries the original four-point court calibration with that motion.
import { applyH, makeCalibration } from './court.js';

export const IDENTITY_AFFINE = [1, 0, 0, 0, 1, 0];

export function applyAffine(m, x, y) {
  return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
}

/** after(before(point)) */
export function composeAffine(after, before) {
  return [
    after[0] * before[0] + after[1] * before[3],
    after[0] * before[1] + after[1] * before[4],
    after[0] * before[2] + after[1] * before[5] + after[2],
    after[3] * before[0] + after[4] * before[3],
    after[3] * before[1] + after[4] * before[4],
    after[3] * before[2] + after[4] * before[5] + after[5],
  ];
}

export function calibrationFromTransform(base, transform) {
  return makeCalibration(base.imgPts.map(([x, y]) => applyAffine(transform, x, y)));
}

function similarityModel(pairs, width, height) {
  if (pairs.length < 2) return null;
  let mx = 0, my = 0, mu = 0, mv = 0;
  for (const p of pairs) {
    mx += p.from[0] * width; my += p.from[1] * height;
    mu += p.to[0] * width; mv += p.to[1] * height;
  }
  mx /= pairs.length; my /= pairs.length; mu /= pairs.length; mv /= pairs.length;
  let den = 0, ac = 0, bc = 0;
  for (const p of pairs) {
    const x = p.from[0] * width - mx, y = p.from[1] * height - my;
    const u = p.to[0] * width - mu, v = p.to[1] * height - mv;
    den += x * x + y * y;
    ac += x * u + y * v;
    bc += x * v - y * u;
  }
  if (den < 1e-6) return null;
  const a = ac / den, b = bc / den;
  const tx = mu - a * mx + b * my, ty = mv - b * mx - a * my;
  return {
    affine: [a, -b * height / width, tx / width, b * width / height, a, ty / height],
    scale: Math.hypot(a, b), angle: Math.atan2(b, a), tx, ty,
  };
}

function errorPx(model, pair, width, height) {
  const p = applyAffine(model.affine, ...pair.from);
  return Math.hypot((p[0] - pair.to[0]) * width, (p[1] - pair.to[1]) * height);
}

/** Robust global similarity fit. Moving players become outliers. */
export function robustSimilarity(pairs, width, height, thresholdPx = 2.5) {
  if (pairs.length < 2) return null;
  let best = null, bestInliers = [];
  for (let i = 0; i < pairs.length - 1; i++) for (let j = i + 1; j < pairs.length; j++) {
    const model = similarityModel([pairs[i], pairs[j]], width, height);
    if (!model) continue;
    const inliers = pairs.filter(p => errorPx(model, p, width, height) <= thresholdPx);
    if (inliers.length > bestInliers.length) { best = model; bestInliers = inliers; }
  }
  if (!best || bestInliers.length < 2) return null;
  best = similarityModel(bestInliers, width, height) || best;
  bestInliers = pairs.filter(p => errorPx(best, p, width, height) <= thresholdPx);
  best = similarityModel(bestInliers, width, height) || best;
  const rmse = Math.sqrt(bestInliers.reduce((s, p) => s + errorPx(best, p, width, height) ** 2, 0) / Math.max(1, bestInliers.length));
  return { ...best, inliers: bestInliers, rmse };
}

const pointInPoly = (x, y, poly) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi || 1e-9) + xi) inside = !inside;
  }
  return inside;
};

function cornerScore(gray, w, h, x, y) {
  if (x < 3 || y < 3 || x >= w - 3 || y >= h - 3) return 0;
  const gx = Math.abs(gray[y * w + x + 2] - gray[y * w + x - 2]);
  const gy = Math.abs(gray[(y + 2) * w + x] - gray[(y - 2) * w + x]);
  const gd1 = Math.abs(gray[(y + 2) * w + x + 2] - gray[(y - 2) * w + x - 2]);
  const gd2 = Math.abs(gray[(y + 2) * w + x - 2] - gray[(y - 2) * w + x + 2]);
  return Math.min(gx + gy, gd1 + gd2) + Math.min(gx, gy);
}

function selectFeatures(gray, w, h, cal, max = 24) {
  const court = [[0, 0], [20, 0], [20, 44], [0, 44]].map(p => {
    const q = applyH(cal.toImg, ...p); return [q[0] * w, q[1] * h];
  });
  const candidates = [];
  // Known line intersections are valuable even when the surrounding court is plain.
  for (const x of [0, 10, 20]) for (const y of [0, 15, 22, 29, 44]) {
    const [u, v] = applyH(cal.toImg, x, y), px = Math.round(u * w), py = Math.round(v * h);
    const score = cornerScore(gray, w, h, px, py);
    if (score > 12) candidates.push({ x: px, y: py, score: score + 30 });
  }
  // Supplement with strong corners on the playing surface.
  for (let y = 5; y < h - 5; y += 3) for (let x = 5; x < w - 5; x += 3) {
    if (!pointInPoly(x, y, court)) continue;
    const score = cornerScore(gray, w, h, x, y);
    if (score > 35) candidates.push({ x, y, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const p of candidates) {
    if (kept.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 9)) continue;
    kept.push([p.x / w, p.y / h]);
    if (kept.length >= max) break;
  }
  return kept;
}

function patchCost(a, b, w, x0, y0, x1, y1, r = 2) {
  let cost = 0;
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
    cost += Math.abs(a[(y0 + y) * w + x0 + x] - b[(y1 + y) * w + x1 + x]);
  }
  return cost;
}

function trackFeatures(prev, curr, points, w, h, prediction, search = 8) {
  const pairs = [], margin = search + 3;
  for (const from of points) {
    const x0 = Math.round(from[0] * w), y0 = Math.round(from[1] * h);
    const guess = applyAffine(prediction, ...from);
    const gx = Math.round(guess[0] * w), gy = Math.round(guess[1] * h);
    if (x0 < 3 || y0 < 3 || x0 >= w - 3 || y0 >= h - 3 || gx < margin || gy < margin || gx >= w - margin || gy >= h - margin) continue;
    let best = Infinity, second = Infinity, bx = gx, by = gy;
    for (let dy = -search; dy <= search; dy++) for (let dx = -search; dx <= search; dx++) {
      const x = gx + dx, y = gy + dy;
      const cost = patchCost(prev, curr, w, x0, y0, x, y);
      if (cost < best) { second = best; best = cost; bx = x; by = y; }
      else if (Math.hypot(x - bx, y - by) > 2 && cost < second) second = cost;
    }
    const avg = best / 25;
    if (avg <= 34 && (second === Infinity || best <= second * 0.985)) pairs.push({ from, to: [bx / w, by / h] });
  }
  return pairs;
}

export class CameraCalibrationTracker {
  constructor(baseCal, videoWidth, videoHeight, { width = 240 } = {}) {
    this.base = baseCal;
    this.cal = baseCal;
    this.transform = IDENTITY_AFFINE.slice();
    this.lastDelta = IDENTITY_AFFINE.slice();
    this.w = Math.min(width, videoWidth);
    this.h = Math.max(90, Math.round(this.w * videoHeight / videoWidth));
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w; this.canvas.height = this.h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.prev = null; this.points = []; this.frame = 0;
  }

  capture(video) {
    this.ctx.drawImage(video, 0, 0, this.w, this.h);
    const rgba = this.ctx.getImageData(0, 0, this.w, this.h).data;
    const gray = new Uint8Array(this.w * this.h);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    return gray;
  }

  resetFrameReference() { this.prev = null; this.points = []; this.lastDelta = IDENTITY_AFFINE.slice(); }

  update(video) {
    const curr = this.capture(video);
    if (!this.prev) {
      this.prev = curr;
      this.points = selectFeatures(curr, this.w, this.h, this.cal);
      return { cal: this.cal, transform: this.transform, moved: false, confidence: 0 };
    }
    const pairs = trackFeatures(this.prev, curr, this.points, this.w, this.h, this.lastDelta);
    const fit = robustSimilarity(pairs, this.w, this.h);
    const diag = Math.hypot(this.w, this.h);
    const accepted = fit && fit.inliers.length >= 4 && fit.inliers.length >= pairs.length * 0.4 && fit.rmse <= 2.2
      && fit.scale >= 0.94 && fit.scale <= 1.06 && Math.abs(fit.angle) <= 0.08 && Math.hypot(fit.tx, fit.ty) <= diag * 0.08;
    if (accepted) {
      this.lastDelta = fit.affine;
      this.transform = composeAffine(fit.affine, this.transform);
      try { this.cal = calibrationFromTransform(this.base, this.transform); } catch { /* keep last valid calibration */ }
      this.points = fit.inliers.map(p => p.to);
    } else {
      this.lastDelta = IDENTITY_AFFINE.slice();
      this.points = [];
    }
    this.frame++;
    if (this.points.length < 8 || this.frame % 8 === 0) this.points = selectFeatures(curr, this.w, this.h, this.cal);
    this.prev = curr;
    return {
      cal: this.cal, transform: this.transform, moved: !!accepted,
      confidence: accepted ? fit.inliers.length / Math.max(1, pairs.length) : 0,
    };
  }
}
