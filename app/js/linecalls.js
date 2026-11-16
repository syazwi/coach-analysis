// Line calls from the tracked ball: find where the ball bounced and call OUT when the
// last shot of a rally lands outside the court (long or wide). The line is in, and calls
// within OUT_MARGIN of a line are given as in, because a single camera can't be sure.
import { imageToCourt, COURT } from './court.js';
import { L } from './pose.js';

export const OUT_MARGIN = 0.75; // ft beyond the line before calling it out

/**
 * Bounces: the ball's on-screen vertical speed suddenly kicks upward (the ground pushed it
 * back up) while it is away from every paddle hand. samples[i].b = [x, y] normalized image.
 * calOf(i) gives the court calibration for that frame. Returns [{ i, t, x, y, cx, cy }].
 */
export function findBounces(samples, calOf, { maxGap = 0.25, kick = 0.25 } = {}) {
  const pts = [];
  samples.forEach((s, i) => { if (s.b) pts.push({ i, t: s.t, x: s.b[0], y: s.b[1] }); });
  const out = [];
  for (let k = 1; k < pts.length - 1; k++) {
    const a = pts[k - 1], b = pts[k], c = pts[k + 1];
    const d1 = b.t - a.t, d2 = c.t - b.t;
    if (d1 <= 0 || d2 <= 0 || d1 > maxGap || d2 > maxGap) continue;
    const v1 = [(b.x - a.x) / d1, (b.y - a.y) / d1], v2 = [(c.x - b.x) / d2, (c.y - b.y) / d2];
    if (Math.hypot(...v1) > 4 || Math.hypot(...v2) > 4) continue; // jumped to another object
    if (v2[1] - v1[1] > -kick) continue;                          // no upward kick
    const s = samples[b.i];
    const nearHand = (s.p || []).some(p => p?.lm && [L.lw, L.rw].some(j => p.lm[j * 3 + 2] > 0.3 && Math.hypot(p.lm[j * 3] - b.x, p.lm[j * 3 + 1] - b.y) < 0.06));
    if (nearHand) continue;                                       // a paddle contact, not the ground
    const g = imageToCourt(calOf(b.i), b.x, b.y);
    if (!g) continue;
    if (out.length && b.t - out[out.length - 1].t < 0.15) continue; // same bounce seen twice
    out.push({ i: b.i, t: b.t, x: b.x, y: b.y, cx: g[0], cy: g[1] });
  }
  return out;
}

/** 'long' | 'wide' | null (in) for a bounce at court position (cx, cy) in feet. */
export function lineVerdict(cx, cy, m = OUT_MARGIN) {
  if (cy < -m || cy > COURT.L + m) return 'long';
  if (cx < -m || cx > COURT.W + m) return 'wide';
  return null;
}

/**
 * One call per rally: where the ball first landed after the last shot.
 * Returns per rally null (no bounce seen) or { rally, t, i, x, y, cx, cy, out, how, hitter, team }.
 */
export function lineCalls(rallies, shots, players, bounces) {
  return rallies.map(r => {
    const last = shots[r.shots[r.shots.length - 1]];
    if (!last) return null;
    // which half the hitter is on (team A = near side) → the ball must land on the other half
    const hitterNear = Number.isFinite(last.cy) ? last.cy > COURT.NET : players[last.slot]?.team === 'A';
    const b = bounces.find(x => x.t > last.t + 0.12 && x.t <= last.t + 2.5);
    if (!b) return null;
    if (hitterNear ? b.cy >= COURT.NET : b.cy <= COURT.NET) return null; // own half: a net ball, not a line call
    if (b.cx < -12 || b.cx > COURT.W + 12 || b.cy < -12 || b.cy > COURT.L + 12) return null; // implausible
    const how = lineVerdict(b.cx, b.cy);
    return { rally: r.index, t: b.t, i: b.i, x: b.x, y: b.y, cx: b.cx, cy: b.cy, out: !!how, how, hitter: last.slot, team: last.team };
  });
}

/** Red "OUT" marker where the ball landed, shown for a moment after the bounce. */
export function drawOutMarker(ctx, w, h, t, calls) {
  for (const c of calls) {
    if (!c?.out || t < c.t - 0.05 || t > c.t + 1.6) continue;
    const age = Math.max(0, t - c.t);
    const x = c.x * w, y = c.y * h, u = Math.max(0.6, h / 720), r = (10 + age * 10) * u;
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - age / 1.6);
    ctx.strokeStyle = '#e34948'; ctx.lineWidth = 3 * u;
    ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.45, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - 6 * u, y - 6 * u); ctx.lineTo(x + 6 * u, y + 6 * u); ctx.moveTo(x + 6 * u, y - 6 * u); ctx.lineTo(x - 6 * u, y + 6 * u); ctx.stroke();
    ctx.font = `900 ${Math.round(18 * u)}px Inter, system-ui, sans-serif`;
    const label = `OUT${c.how ? ' · ' + c.how.toUpperCase() : ''}`;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(17,18,20,0.85)';
    ctx.beginPath(); ctx.roundRect(x - tw / 2 - 7 * u, y - r * 0.45 - 30 * u, tw + 14 * u, 24 * u, 5 * u); ctx.fill();
    ctx.fillStyle = '#ff5a59';
    ctx.fillText(label, x - tw / 2, y - r * 0.45 - 12 * u);
    ctx.restore();
  }
}
