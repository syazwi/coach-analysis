import { imageToCourt, sideOf, inArea, UNLIMITED, outside } from './court.js';

// Re-acquiring a lost player prefers people near the court over spectators far away
// (ft of cost per ft beyond 10 ft outside the lines). Tracked players are never fenced in.
const farPenalty = d => { const [os, ob] = outside(d.cx, d.cy); return 0.6 * (Math.max(0, os - 10) + Math.max(0, ob - 16)); };
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
  const p = imageToCourt(cal, gx, gy);
  const [cx, cy] = p || [NaN, NaN];
  return { lm, cx, cy, conf: visSum / 6 };
}

/** Keep confident detections whose feet are inside the player area; drop duplicates from overlapping crops. */
export function filterDetections(dets, area = UNLIMITED, minConf = 0.3) {
  const inside = dets.filter(d => inArea(d.cx, d.cy, area) && d.conf > minConf);
  inside.sort((a, b) => b.conf - a.conf);
  const kept = [];
  for (const d of inside) {
    if (!kept.some(k => Math.hypot(k.cx - d.cx, k.cy - d.cy) < 2.2)) kept.push(d);
  }
  return kept;
}

/** Mean shirt colour [r,g,b] from the torso quad (shoulders -> hips). data = RGBA of a W×H frame. */
export function torsoColor(data, W, H, lm) {
  const P = i => [lm[i * 3], lm[i * 3 + 1], lm[i * 3 + 2]];
  const ls = P(L.ls), rs = P(L.rs), lh = P(L.lh), rh = P(L.rh);
  if (Math.min(ls[2], rs[2], lh[2], rh[2]) < 0.4) return null;
  let r = 0, g = 0, b = 0, n = 0;
  for (let ui = 0; ui < 5; ui++) {
    const u = 0.25 + ui * 0.125;
    for (let vi = 0; vi < 5; vi++) {
      const v = 0.15 + vi * 0.15;
      const tx = ls[0] + (rs[0] - ls[0]) * u, ty = ls[1] + (rs[1] - ls[1]) * u;
      const bx = lh[0] + (rh[0] - lh[0]) * u, by = lh[1] + (rh[1] - lh[1]) * u;
      const x = Math.round((tx + (bx - tx) * v) * W), y = Math.round((ty + (by - ty) * v) * H);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const j = (y * W + x) * 4;
      r += data[j]; g += data[j + 1]; b += data[j + 2]; n++;
    }
  }
  return n >= 8 ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : null;
}

/** 0 (same colour) .. 1 (opposite); null when unknown. */
export function colorDist(a, b) {
  if (!a || !b) return null;
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / 441.7;
}

const COLOR_W = 25; // feet of position error equivalent to a full colour mismatch

/**
 * Keeps stable player identities. Team A = near side, team B = far side.
 * Players are assumed to stay on their side (trim the video if teams change ends).
 * When players were calibrated (seed position + shirt colour), those drive the first
 * assignment and help re-identify players after occlusions or when partners cross.
 */
export class Tracker {
  constructor(players) {
    this.slots = players.map(p => ({
      team: p.team, side: p.team === 'A' ? 'near' : 'far', last: null, lastT: -1e9,
      ref: p.color || null, color: p.color || null, seed: p.seed || null,
    }));
    this.seeded = this.slots.some(s => s.ref || s.seed);
    this.inited = false;
    this.firstT = null;
  }

  cost(s, d, posW = 1) {
    const pos = s.last ? Math.hypot(d.cx - s.last.cx, d.cy - s.last.cy) : s.seed ? Math.hypot(d.cx - s.seed.cx, d.cy - s.seed.cy) : 0;
    const cd = colorDist(s.ref || s.color, d.color);
    return posW * pos + (cd === null ? COLOR_W * 0.25 : COLOR_W * cd);
  }

  initSeeded(t, dets) {
    this.firstT ??= t;
    const pairs = [];
    this.slots.forEach((s, si) => dets.forEach((d, di) => {
      if (sideOf(d.cy) === s.side) pairs.push({ si, di, c: this.cost(s, d, 0.3) + farPenalty(d) });
    }));
    pairs.sort((a, b) => a.c - b.c);
    const usedS = new Set(), usedD = new Set();
    for (const p of pairs) {
      if (usedS.has(p.si) || usedD.has(p.di)) continue;
      usedS.add(p.si); usedD.add(p.di);
    }
    if (usedS.size < this.slots.length && t - this.firstT < 3) return false;
    usedS.clear(); usedD.clear();
    for (const p of pairs) {
      if (usedS.has(p.si) || usedD.has(p.di)) continue;
      usedS.add(p.si); usedD.add(p.di);
      this.slots[p.si].last = dets[p.di]; this.slots[p.si].lastT = t;
    }
    this.inited = true;
    return true;
  }

  init(t, dets) {
    if (this.seeded) return this.initSeeded(t, dets);
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
        if (dist < maxD) pairs.push({ si, di, dist: this.cost(s, d) });
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
        const c = this.cost(s, d, 0.2) + farPenalty(d); // after a gap, appearance matters more than position
        if (c < bd) { bd = c; best = di; }
      });
      if (best >= 0) { usedS.add(si); usedD.add(best); out[si] = dets[best]; }
    });
    out.forEach((d, si) => {
      if (!d) return;
      const s = this.slots[si];
      s.last = d; s.lastT = t;
      if (d.color && !s.ref) s.color = s.color ? s.color.map((v, i) => v * 0.9 + d.color[i] * 0.1) : d.color;
    });
    return out;
  }
}
