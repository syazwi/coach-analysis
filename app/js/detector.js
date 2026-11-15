// Runs pose detection on one video frame (optionally as two court-half crops) and returns
// detections with court position and shirt colour. Used by player calibration (IMAGE mode)
// and by processing (VIDEO mode).
import { createLandmarker } from './pose.js';
import { cropRegions, UNLIMITED, CROP_MAX } from './court.js';
import { toDetection, filterDetections, torsoColor } from './tracking.js';

export class FrameDetector {
  static async create({ model, crops, nPlayers, cal, vw, vh, mode = 'VIDEO', area = UNLIMITED }) {
    const d = new FrameDetector();
    d.cal = cal; d.vw = vw; d.vh = vh; d.mode = mode; d.area = area;
    const cropArea = { side: Math.min(area.side, CROP_MAX.side), back: Math.min(area.back, CROP_MAX.back) };
    d.regions = crops ? cropRegions(cal, vw, vh, cropArea) : [{ sx: 0, sy: 0, sw: vw, sh: vh }];
    // a wide view can contain extra people (other courts, spectators): allow more poses per crop
    const perRegion = crops ? 5 : Math.min(8, nPlayers + 4);
    d.landmarkers = [];
    for (let i = 0; i < d.regions.length; i++) d.landmarkers.push(await createLandmarker(model, perRegion, mode));
    d.canvases = d.regions.map(r => {
      const scale = Math.min(2, 960 / Math.max(r.sw, r.sh));
      const c = document.createElement('canvas');
      c.width = Math.round(r.sw * scale); c.height = Math.round(r.sh * scale);
      return { c, ctx: c.getContext('2d') };
    });
    // low-res copy of the whole frame for shirt-colour sampling
    d.app = document.createElement('canvas');
    d.app.width = 640; d.app.height = Math.round(640 * vh / vw);
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
      const res = this.mode === 'IMAGE' ? this.landmarkers[k].detect(c) : this.landmarkers[k].detectForVideo(c, ts);
      for (const pose of res.landmarks || []) dets.push(toDetection(pose, r, this.vw, this.vh, this.cal));
    });
    const kept = filterDetections(dets, this.area);
    if (kept.length) {
      const { app, appCtx } = this;
      appCtx.drawImage(video, 0, 0, app.width, app.height);
      const data = appCtx.getImageData(0, 0, app.width, app.height).data;
      for (const d of kept) d.color = torsoColor(data, app.width, app.height, d.lm);
    }
    return kept;
  }

  close() { this.landmarkers.forEach(l => l.close?.()); }
}
