// Runs pose detection on one video frame (optionally as two court-half crops) and returns
// detections with court position and shirt colour. Used by player calibration (IMAGE mode,
// thorough: extra zoomed tiles so small/far players are found) and by processing (VIDEO mode).
import { createLandmarker } from './pose.js';
import { cropRegions, imgBox, UNLIMITED, CROP_MAX } from './court.js';
import { toDetection, filterDetections, torsoColor, boxIoU } from './tracking.js';
import { poseMasked } from './mask.js';

/** Extra regions for calibration: far half split into overlapping left/right tiles, plus the whole frame. */
export function thoroughRegions(cal, vw, vh) {
  const far = imgBox(cal, [[-CROP_MAX.side, -CROP_MAX.back], [20 + CROP_MAX.side, -CROP_MAX.back], [20 + CROP_MAX.side, 23], [-CROP_MAX.side, 23]]);
  const x0 = Math.max(0, far.x0), x1 = Math.min(1, far.x1);
  const y0 = Math.max(0, far.y0), y1 = Math.min(1, far.y1 + (far.y1 - far.y0) * 0.1);
  const mid = (x0 + x1) / 2, ov = (x1 - x0) * 0.12;
  const px = (a, b, c, d) => ({ sx: Math.round(a * vw), sy: Math.round(c * vh), sw: Math.round((b - a) * vw), sh: Math.round((d - c) * vh) });
  return [
    px(x0, Math.min(1, mid + ov), y0, y1),   // far-left tile
    px(Math.max(0, mid - ov), x1, y0, y1),   // far-right tile
    { sx: 0, sy: 0, sw: vw, sh: vh },        // whole frame: anyone outside the crops
  ].filter(r => r.sw > 32 && r.sh > 32);
}

export class FrameDetector {
  /**
   * thorough: calibration mode — more regions, upscaling for small people, lower confidence thresholds.
   */
  static async create({ model, crops, nPlayers, cal, vw, vh, mode = 'VIDEO', area = UNLIMITED, thorough = false, follow = false }) {
    const d = new FrameDetector();
    d.cal = cal; d.vw = vw; d.vh = vh; d.mode = mode; d.area = area; d.thorough = thorough;
    const cropArea = { side: Math.min(area.side, CROP_MAX.side), back: Math.min(area.back, CROP_MAX.back) };
    d.cropArea = cropArea;
    d.useCourtRegions = !!(crops || thorough);
    d.regions = crops || thorough ? cropRegions(cal, vw, vh, cropArea) : [{ sx: 0, sy: 0, sw: vw, sh: vh }];
    if (thorough) d.regions.push(...thoroughRegions(cal, vw, vh));
    // a wide view can contain extra people (other courts, spectators): allow more poses per region
    const perRegion = crops || thorough ? 5 : Math.min(8, nPlayers + 4);
    const minConf = thorough ? 0.2 : 0.35;
    // IMAGE mode is stateless, so one landmarker serves every region; VIDEO mode tracks per region
    const count = mode === 'IMAGE' ? 1 : d.regions.length;
    d.landmarkers = [];
    for (let i = 0; i < count; i++) d.landmarkers.push(await createLandmarker(model, perRegion, mode, minConf));
    const maxSide = thorough ? 1280 : 960, maxUp = thorough ? 3 : 2;
    d.canvases = d.regions.map(r => {
      const scale = Math.min(maxUp, maxSide / Math.max(r.sw, r.sh));
      const c = document.createElement('canvas');
      c.width = Math.round(r.sw * scale); c.height = Math.round(r.sh * scale);
      return { c, ctx: c.getContext('2d') };
    });
    // low-res copy of the whole frame for shirt-colour sampling
    d.app = document.createElement('canvas');
    d.app.width = thorough ? 1280 : 640; d.app.height = Math.round(d.app.width * vh / vw);
    d.appCtx = d.app.getContext('2d', { willReadFrequently: true });
    // stateless landmarker for zoomed looks inside a box (drawing in calibration, following a lost player)
    d.boxLm = mode === 'IMAGE' ? d.landmarkers[0] : follow ? await createLandmarker(model, 3, 'IMAGE', 0.25) : null;
    d.boxCanvas = document.createElement('canvas');
    d.lastTs = 0;
    return d;
  }

  /** stepMs: time since previous call (VIDEO mode timestamps must increase). */
  detect(video, stepMs = 100) {
    const dets = [];
    const ts = (this.lastTs += Math.max(1, Math.round(stepMs)));
    this.regions.forEach((r, k) => {
      const { c, ctx } = this.canvases[k];
      ctx.drawImage(video, r.sx, r.sy, r.sw, r.sh, 0, 0, c.width, c.height);
      const res = this.mode === 'IMAGE' ? this.landmarkers[0].detect(c) : this.landmarkers[k].detectForVideo(c, ts);
      for (const pose of res.landmarks || []) dets.push(toDetection(pose, r, this.vw, this.vh, this.cal));
    });
    const kept = filterDetections(dets, this.area, this.thorough ? 0.2 : 0.3);
    // eraser zones: mark (not drop) — a tracked player may briefly step into one
    if (this.mask) for (const d of kept) d.masked = poseMasked(this.mask, d.lm);
    if (kept.length) {
      const data = this.frameData(video);
      for (const d of kept) d.color = torsoColor(data, this.app.width, this.app.height, d.lm);
    }
    return kept;
  }

  /** RGBA of the current frame at the colour-sampling resolution. */
  frameData(video) {
    const { app, appCtx } = this;
    appCtx.drawImage(video, 0, 0, app.width, app.height);
    return appCtx.getImageData(0, 0, app.width, app.height).data;
  }

  /**
   * Zoomed pose detection inside one box {x0,y0,x1,y1} (normalized, may extend past the frame).
   * Returns the skeleton that best fills the box (with court position & shirt colour), or null.
   */
  detectBox(video, box, { pad = 0.2, minConf = 0.15, all = false } = {}) {
    if (!this.boxLm) return all ? [] : null;
    const { vw, vh } = this;
    const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
    const x0 = Math.max(0, box.x0 - bw * pad), x1 = Math.min(1, box.x1 + bw * pad);
    const y0 = Math.max(0, box.y0 - bh * pad), y1 = Math.min(1, box.y1 + bh * pad);
    const r = { sx: Math.round(x0 * vw), sy: Math.round(y0 * vh), sw: Math.round((x1 - x0) * vw), sh: Math.round((y1 - y0) * vh) };
    if (r.sw < 8 || r.sh < 8) return all ? [] : null;
    const scale = Math.max(1, Math.min(4, 512 / Math.max(r.sw, r.sh)));
    const c = this.boxCanvas;
    c.width = Math.round(r.sw * scale); c.height = Math.round(r.sh * scale);
    c.getContext('2d').drawImage(video, r.sx, r.sy, r.sw, r.sh, 0, 0, c.width, c.height);
    const res = this.boxLm.detect(c);
    const target = { x0: Math.max(0, box.x0), y0: Math.max(0, box.y0), x1: Math.min(1, box.x1), y1: Math.min(1, box.y1) };
    let best = null, bs = -1;
    const found = [];
    for (const pose of res.landmarks || []) {
      const d = toDetection(pose, r, vw, vh, this.cal);
      if (!(d.conf > minConf) || !Number.isFinite(d.cy)) continue;
      found.push(d);
      // prefer the skeleton that fills the drawn box; any overlap counts
      const s = boxIoU(d.box, target) + 0.2 * d.conf;
      if (s > bs) { bs = s; best = d; }
    }
    if (!best) return all ? [] : null;
    const data = this.frameData(video);
    for (const d of all ? found : [best]) {
      if (this.mask) d.masked = poseMasked(this.mask, d.lm);
      d.color = torsoColor(data, this.app.width, this.app.height, d.lm);
    }
    return all ? found : best;
  }

  /** Eraser grid from mask.js (or null). */
  setMask(grid) { this.mask = grid; }

  /** Update court mapping/crops when the camera tracker moves the calibration. */
  setCalibration(cal) {
    this.cal = cal;
    if (!this.useCourtRegions) return;
    const regions = cropRegions(cal, this.vw, this.vh, this.cropArea);
    if (this.thorough) regions.push(...thoroughRegions(cal, this.vw, this.vh));
    if (regions.length) this.regions = regions.slice(0, this.canvases.length);
  }

  close() { this.landmarkers.forEach(l => l.close?.()); if (this.boxLm && !this.landmarkers.includes(this.boxLm)) this.boxLm.close?.(); }
}
