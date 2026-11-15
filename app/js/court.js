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

/** imgPts: 4 points in normalized image coords [0..1] in COURT_CORNERS order. */
export function makeCalibration(imgPts) {
  return { imgPts, toCourt: solveH(imgPts, COURT_CORNERS), toImg: solveH(COURT_CORNERS, imgPts) };
}

export const distToNet = y => Math.abs(y - COURT.NET);
export function zoneOf(y) {
  const d = distToNet(y);
  return d <= 10 ? 'kitchen' : d < 18 ? 'transition' : 'baseline';
}
export const sideOf = y => (y > COURT.NET ? 'near' : 'far');

function bboxOf(pts) {
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/** Image bbox (normalized) of a court-space polygon. */
export function imgBox(cal, courtPts) {
  return bboxOf(courtPts.map(([x, y]) => applyH(cal.toImg, x, y)));
}

/**
 * Two crop regions (pixels) so far-side players are seen at higher resolution.
 * Each region covers one half of the court plus space for standing bodies.
 */
export function cropRegions(cal, vw, vh) {
  const far = imgBox(cal, [[-4, -8], [24, -8], [24, 23], [-4, 23]]);
  const near = imgBox(cal, [[-4, 21], [24, 21], [24, 52], [-4, 52]]);
  const mk = (b, upFrac, downFrac) => {
    const h = b.y1 - b.y0, w = b.x1 - b.x0;
    const x0 = Math.max(0, b.x0 - w * 0.08), x1 = Math.min(1, b.x1 + w * 0.08);
    const y0 = Math.max(0, b.y0 - h * upFrac), y1 = Math.min(1, b.y1 + h * downFrac);
    return { sx: Math.round(x0 * vw), sy: Math.round(y0 * vh), sw: Math.round((x1 - x0) * vw), sh: Math.round((y1 - y0) * vh) };
  };
  return [mk(far, 0.9, 0.05), mk(near, 0.9, 0.05)].filter(r => r.sw > 16 && r.sh > 16);
}
