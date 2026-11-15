import { COURT, imageToCourt, sideOf, inArea, UNLIMITED, outside } from './court.js';

// Re-acquiring a lost player prefers people near the court over spectators far away
// (ft of cost per ft beyond 10 ft outside the lines). Tracked players are never fenced in.
const farPenalty = d => { const [os, ob] = outside(d.cx, d.cy); return 0.6 * (Math.max(0, os - 10) + Math.max(0, ob - 16)); };
import { L } from './pose.js';

/** Convert raw MediaPipe landmarks from a crop into a detection in full-frame normalized coords. */
export function toDetection(landmarks, region, vw, vh, cal) {
  const lm = new Float32Array(33 * 3);
  for (let i = 0; i < 33; i++) {
    const p = landmarks[i];
    lm[i * 3] = (region.sx + p.x * region.sw) / vw;
    lm[i * 3 + 1] = (region.sy + p.y * region.sh) / vh;
    lm[i * 3 + 2] = p.visibility ?? 1;
  }
  return finishDetection(lm, cal);
}

/** Court position (feet on the ground), confidence and image box for a full-frame skeleton. */
export function finishDetection(lm, cal) {
  let visSum = 0;
  for (const i of [L.ls, L.rs, L.lh, L.rh, L.la, L.ra]) visSum += lm[i * 3 + 2];
  // ground contact point = midpoint of ankles/heels
  const gx = (lm[L.la * 3] + lm[L.ra * 3] + lm[L.lheel * 3] + lm[L.rheel * 3]) / 4;
  const gy = Math.max(lm[L.lheel * 3 + 1], lm[L.rheel * 3 + 1], lm[L.la * 3 + 1], lm[L.ra * 3 + 1]);
  const p = imageToCourt(cal, gx, gy);
  const [cx, cy] = p || [NaN, NaN];
  return { lm, cx, cy, conf: visSum / 6, box: skeletonBox(lm) };
}

/** Image bounding box {x0,y0,x1,y1} (normalized) of the visible joints. */
export function skeletonBox(lm, minVis = 0.3) {
  let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
  for (let i = 0; i < 33; i++) {
    if (lm[i * 3 + 2] < minVis) continue;
    const x = lm[i * 3], y = lm[i * 3 + 1];
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return x1 > x0 ? { x0, y0, x1, y1 } : null;
}

/** Intersection-over-union of two boxes (0..1). */
export function boxIoU(a, b) {
  if (!a || !b) return 0;
  const iw = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), ih = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (iw <= 0 || ih <= 0) return 0;
  const i = iw * ih;
  return i / ((a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - i);
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

// feet of position error equivalent to a full colour mismatch
export const COLOR_WEIGHT = { skeleton: 4, color: 25 };
const BOX_W = 5; // feet of cost for skeletons that don't overlap the player's last skeleton at all
const SIDELINE_ACQUIRE_MARGIN = 3; // stale/new tracks must be on court or only just outside it
const REGULAR_MAX_GAP = 0.75; // after this, use the focused follow look instead of a whole-frame person
const FOLLOW_MAX_GAP = 1.5;
const REACQUIRE_MAX_DIST = 8; // feet from the calibrated/predicted position after a long miss

/**
 * Choose matches for the whole group, not one greedy pair at a time. This is
 * important when partners rotate across the court: the closest single match
 * can be wrong even though the lowest-cost assignment for both players is clear.
 * Maximise the number of matched slots first, then minimise their combined cost.
 */
export function optimalAssignment(pairs) {
  if (!pairs.length) return [];
  const bySlot = new Map();
  for (const p of pairs) {
    if (!bySlot.has(p.si)) bySlot.set(p.si, []);
    bySlot.get(p.si).push(p);
  }
  const slots = [...bySlot.keys()];
  let best = [], bestCost = Infinity;
  const usedD = new Set(), chosen = [];
  const visit = (i, cost) => {
    if (i === slots.length) {
      if (chosen.length > best.length || (chosen.length === best.length && cost < bestCost)) {
        best = chosen.slice(); bestCost = cost;
      }
      return;
    }
    // It can be better to leave one temporarily occluded player unmatched.
    visit(i + 1, cost);
    for (const p of bySlot.get(slots[i])) {
      if (usedD.has(p.di)) continue;
      usedD.add(p.di); chosen.push(p);
      visit(i + 1, cost + p.c);
      chosen.pop(); usedD.delete(p.di);
    }
  };
  visit(0, 0);
  return best;
}

/**
 * Keeps stable player identities. Team A = near side, team B = far side.
 * trackBy 'skeleton' (default): each player's skeleton is followed frame to frame — predicted
 *   position from their movement + overlap with their last skeleton; shirt colour only breaks ties.
 * trackBy 'color': shirt colour weighs heavily (useful when teams wear clearly different colours).
 * Calibration seeds (position, skeleton box, colour) drive the first assignment.
 */
export class Tracker {
  constructor(players, { trackBy = 'skeleton' } = {}) {
    this.colorW = COLOR_WEIGHT[trackBy] ?? COLOR_WEIGHT.skeleton;
    this.byColor = trackBy === 'color';
    this.slots = players.map(p => ({
      team: p.team, side: p.team === 'A' ? 'near' : 'far', last: null, lastT: -1e9, vel: [0, 0], boxVel: [0, 0],
      ref: p.color || null, color: p.color || null, seed: p.seed || null, box: p.seed?.box || null,
    }));
    this.seeded = this.slots.some(s => s.ref || s.seed);
    this.inited = false;
    this.firstT = null;
    this.cameraTransform = [1, 0, 0, 0, 1, 0];
  }

  setCameraTransform(m) { this.cameraTransform = m || [1, 0, 0, 0, 1, 0]; }

  cameraBox(b) {
    const m = this.cameraTransform;
    const pts = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]].map(([x, y]) => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]]);
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  }

  /** Where the slot should be now (court ft), from its last position and velocity. */
  predict(s, t) {
    if (!s.last) return s.seed ? [s.seed.cx, s.seed.cy] : null;
    const dt = Math.min(0.5, Math.max(0, t - s.lastT));
    return [s.last.cx + s.vel[0] * dt, s.last.cy + s.vel[1] * dt];
  }

  /** The slot's last skeleton box moved on by its on-screen motion. */
  predictBox(s, t) {
    const dt = s.last ? Math.min(0.5, Math.max(0, t - s.lastT)) : 0;
    const [dx, dy] = [s.boxVel[0] * dt, s.boxVel[1] * dt], b = s.box;
    return { x0: b.x0 + dx, x1: b.x1 + dx, y0: b.y0 + dy, y1: b.y1 + dy };
  }

  cost(s, d, posW = 1, t = s.lastT) {
    const p = this.predict(s, t);
    const pos = p ? Math.hypot(d.cx - p[0], d.cy - p[1]) : 0;
    const cd = colorDist(s.ref || s.color, d.color);
    const recent = !s.last || t - s.lastT < 0.8;
    const box = s.box && d.box && recent ? BOX_W * (1 - boxIoU(this.predictBox(s, t), d.box)) : 0;
    return posW * pos + box + (cd === null ? this.colorW * 0.25 : this.colorW * cd);
  }

  /**
   * A new/stale track may not jump from the court to a person well beyond a sideline.
   * Once a real player crosses a sideline continuously, keep following them without a fence.
   */
  sidelineContinuous(s, d) {
    const [dSide] = outside(d.cx, d.cy);
    if (dSide <= SIDELINE_ACQUIRE_MARGIN) return true;
    const anchor = s.last || s.seed;
    if (!anchor) return false;
    const [aSide] = outside(anchor.cx, anchor.cy);
    const sameEdge = (d.cx < 0 && anchor.cx < 0) || (d.cx > COURT.W && anchor.cx > COURT.W);
    return aSide > 0.5 && sameEdge && Math.abs(d.cx - anchor.cx) <= 5;
  }

  /** Candidate close enough to the player's calibration seed to initialise this slot. */
  seedCompatible(s, d, t) {
    if (sideOf(d.cy) !== s.side || !this.sidelineContinuous(s, d)) return false;
    const p = this.predict(s, t);
    if (!p) return true;
    // Allow ordinary movement if pose detection takes a moment to find the player, but never
    // turn a calibrated slot into an arbitrary same-side person.
    const wait = Math.max(0, t - (this.firstT ?? t));
    return Math.hypot(d.cx - p[0], d.cy - p[1]) <= 12 + Math.min(8, wait * 4);
  }

  /** Conservative admission after a track has been missing long enough to need reacquisition. */
  reacquirable(s, d, t) {
    if (d.masked || sideOf(d.cy) !== s.side || !this.sidelineContinuous(s, d)) return false;
    const p = this.predict(s, t);
    return !p || Math.hypot(d.cx - p[0], d.cy - p[1]) <= REACQUIRE_MAX_DIST;
  }

  initSeeded(t, dets) {
    this.firstT ??= t;
    const posW = this.byColor ? 0.3 : 1;
    const pairs = [];
    this.slots.forEach((s, si) => dets.forEach((d, di) => {
      if (this.seedCompatible(s, d, t)) pairs.push({ si, di, c: this.cost(s, d, posW, t) + farPenalty(d) });
    }));
    // Start with every reliable partial match instead of waiting for all players.
    // Missing calibrated slots are then searched directly in their saved boxes.
    for (const p of optimalAssignment(pairs)) {
      this.commit(this.slots[p.si], dets[p.di], t);
    }
    this.inited = true;
    return true;
  }

  init(t, dets) {
    if (this.seeded) return this.initSeeded(t, dets);
    this.firstT ??= t;
    // With no calibration seed, only acquire players on/next to the playing court. A player
    // subsequently tracked out wide remains valid through sidelineContinuous().
    const bySide = side => dets.filter(d => sideOf(d.cy) === side && outside(d.cx, d.cy)[0] <= SIDELINE_ACQUIRE_MARGIN).sort((a, b) => a.cx - b.cx);
    const need = side => this.slots.filter(s => s.side === side).length;
    const near = bySide('near'), far = bySide('far');
    const complete = near.length >= need('near') && far.length >= need('far');
    if (!complete && t - this.firstT < 3) return false;
    for (const side of ['near', 'far']) {
      const ds = side === 'near' ? near : far;
      const ss = this.slots.filter(s => s.side === side);
      // if more detections than slots, keep the ones closest to the court centre line
      const chosen = ds.length > ss.length ? [...ds].sort((a, b) => Math.abs(a.cx - 10) - Math.abs(b.cx - 10)).slice(0, ss.length).sort((a, b) => a.cx - b.cx) : ds;
      chosen.forEach((d, i) => this.commit(ss[i], d, t));
    }
    this.inited = true;
    return true;
  }

  /** Accept detection d for slot s at time t (updates velocity, box, colour). */
  commit(s, d, t) {
    const dt = t - s.lastT;
    if (s.last && dt > 0 && dt < 0.6) {
      const vx = (d.cx - s.last.cx) / dt, vy = (d.cy - s.last.cy) / dt;
      const sp = Math.hypot(vx, vy), k = sp > 25 ? 25 / sp : 1; // cap at a sprint
      s.vel = [s.vel[0] * 0.5 + vx * k * 0.5, s.vel[1] * 0.5 + vy * k * 0.5];
      if (s.box && d.box) {
        const bx = ((d.box.x0 + d.box.x1) - (s.box.x0 + s.box.x1)) / 2 / dt, by = ((d.box.y0 + d.box.y1) - (s.box.y0 + s.box.y1)) / 2 / dt;
        s.boxVel = [s.boxVel[0] * 0.5 + bx * k * 0.5, s.boxVel[1] * 0.5 + by * k * 0.5];
      }
    } else { s.vel = [0, 0]; s.boxVel = [0, 0]; }
    s.last = d; s.lastT = t;
    if (d.box) s.box = d.box;
    if (d.color && !s.ref) s.color = s.color ? s.color.map((v, i) => v * 0.9 + d.color[i] * 0.1) : d.color;
  }

  /** Is detection d allowed to continue slot s at time t? */
  reachable(s, d, t, focused = false) {
    if (sideOf(d.cy) !== s.side || !this.sidelineContinuous(s, d)) return false;
    const dt = t - s.lastT;
    if (dt < 0 || dt > (focused ? FOLLOW_MAX_GAP : REGULAR_MAX_GAP)) return false;
    const p = this.predict(s, t);
    const dist = Math.hypot(d.cx - p[0], d.cy - p[1]);
    // an erased-zone detection may only continue a player who was just here (stepped into the zone)
    if (d.masked && (dt > 0.5 || dist > 4)) return false;
    // Whole-frame detections get a short leash. A focused zoom may search slightly longer, but
    // both are capped so a stale track cannot jump across to a spectator.
    const maxDist = focused ? Math.min(10, 3 + 10 * dt) : Math.min(9, 3 + 14 * dt);
    return dist < maxDist;
  }

  update(t, allDets) {
    const out = new Array(this.slots.length).fill(null);
    // people standing in erased zones (spectators…) never start or re-acquire a player track
    const fresh = allDets.filter(d => !d.masked);
    if (!this.inited && !this.init(t, fresh)) return out;
    const dets = allDets;
    const pairs = [];
    this.slots.forEach((s, si) => {
      if (!s.last) return;
      dets.forEach((d, di) => { if (this.reachable(s, d, t)) pairs.push({ si, di, c: this.cost(s, d, 1, t) }); });
    });
    const usedS = new Set(), usedD = new Set();
    for (const p of optimalAssignment(pairs)) {
      usedS.add(p.si); usedD.add(p.di);
      out[p.si] = dets[p.di];
    }
    // Re-acquire lost slots as a group as well; partners may have completed a
    // left/right rotation while one or both were briefly hidden.
    const stalePairs = [];
    this.slots.forEach((s, si) => {
      if (usedS.has(si) || (s.last && t - s.lastT < 1.5)) return;
      dets.forEach((d, di) => {
        if (usedD.has(di) || !this.reacquirable(s, d, t)) return;
        const c = this.cost(s, d, this.byColor ? 0.2 : 0.5, t) + farPenalty(d); // after a gap, appearance matters more
        stalePairs.push({ si, di, c });
      });
    });
    for (const p of optimalAssignment(stalePairs)) {
      usedS.add(p.si); usedD.add(p.di); out[p.si] = dets[p.di];
    }
    out.forEach((d, si) => { if (d) this.commit(this.slots[si], d, t); });
    return out;
  }

  /**
   * Slots worth a zoomed "follow" look: not matched this frame but seen recently.
   * Returns [{ si, box }] with the box (normalized) to search, grown around the last skeleton.
   */
  followTargets(t, out) {
    const res = [];
    this.slots.forEach((s, si) => {
      if (out[si]) return;
      // A calibrated player who has not been acquired yet must get a focused
      // first look; previously these boxes were only used after first detection.
      if (!s.last) {
        if (!s.seed?.box) return;
        const b = this.cameraBox(s.seed.box);
        const w = b.x1 - b.x0, h = b.y1 - b.y0;
        res.push({ si, box: { x0: b.x0 - w * 0.45, x1: b.x1 + w * 0.45, y0: b.y0 - h * 0.3, y1: b.y1 + h * 0.2 } });
        return;
      }
      if (!s.box || t - s.lastT > 1.5) return;
      const b = this.predictBox(s, t), w = b.x1 - b.x0, h = b.y1 - b.y0;
      const g = 0.5 + Math.min(1, t - s.lastT); // search further the longer they've been missing
      res.push({ si, box: { x0: b.x0 - w * g, x1: b.x1 + w * g, y0: b.y0 - h * g * 0.5, y1: b.y1 + h * g * 0.5 } });
    });
    return res;
  }

  /** Offer a detection found by a follow look to slot si. Returns true when accepted. */
  claim(si, t, d, out) {
    const s = this.slots[si];
    if (!d || (s.last ? !this.reachable(s, d, t, true) : !this.seedCompatible(s, d, t))) return false;
    // not someone already assigned this frame (e.g. the partner)
    if (out.some((o, k) => o && k !== si && (Math.hypot(o.cx - d.cx, o.cy - d.cy) < 1.5 || boxIoU(o.box, d.box) > 0.5))) return false;
    out[si] = d;
    this.commit(s, d, t);
    return true;
  }
}
