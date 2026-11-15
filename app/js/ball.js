import { imgBox } from './court.js';

/**
 * Lightweight ball finder: yellow/green pixels that moved since the previous sample,
 * grouped into small blobs, then linked to a short track. Experimental — works best at 60 fps
 * source with analysis >= 15 fps and good lighting.
 */
export class BallDetector {
  constructor(vw, vh, cal) {
    this.w = 480;
    this.h = Math.round(480 * vh / vw);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w; this.canvas.height = this.h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.prev = null;
    this.track = [];
    const b = imgBox(cal, [[-6, -10], [26, -10], [26, 54], [-6, 54]]);
    const h = b.y1 - b.y0;
    this.roi = { x0: Math.max(0, b.x0), x1: Math.min(1, b.x1), y0: Math.max(0, b.y0 - h * 0.6), y1: Math.min(1, b.y1) };
  }

  detect(video, t) {
    const { w, h, ctx } = this;
    ctx.drawImage(video, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const prev = this.prev;
    this.prev = data;
    if (!prev) return null;
    const x0 = Math.floor(this.roi.x0 * w), x1 = Math.ceil(this.roi.x1 * w);
    const y0 = Math.floor(this.roi.y0 * h), y1 = Math.ceil(this.roi.y1 * h);
    const mask = new Uint8Array(w * h);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * w + x, j = i * 4;
        const r = data[j], g = data[j + 1], b = data[j + 2];
        if (r < 130 || g < 130 || b > 0.78 * Math.min(r, g) || Math.abs(r - g) > 95) continue;
        const diff = Math.abs(r - prev[j]) + Math.abs(g - prev[j + 1]) + Math.abs(b - prev[j + 2]);
        if (diff > 60) mask[i] = 1;
      }
    }
    // connected components
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
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
        for (const n of [k - 1, k + 1, k - w, k + w]) {
          if (n >= 0 && n < mask.length && mask[n] === 1) { mask[n] = 2; stack.push(n); }
        }
        if (area > 200) break;
      }
      const bw = maxx - minx + 1, bh = maxy - miny + 1;
      if (area >= 1 && area <= 70 && bw <= 14 && bh <= 14) blobs.push({ x: sx / area / w, y: sy / area / h, area });
    }
    if (!blobs.length) return null;
    const tr = this.track.filter(p => t - p.t < 0.6);
    let pick = null;
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
    if (!pick && blobs.length <= 3) pick = blobs.reduce((m, b) => (Math.abs(b.area - 8) < Math.abs(m.area - 8) ? b : m));
    if (!pick) return null;
    this.track.push({ t, x: pick.x, y: pick.y });
    if (this.track.length > 20) this.track.shift();
    return [pick.x, pick.y];
  }
}
