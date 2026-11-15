import { imgBox } from './court.js';

export function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max];
}
const hueDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/**
 * Colour sample of the ball around (x, y) in an RGBA patch. Uses the more saturated half
 * of the pixels inside the circle so the court/background around the ball is ignored.
 */
export function sampleBallColor(patch, size, radius) {
  const px = [];
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (Math.hypot(x - c, y - c) > radius) continue;
    const j = (y * size + x) * 4;
    px.push(rgb2hsv(patch[j], patch[j + 1], patch[j + 2]));
  }
  if (!px.length) return null;
  px.sort((a, b) => b[1] * b[2] - a[1] * a[2]);
  const top = px.slice(0, Math.max(1, Math.ceil(px.length / 2)));
  let sx = 0, sy = 0, s = 0, v = 0;
  for (const [h, ss, vv] of top) { sx += Math.cos(h * Math.PI / 180); sy += Math.sin(h * Math.PI / 180); s += ss; v += vv; }
  let h = Math.atan2(sy, sx) * 180 / Math.PI; if (h < 0) h += 360;
  return { h, s: s / top.length, v: v / top.length };
}

/** Combine user samples [{h,s,v,d}] into a detector configuration. d = ball diameter in source px. */
export function ballConfigFromSamples(samples) {
  if (!samples.length) return null;
  let sx = 0, sy = 0;
  samples.forEach(p => { sx += Math.cos(p.h * Math.PI / 180); sy += Math.sin(p.h * Math.PI / 180); });
  let h = Math.atan2(sy, sx) * 180 / Math.PI; if (h < 0) h += 360;
  const spread = Math.max(...samples.map(p => hueDiff(p.h, h)));
  return {
    h, tolH: Math.min(45, Math.max(14, spread + 10)),
    minS: Math.max(0.12, Math.min(...samples.map(p => p.s)) * 0.55),
    minV: Math.max(0.2, Math.min(...samples.map(p => p.v)) * 0.55),
    d: samples.reduce((a, p) => a + p.d, 0) / samples.length,
    n: samples.length,
  };
}

/**
 * Ball finder: ball-coloured pixels that moved since the previous sample, grouped into
 * blobs of the expected size, then linked to a short track. Uses the user's ball calibration
 * (colour + size) when available, otherwise a generic yellow/green heuristic.
 */
export class BallDetector {
  constructor(vw, vh, cal, ballCal = null) {
    this.bc = ballCal;
    let w = 480;
    if (ballCal?.d) w = Math.min(960, Math.max(480, Math.ceil((4 * vw) / ballCal.d))); // ball >= ~4 px wide
    this.w = w;
    this.h = Math.round(w * vh / vw);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w; this.canvas.height = this.h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.prev = null;
    this.track = [];
    const b = imgBox(cal, [[-6, -10], [26, -10], [26, 54], [-6, 54]]);
    const h = b.y1 - b.y0;
    this.roi = { x0: Math.max(0, b.x0), x1: Math.min(1, b.x1), y0: Math.max(0, b.y0 - h * 0.6), y1: Math.min(1, b.y1) };
    if (ballCal?.d) {
      const dPx = (ballCal.d * w) / vw;
      const area = Math.PI * (dPx / 2) ** 2;
      this.areaMin = Math.max(1, area * 0.2);
      this.areaMax = area * 4 + 4;
      this.boxMax = Math.max(5, dPx * 4); // motion blur stretches the ball
      this.areaTarget = area;
    } else {
      this.areaMin = 1; this.areaMax = 70; this.boxMax = 14; this.areaTarget = 8;
    }
  }

  isBall(r, g, b) {
    const bc = this.bc;
    if (!bc) return !(r < 130 || g < 130 || b > 0.78 * Math.min(r, g) || Math.abs(r - g) > 95);
    const [h, s, v] = rgb2hsv(r, g, b);
    return s >= bc.minS && v >= bc.minV && hueDiff(h, bc.h) <= bc.tolH;
  }

  /** Returns [x, y] normalized (or null). With debug=true returns { pick, blobs }. */
  detect(video, t, debug = false) {
    const { w, h, ctx } = this;
    ctx.drawImage(video, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const prev = this.prev;
    this.prev = data;
    if (!prev) return debug ? { pick: null, blobs: [] } : null;
    const x0 = Math.floor(this.roi.x0 * w), x1 = Math.ceil(this.roi.x1 * w);
    const y0 = Math.floor(this.roi.y0 * h), y1 = Math.ceil(this.roi.y1 * h);
    const mask = new Uint8Array(w * h);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * w + x, j = i * 4;
        const r = data[j], g = data[j + 1], b = data[j + 2];
        const diff = Math.abs(r - prev[j]) + Math.abs(g - prev[j + 1]) + Math.abs(b - prev[j + 2]);
        if (diff > 50 && this.isBall(r, g, b)) mask[i] = 1;
      }
    }
    const blobs = [];
    const stack = [];
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] !== 1) continue;
      let area = 0, sx = 0, sy = 0, minx = w, maxx = 0, miny = h, maxy = 0;
      stack.push(i); mask[i] = 2;
      while (stack.length) {
        const k = stack.pop();
        const x = k % w, y = (k / w) | 0;
        area++; sx += x; sy += y;
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
        for (const n of [k - 1, k + 1, k - w, k + w]) {
          if (n >= 0 && n < mask.length && mask[n] === 1) { mask[n] = 2; stack.push(n); }
        }
      }
      const bw = maxx - minx + 1, bh = maxy - miny + 1;
      if (area >= this.areaMin && area <= this.areaMax && bw <= this.boxMax && bh <= this.boxMax) {
        blobs.push({ x: sx / area / w, y: sy / area / h, area });
      }
    }
    let pick = null;
    if (blobs.length) {
      const tr = this.track.filter(p => t - p.t < 0.6);
      if (tr.length >= 1) {
        const a = tr[tr.length - 1];
        let px = a.x, py = a.y;
        if (tr.length >= 2) {
          const b = tr[tr.length - 2];
          const dt = a.t - b.t || 1;
          px += (a.x - b.x) / dt * (t - a.t);
          py += (a.y - b.y) / dt * (t - a.t);
        }
        let bd = 0.22;
        for (const bl of blobs) {
          const d = Math.hypot(bl.x - px, bl.y - py);
          if (d < bd) { bd = d; pick = bl; }
        }
      }
      if (!pick && blobs.length <= 3) pick = blobs.reduce((m, b) => (Math.abs(b.area - this.areaTarget) < Math.abs(m.area - this.areaTarget) ? b : m));
      if (pick) {
        this.track.push({ t, x: pick.x, y: pick.y });
        if (this.track.length > 20) this.track.shift();
      }
    }
    const res = pick ? [pick.x, pick.y] : null;
    return debug ? { pick: res, blobs } : res;
  }
}
