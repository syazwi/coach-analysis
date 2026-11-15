// Runs pose detection on one video frame (optionally as two court-half crops) and returns
// detections with court position and shirt colour. Used by player calibration (IMAGE mode,
// thorough: extra zoomed tiles so small/far players are found) and by processing (VIDEO mode).
import { createLandmarker } from './pose.js';
import { cropRegions, imgBox, UNLIMITED, CROP_MAX } from './court.js';
import { toDetection, filterDetections, torsoColor } from './tracking.js';
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
  static async create({ model, crops, nPlayers, cal, vw, vh, mode = 'VIDEO', area = UNLIMITED, thorough = false }) {
    const d = new FrameDetector();
    d.cal = cal; d.vw = vw; d.vh = vh; d.mode = mode; d.area = area; d.thorough = thorough;
    const cropArea = { side: Math.min(area.side, CROP_MAX.side), back: Math.min(area.back, CROP_MAX.back) };
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

  /** Eraser grid from mask.js (or null). */
  setMask(grid) { this.mask = grid; }

  close() { this.landmarkers.forEach(l => l.close?.()); }
}
