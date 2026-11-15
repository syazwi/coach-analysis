// Coach callouts: short lines a coach would shout during the point, placed at the moment
// they apply and above the player they are for (on the video and in exported videos).
//   fix     – something this player should do right now (positioning, readiness, shot choice)
//   exploit – an opening on the other side to attack
//   good    – reinforcement when they do the right thing
import { distToNet, COURT } from './court.js';
import { bisect } from './util.js';
import { L } from './pose.js';

const KITCHEN = 10;   // ft from net: at the kitchen line
const DEEP = 14;      // ft from net: back in transition / baseline
const DUR = 1.9;      // s a callout stays on screen

export const CALLOUT_KINDS = {
  fix: { color: '#c98500', icon: '📣' },
  exploit: { color: '#199e70', icon: '🎯' },
  good: { color: '#3987e5', icon: '👍' },
};

/**
 * Builds the callout list from the analysis. Returns [{ t0, t1, slot, text, kind, pri }], sorted by t0,
 * at most one callout per player on screen at a time.
 */
export function buildCallouts(match, A) {
  const { players } = match;
  const { T, series, shots, rallies, handed } = A;
  if (!T?.length) return [];
  const doubles = players.length > 2;
  const at = (k, t) => {
    const i = Math.min(T.length - 1, bisect(T, t));
    const s = series[k];
    const x = s.x[i], y = s.y[i];
    if (!Number.isFinite(y)) return null;
    return { i, x, y, d: distToNet(y), speed: s.speed[i] };
  };
  const mates = k => players.map((p, j) => j).filter(j => j !== k && players[j].team === players[k].team);
  const opps = k => players.map((p, j) => j).filter(j => players[j].team !== players[k].team);
  const name = k => players[k].label;
  // paddle wrist height relative to the hips (torso lengths, + = below)
  const paddleLow = (k, t) => {
    const i = Math.min(T.length - 1, bisect(T, t));
    const s = series[k];
    const v = handed[k] === 'L' ? s.relLy[i] : s.relRy[i];
    const vis = handed[k] === 'L' ? s.visL[i] : s.visR[i];
    return Number.isFinite(v) && vis > 0.4 && v > 0.35;
  };

  const out = [];
  const add = (slot, t, text, kind = 'fix', pri = 2, dur = DUR) => out.push({ t0: t, t1: t + dur, slot, text, kind, pri });

  for (const r of rallies) {
    const rs = r.shots.map(j => shots[j]);
    rs.forEach((sh, n) => {
      const k = sh.slot;
      const me = at(k, sh.t);

      // --- serve: returner's partner belongs at the kitchen line
      if (n === 0 && doubles) {
        for (const o of opps(k)) {
          const p = at(o, sh.t + 0.2);
          const ret = rs[1]?.slot;
          if (p && o !== ret && p.d > KITCHEN + 2) add(o, sh.t - 0.2, 'Partner up — get to the kitchen line!', 'fix', 2);
        }
        for (const m of mates(k)) {
          const p = at(m, sh.t + 0.2);
          if (p && p.d < DEEP - 4) add(m, sh.t - 0.2, 'Stay back until the return bounces!', 'fix', 1);
        }
      }

      // --- return: follow it to the kitchen
      if (n === 1) {
        const later = at(k, sh.t + 1.6);
        if (later && later.d > KITCHEN + 1) add(k, sh.t + 0.3, 'Follow your return — get to the kitchen!', 'fix', 3);
        else if (later) add(k, sh.t + 0.6, 'Good — you’re at the line.', 'good', 0, 1.4);
      }

      // --- third shot: choice depends on where the returning team is
      if (n === 2) {
        const o = opps(k).map(j => at(j, sh.t)).filter(Boolean);
        const allUp = o.length && o.every(p => p.d <= KITCHEN);
        const someBack = o.some(p => p.d > DEEP);
        if (allUp) add(k, sh.t - 1.0, 'They’re at the line — drop it soft!', 'fix', 3, 1.4);
        else if (someBack) add(k, sh.t - 1.0, 'They’re still back — drive it deep!', 'exploit', 3, 1.4);
        if (allUp && sh.type === '3rd-shot drive') add(k, sh.t + 0.4, 'Driving into a wall — try the drop.', 'fix', 2, 1.6);
        // move up behind the drop
        for (const j of [k, ...mates(k)]) {
          const p = at(j, sh.t + 1.8);
          if (p && p.d > DEEP && sh.type === '3rd-shot drop') add(j, sh.t + 0.8, 'Move up behind your drop!', 'fix', 3);
        }
      }

      // --- the rest of the rally: readiness when the other side hits
      if (n >= 1) {
        for (const j of opps(k)) {
          const p = at(j, sh.t);
          if (!p) continue;
          if (p.d <= KITCHEN && paddleLow(j, sh.t - 0.15)) add(j, sh.t - 0.3, 'Paddle up!', 'fix', 3, 1.4);
          else if (p.d > KITCHEN && p.d <= DEEP + 3 && n >= 3) {
            if (Number.isFinite(p.speed) && p.speed > 6) add(j, sh.t - 0.35, 'Split step — get set!', 'fix', 2, 1.3);
            else add(j, sh.t + 0.2, 'Out of no-man’s land — reset and move up!', 'fix', 1);
          }
        }
      }

      // --- openings for the hitter (from shot 4 on): deep opponent, open middle
      if (n >= 3 && me) {
        const o = opps(k).map(j => ({ j, p: at(j, sh.t) })).filter(e => e.p);
        const deep = o.filter(e => e.p.d > DEEP);
        const up = o.filter(e => e.p.d <= KITCHEN);
        if (deep.length && up.length) add(k, sh.t - 0.9, `Hit at ${name(deep[0].j)}’s feet!`, 'exploit', 2, 1.3);
        else if (o.length === 2 && Math.abs(o[0].p.x - o[1].p.x) > 13) add(k, sh.t - 0.9, 'Middle’s open — go down the middle!', 'exploit', 2, 1.3);
        else if (o.length === 1 && Math.abs(o[0].p.x - COURT.W / 2) > 6) add(k, sh.t - 0.9, 'Hit to the open side!', 'exploit', 1, 1.3);
      }

      // --- partners: move as a pair, close the middle
      if (doubles && n >= 2) {
        const m = mates(k)[0];
        const pm = m !== undefined ? at(m, sh.t) : null;
        if (me && pm) {
          if (Math.abs(me.x - pm.x) > 14) { add(k, sh.t + 0.1, 'Close the middle!', 'fix', 1); add(m, sh.t + 0.1, 'Close the middle!', 'fix', 1); }
          else if (Math.abs(me.d - pm.d) > 9) {
            const back = me.d > pm.d ? k : m;
            add(back, sh.t + 0.1, `Move up with ${name(back === k ? m : k)} — stay level!`, 'fix', 2);
          }
        }
      }

      // --- reaching / standing tall at contact
      if (sh.reach > 1.9 && n >= 3) add(k, sh.t + 0.25, 'Move your feet — don’t reach!', 'fix', 1, 1.5);
    });

    // --- end of the point (only when the rally outcome was labeled)
    const win = r.outcome?.winner;
    if (win) {
      const tEnd = rs[rs.length - 1].t + 0.6;
      players.forEach((p, k) => {
        if (p.team === win) add(k, tEnd, 'Great point!', 'good', 4, 1.6);
        else add(k, tEnd, r.outcome.how === 'error' && r.outcome.by === k ? 'Shake it off — reset, next point.' : 'Next one — stay patient.', 'fix', 4, 1.6);
      });
    }
  }

  // one callout per player at a time: higher priority first, then earlier
  out.sort((a, b) => b.pri - a.pri || a.t0 - b.t0);
  const kept = [], busy = players.map(() => []);
  for (const c of out) {
    if (busy[c.slot].some(([a, b]) => c.t0 < b + 0.3 && c.t1 > a - 0.3)) continue;
    busy[c.slot].push([c.t0, c.t1]);
    kept.push(c);
  }
  return kept.sort((a, b) => a.t0 - b.t0);
}

/** Callouts on screen at time t, filtered by who: 'all' | team id ('A'/'B'). */
export function activeCallouts(list, t, players, who = 'all') {
  return list.filter(c => t >= c.t0 && t <= c.t1 && (who === 'all' || players[c.slot]?.team === who));
}

/**
 * Draws speech bubbles. headOf(slot) -> [x, y] in px of the player's head, or null.
 * Bubbles without a visible player stack at the top centre.
 */
export function drawCallouts(ctx, w, h, t, active, headOf, players, playerColor) {
  if (!active.length) return;
  const u = Math.max(0.6, h / 720);
  const fs = Math.round(17 * u);
  let stackY = 56 * u;
  const placed = [];
  for (const c of active) {
    const age = t - c.t0, left = c.t1 - t;
    const pop = Math.min(1, age / 0.18);                     // pop in
    const alpha = Math.min(1, left / 0.25, 0.35 + pop);      // fade out
    const kind = CALLOUT_KINDS[c.kind] || CALLOUT_KINDS.fix;
    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.font = `800 ${fs}px Inter, system-ui, sans-serif`;
    const who = players[c.slot]?.label || '';
    const text = `${kind.icon} ${c.text}`;
    const tw = ctx.measureText(text).width;
    ctx.font = `600 ${Math.round(11 * u)}px Inter, system-ui, sans-serif`;
    const nw = ctx.measureText(who).width;
    const bw = Math.max(tw, nw) + 26 * u, bh = 50 * u;
    const head = headOf(c.slot);
    let x, y, tail = null;
    if (head) {
      x = Math.min(w - bw - 6 * u, Math.max(6 * u, head[0] - bw / 2));
      y = head[1] - bh - 30 * u;
      if (y < 6 * u) y = head[1] + 30 * u; // no room above: show below the head
      // avoid overlapping another bubble
      for (const p of placed) if (x < p.x + p.w && x + bw > p.x && y < p.y + p.h && y + bh > p.y) y = p.y - bh - 6 * u;
      tail = head;
    } else {
      x = (w - bw) / 2; y = stackY; stackY += bh + 8 * u;
    }
    placed.push({ x, y, w: bw, h: bh });
    const s = 0.85 + 0.15 * pop;
    ctx.translate(x + bw / 2, y + bh / 2); ctx.scale(s, s); ctx.translate(-(x + bw / 2), -(y + bh / 2));
    // tail
    if (tail) {
      const ty = tail[1] > y ? y + bh : y;
      ctx.fillStyle = 'rgba(17,18,20,0.9)';
      ctx.beginPath();
      ctx.moveTo(Math.min(x + bw - 14 * u, Math.max(x + 14 * u, tail[0] - 8 * u)), ty);
      ctx.lineTo(Math.min(x + bw - 6 * u, Math.max(x + 22 * u, tail[0] + 8 * u)), ty);
      ctx.lineTo(tail[0], tail[1] + (tail[1] > y ? -12 * u : 12 * u));
      ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = 'rgba(17,18,20,0.9)';
    ctx.beginPath(); ctx.roundRect(x, y, bw, bh, 10 * u); ctx.fill();
    ctx.strokeStyle = kind.color; ctx.lineWidth = 2.5 * u;
    ctx.beginPath(); ctx.roundRect(x, y, bw, bh, 10 * u); ctx.stroke();
    ctx.fillStyle = playerColor(players, c.slot);
    ctx.font = `600 ${Math.round(11 * u)}px Inter, system-ui, sans-serif`;
    ctx.fillText(who.toUpperCase(), x + 13 * u, y + 17 * u);
    ctx.fillStyle = '#f0efec';
    ctx.font = `800 ${fs}px Inter, system-ui, sans-serif`;
    ctx.fillText(text, x + 13 * u, y + 39 * u);
    ctx.restore();
  }
}

/** Head position helper for drawCallouts from a pose (normalized landmarks). */
export function headFromPose(lm, w, h) {
  const v = lm[L.nose * 3 + 2];
  if (v < 0.2) {
    const x = (lm[L.ls * 3] + lm[L.rs * 3]) / 2, y = (lm[L.ls * 3 + 1] + lm[L.rs * 3 + 1]) / 2;
    return [x * w, y * h - 20];
  }
  return [lm[L.nose * 3] * w, lm[L.nose * 3 + 1] * h - 14];
}
