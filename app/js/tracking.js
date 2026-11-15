import { applyH, sideOf } from './court.js';
import { L } from './pose.js';

/** Convert raw MediaPipe landmarks from a crop into a detection in full-frame normalized coords. */
export function toDetection(landmarks, region, vw, vh, cal) {
  const lm = new Float32Array(33 * 3);
  let visSum = 0;
  for (let i = 0; i < 33; i++) {
    const p = landmarks[i];
    lm[i * 3] = (region.sx + p.x * region.sw) / vw;
    lm[i * 3 + 1] = (region.sy + p.y * region.sh) / vh;
    lm[i * 3 + 2] = p.visibility ?? 1;
  }
  for (const i of [L.ls, L.rs, L.lh, L.rh, L.la, L.ra]) visSum += lm[i * 3 + 2];
  // ground contact point = midpoint of ankles/heels
  const gx = (lm[L.la * 3] + lm[L.ra * 3] + lm[L.lheel * 3] + lm[L.rheel * 3]) / 4;
  const gy = Math.max(lm[L.lheel * 3 + 1], lm[L.rheel * 3 + 1], lm[L.la * 3 + 1], lm[L.ra * 3 + 1]);
  const [cx, cy] = applyH(cal.toCourt, gx, gy);
  return { lm, cx, cy, conf: visSum / 6 };
}

export function filterDetections(dets) {
  const inside = dets.filter(d => Number.isFinite(d.cx) && d.cx > -7 && d.cx < 27 && d.cy > -12 && d.cy < 56 && d.conf > 0.3);
  inside.sort((a, b) => b.conf - a.conf);
  const kept = [];
  for (const d of inside) {
    if (!kept.some(k => Math.hypot(k.cx - d.cx, k.cy - d.cy) < 2.2)) kept.push(d);
  }
  return kept;
}

/**
 * Keeps stable player identities. Team A = near side, team B = far side.
 * Players are assumed to stay on their side (trim the video if teams change ends).
 */
export class Tracker {
  constructor(players) {
    this.slots = players.map(p => ({ team: p.team, side: p.team === 'A' ? 'near' : 'far', last: null, lastT: -1e9 }));
    this.inited = false;
    this.firstT = null;
  }

  init(t, dets) {
    this.firstT ??= t;
    const bySide = side => dets.filter(d => sideOf(d.cy) === side).sort((a, b) => a.cx - b.cx);
    const need = side => this.slots.filter(s => s.side === side).length;
    const near = bySide('near'), far = bySide('far');
    const complete = near.length >= need('near') && far.length >= need('far');
    if (!complete && t - this.firstT < 3) return false;
    for (const side of ['near', 'far']) {
      const ds = side === 'near' ? near : far;
      const ss = this.slots.filter(s => s.side === side);
      // if more detections than slots, keep the ones closest to the court centre line
      const chosen = ds.length > ss.length ? [...ds].sort((a, b) => Math.abs(a.cx - 10) - Math.abs(b.cx - 10)).slice(0, ss.length).sort((a, b) => a.cx - b.cx) : ds;
      chosen.forEach((d, i) => { ss[i].last = d; ss[i].lastT = t; });
    }
    this.inited = true;
    return true;
  }

  update(t, dets) {
    const out = new Array(this.slots.length).fill(null);
    if (!this.inited && !this.init(t, dets)) return out;
    const pairs = [];
    this.slots.forEach((s, si) => {
      if (!s.last) return;
      const dt = t - s.lastT;
      const maxD = 3 + 14 * Math.min(dt, 2);
      dets.forEach((d, di) => {
        if (sideOf(d.cy) !== s.side) return;
        const dist = Math.hypot(d.cx - s.last.cx, d.cy - s.last.cy);
        if (dist < maxD) pairs.push({ si, di, dist });
      });
    });
    pairs.sort((a, b) => a.dist - b.dist);
    const usedS = new Set(), usedD = new Set();
    for (const p of pairs) {
      if (usedS.has(p.si) || usedD.has(p.di)) continue;
      usedS.add(p.si); usedD.add(p.di);
      out[p.si] = dets[p.di];
    }
    // re-acquire lost slots with leftover detections on their side
    this.slots.forEach((s, si) => {
      if (usedS.has(si) || (s.last && t - s.lastT < 1.5)) return;
      let best = -1, bd = Infinity;
      dets.forEach((d, di) => {
        if (usedD.has(di) || sideOf(d.cy) !== s.side) return;
        const dist = s.last ? Math.hypot(d.cx - s.last.cx, d.cy - s.last.cy) : 0;
        if (dist < bd) { bd = dist; best = di; }
      });
      if (best >= 0) { usedS.add(si); usedD.add(best); out[si] = dets[best]; }
    });
    out.forEach((d, si) => { if (d) { this.slots[si].last = d; this.slots[si].lastT = t; } });
    return out;
  }
}
