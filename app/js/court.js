// Court geometry. Court coordinates are in feet:
//   x: 0 (left, as seen from the camera) .. 20 (right)
//   y: 0 (far baseline) .. 44 (near baseline); net at y = 22; NVZ lines at y = 15 and 29.
export const COURT = { W: 20, L: 44, NET: 22, NVZ: 7 };
export const COURT_CORNERS = [[0, 0], [20, 0], [20, 44], [0, 44]]; // far-left, far-right, near-right, near-left

export const COURT_LINES = [
  [[0, 0], [20, 0]], [[20, 0], [20, 44]], [[20, 44], [0, 44]], [[0, 44], [0, 0]],
  [[0, 15], [20, 15]], [[0, 29], [20, 29]],
  [[10, 0], [10, 15]], [[10, 29], [10, 44]],
];
export const NET_LINE = [[-1, 22], [21, 22]];

function gaussSolve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) throw new Error('Degenerate court points');
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Homography mapping 4 src points to 4 dst points. Returns flat 3x3 (9 numbers). */
export function solveH(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  return [...gaussSolve(A, b), 1];
}

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/** imgPts: 4 normalized image points in COURT_CORNERS order; values may be outside 0..1. */
export function makeCalibration(imgPts) {
  return { imgPts, toCourt: solveH(imgPts, COURT_CORNERS), toImg: solveH(COURT_CORNERS, imgPts) };
}

/**
 * Expanded canvas used to calibrate a court whose corners are cropped out of the video.
 * Portrait/short-form video gets one full video-width on each side and 25% above/below;
 * landscape video gets smaller margins. `frame` is the real video rectangle in canvas px.
 */
export function calibrationWorkspace(vw, vh, { maxWidth = 1280, maxHeight = 900 } = {}) {
  if (!(vw > 0) || !(vh > 0)) throw new Error('Video dimensions are required');
  const portrait = vh > vw;
  const padX = vw * (portrait ? 1 : 0.25);
  const padY = vh * (portrait ? 0.25 : 0.12);
  const rawW = vw + padX * 2, rawH = vh + padY * 2;
  const scale = Math.min(1, maxWidth / rawW, maxHeight / rawH);
  return {
    width: Math.max(1, Math.round(rawW * scale)),
    height: Math.max(1, Math.round(rawH * scale)),
    frame: { x: padX * scale, y: padY * scale, w: vw * scale, h: vh * scale },
    bounds: { x0: -padX / vw, x1: 1 + padX / vw, y0: -padY / vh, y1: 1 + padY / vh },
    portrait,
  };
}

/** Normalized image point (which may be outside the video) -> calibration canvas px. */
export function imageToCalibrationCanvas(view, x, y) {
  return [view.frame.x + x * view.frame.w, view.frame.y + y * view.frame.h];
}

/** Calibration canvas px -> normalized image point (which may be outside 0..1). */
export function calibrationCanvasToImage(view, x, y) {
  return [(x - view.frame.x) / view.frame.w, (y - view.frame.y) / view.frame.h];
}

// How far outside the lines players can be and still be tracked (feet beyond sidelines / baselines).
// Many courts have 7–10 ft behind the baseline and players retreat further for lobs/deep serves.
export const AREA_PRESETS = {
  standard: { side: 10, back: 16 },
  wide: { side: 16, back: 24 },
  xwide: { side: 25, back: 35 },
};
// Players are not limited to an area: anywhere on the ground plane in view (bounded only to reject
// mapping garbage near the horizon). Spectators are handled by the tracker, not by a fence.
export const UNLIMITED = { side: 60, back: 80 };
export const CROP_MAX = AREA_PRESETS.xwide; // crops stop growing here to keep far players at a useful resolution
export const areaOf = cfg => cfg?.playArea || UNLIMITED;
export const inArea = (cx, cy, a) => Number.isFinite(cx) && cx > -a.side && cx < COURT.W + a.side && cy > -a.back && cy < COURT.L + a.back;
/** Feet outside the court for a point (0 if inside): [beyond sideline, beyond baseline]. */
export const outside = (cx, cy) => [Math.max(0, -cx, cx - COURT.W), Math.max(0, -cy, cy - COURT.L)];

const hw = (H, x, y) => H[6] * x + H[7] * y + H[8];

/** Image point (normalized) -> court feet, or null when the point is above the horizon (not on the ground plane). */
export function imageToCourt(cal, x, y) {
  const [rx, ry] = applyH(cal.toImg, 10, 22);
  if (hw(cal.toCourt, x, y) * hw(cal.toCourt, rx, ry) <= 0) return null;
  const p = applyH(cal.toCourt, x, y);
  return Number.isFinite(p[0]) && Math.abs(p[0]) < 1000 && Math.abs(p[1]) < 1000 ? p : null;
}

const distToNetImpl = y => Math.abs(y - COURT.NET);
export const distToNet = distToNetImpl;
export function zoneOf(y) {
  const d = distToNet(y);
  return d <= 10 ? 'kitchen' : d < 18 ? 'transition' : 'baseline';
}
export const sideOf = y => (y > COURT.NET ? 'near' : 'far');

function bboxOf(pts) {
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/**
 * Image bbox (normalized) of a court-space polygon. Points that would project beyond the
 * horizon (far behind a low camera) are replaced by the top edge of the frame.
 */
export function imgBox(cal, courtPts) {
  const ref = hw(cal.toImg, 10, 22);
  const valid = [], clampTop = courtPts.some(([x, y]) => hw(cal.toImg, x, y) * ref <= 0);
  for (const [x, y] of courtPts) {
    if (hw(cal.toImg, x, y) * ref <= 0) continue;
    const [u, v] = applyH(cal.toImg, x, y);
    valid.push([Math.max(-1, Math.min(2, u)), Math.max(-1, Math.min(2, v))]);
  }
  const b = valid.length ? bboxOf(valid) : { x0: 0, x1: 1, y0: 0, y1: 1 };
  if (clampTop) { b.y0 = Math.min(b.y0, 0); b.x0 = Math.min(b.x0, 0); b.x1 = Math.max(b.x1, 1); }
  return b;
}

/**
 * Two crop regions (pixels) so far-side players are seen at higher resolution.
 * Each region covers one half of the court plus the player area around it.
 */
export function cropRegions(cal, vw, vh, area = AREA_PRESETS.standard) {
  const s = area.side, bk = area.back;
  const far = imgBox(cal, [[-s, -bk], [20 + s, -bk], [20 + s, 23], [-s, 23]]);
  const near = imgBox(cal, [[-s, 21], [20 + s, 21], [20 + s, 44 + bk], [-s, 44 + bk]]);
  const mk = (b, upFrac, downFrac) => {
    const h = b.y1 - b.y0, w = b.x1 - b.x0;
    const x0 = Math.max(0, b.x0 - w * 0.04), x1 = Math.min(1, b.x1 + w * 0.04);
    const y0 = Math.max(0, b.y0 - h * upFrac), y1 = Math.min(1, b.y1 + h * downFrac);
    return { sx: Math.round(x0 * vw), sy: Math.round(y0 * vh), sw: Math.round((x1 - x0) * vw), sh: Math.round((y1 - y0) * vh) };
  };
  return [mk(far, 0.9, 0.05), mk(near, 0.9, 0.05)].filter(r => r.sw > 16 && r.sh > 16);
}
