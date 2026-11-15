// Turns raw pose/position samples into shots, rallies and coaching metrics.
import { L } from './pose.js';
import { distToNet, zoneOf } from './court.js';
import { mean, median, bisect } from './util.js';

const RALLY_GAP = 4.0;      // s between shots that still counts as the same rally
const MIN_SHOT_GAP = 0.45;  // s between alternating shots
const KITCHEN_D = 10;       // ft from net: "at the kitchen line" (7 ft NVZ + 3 ft)

function angleAt(a, b, c) {
  const v1x = a[0] - b[0], v1y = a[1] - b[1], v2x = c[0] - b[0], v2y = c[1] - b[1];
  const d = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (!d) return NaN;
  return Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / d))) * 180 / Math.PI;
}
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Per-frame features for one player slot. */
function slotSeries(samples, k, aspect) {
  const N = samples.length;
  const F = () => new Float64Array(N).fill(NaN);
  const s = {
    present: new Uint8Array(N), cx: F(), cy: F(), conf: F(),
    hipH: F(), knee: F(), stance: F(), elbowL: F(), elbowR: F(),
    relLx: F(), relLy: F(), relRx: F(), relRy: F(), visL: F(), visR: F(),
    latL: F(), latR: F(), dyL: F(), dyR: F(), noseDy: F(),
  };
  for (let i = 0; i < N; i++) {
    const p = samples[i].p[k];
    if (!p) continue;
    const g = j => [p.lm[j * 3] * aspect, p.lm[j * 3 + 1]];
    const ls = g(L.ls), rs = g(L.rs), lh = g(L.lh), rh = g(L.rh), lk = g(L.lk), rk = g(L.rk);
    const la = g(L.la), ra = g(L.ra), lw = g(L.lw), rw = g(L.rw), le = g(L.le), re = g(L.re), nose = g(L.nose);
    const shm = mid(ls, rs), hpm = mid(lh, rh);
    const torso = dist(shm, hpm);
    if (torso < 1e-4) continue;
    s.present[i] = 1;
    s.cx[i] = p.cx; s.cy[i] = p.cy; s.conf[i] = p.conf;
    const legLen = (dist(lh, lk) + dist(lk, la) + dist(rh, rk) + dist(rk, ra)) / 2 || torso * 1.6;
    s.hipH[i] = ((la[1] + ra[1]) / 2 - hpm[1]) / legLen;
    s.knee[i] = (angleAt(lh, lk, la) + angleAt(rh, rk, ra)) / 2;
    const sw = dist(ls, rs) || torso * 0.6;
    s.stance[i] = dist(la, ra) / sw;
    s.elbowL[i] = angleAt(ls, le, lw);
    s.elbowR[i] = angleAt(rs, re, rw);
    s.relLx[i] = (lw[0] - hpm[0]) / torso; s.relLy[i] = (lw[1] - hpm[1]) / torso;
    s.relRx[i] = (rw[0] - hpm[0]) / torso; s.relRy[i] = (rw[1] - hpm[1]) / torso;
    s.visL[i] = p.lm[L.lw * 3 + 2]; s.visR[i] = p.lm[L.rw * 3 + 2];
    const ax = (rs[0] - ls[0]) / sw, ay = (rs[1] - ls[1]) / sw; // body "right" axis (anatomical)
    s.latL[i] = ((lw[0] - shm[0]) * ax + (lw[1] - shm[1]) * ay) / sw;
    s.latR[i] = ((rw[0] - shm[0]) * ax + (rw[1] - shm[1]) * ay) / sw;
    s.dyL[i] = s.relLy[i]; s.dyR[i] = s.relRy[i];
    s.noseDy[i] = (nose[1] - hpm[1]) / torso;
  }
  return s;
}

/** Fill short gaps (<= maxGap s) linearly and smooth court positions. */
function cleanPositions(T, arr, maxGap = 1.0) {
  const N = arr.length, out = Float64Array.from(arr);
  let last = -1;
  for (let i = 0; i < N; i++) {
    if (!Number.isFinite(arr[i])) continue;
    if (last >= 0 && i - last > 1 && T[i] - T[last] <= maxGap) {
      for (let j = last + 1; j < i; j++) out[j] = arr[last] + (arr[i] - arr[last]) * (T[j] - T[last]) / (T[i] - T[last]);
    }
    last = i;
  }
  const sm = new Float64Array(N).fill(NaN);
  for (let i = 0; i < N; i++) {
    if (!Number.isFinite(out[i])) continue;
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(N - 1, i + 2); j++) if (Number.isFinite(out[j])) { sum += out[j]; n++; }
    sm[i] = sum / n;
  }
  return sm;
}

function wristSpeeds(T, s) {
  const N = T.length;
  const ws = new Float64Array(N), which = new Int8Array(N); // 0 = left, 1 = right
  for (let i = 1; i < N; i++) {
    if (!s.present[i] || !s.present[i - 1]) continue;
    const dt = T[i] - T[i - 1];
    if (dt <= 0 || dt > 0.3) continue;
    const l = s.visL[i] > 0.3 && s.visL[i - 1] > 0.3 ? Math.hypot(s.relLx[i] - s.relLx[i - 1], s.relLy[i] - s.relLy[i - 1]) / dt : 0;
    const r = s.visR[i] > 0.3 && s.visR[i - 1] > 0.3 ? Math.hypot(s.relRx[i] - s.relRx[i - 1], s.relRy[i] - s.relRy[i - 1]) / dt : 0;
    ws[i] = Math.min(Math.max(l, r), 40);
    which[i] = r >= l ? 1 : 0;
  }
  return { ws, which };
}

export function findRallyOutcome(outcomes, rally) {
  if (!outcomes) return null;
  if (outcomes[rally.id]) return outcomes[rally.id];
  for (const [k, v] of Object.entries(outcomes)) {
    if (Math.abs(+k - rally.id) <= 15) return v;
  }
  return null;
}

export function analyze(match) {
  const { samples, players, video } = match;
  const sens = match.cfg.sensitivity ?? 3.5;
  const aspect = video.w / video.h;
  const N = samples.length;
  const T = Float64Array.from(samples.map(s => s.t));
  const nS = players.length;

  const series = players.map((_, k) => {
    const s = slotSeries(samples, k, aspect);
    s.x = cleanPositions(T, s.cx);
    s.y = cleanPositions(T, s.cy);
    s.speed = new Float64Array(N).fill(NaN);
    for (let i = 1; i < N - 1; i++) {
      const dt = T[i + 1] - T[i - 1];
      if (Number.isFinite(s.x[i + 1]) && Number.isFinite(s.x[i - 1]) && dt > 0) {
        s.speed[i] = Math.min(30, Math.hypot(s.x[i + 1] - s.x[i - 1], s.y[i + 1] - s.y[i - 1]) / dt);
      }
    }
    Object.assign(s, wristSpeeds(T, s));
    return s;
  });

  // ---- swing candidates (wrist speed peaks relative to the hips, in torso-lengths / s)
  const cands = [];
  series.forEach((s, k) => {
    let lastT = -1e9, lastIdx = -1;
    for (let i = 1; i < N - 1; i++) {
      const v = s.ws[i];
      if (v < sens || v < s.ws[i - 1] || v < s.ws[i + 1]) continue;
      if (T[i] - lastT < 0.6) {
        if (v > cands[lastIdx].speed) { Object.assign(cands[lastIdx], { i, t: T[i], speed: v, wrist: s.which[i] }); lastT = T[i]; }
        continue;
      }
      cands.push({ i, t: T[i], slot: k, team: players[k].team, speed: v, wrist: s.which[i] });
      lastIdx = cands.length - 1; lastT = T[i];
    }
  });
  cands.sort((a, b) => a.t - b.t);

  // ---- enforce alternation between teams
  const shots = [];
  for (const c of cands) {
    const last = shots[shots.length - 1];
    if (!last || c.t - last.t > RALLY_GAP) { shots.push({ ...c }); continue; }
    if (c.team !== last.team) {
      if (c.t - last.t >= MIN_SHOT_GAP) shots.push({ ...c });
      else if (c.speed > last.speed) shots[shots.length - 1] = { ...c };
    } else if (c.t - last.t < 1.0) {
      if (c.speed > last.speed) shots[shots.length - 1] = { ...c };
    } else {
      shots.push({ ...c, unmatched: true }); // opponent's shot probably missed
    }
  }

  // ---- rallies
  const rallies = [];
  let cur = null;
  shots.forEach((sh, j) => {
    if (!cur || sh.t - shots[j - 1].t > RALLY_GAP) {
      cur = { shots: [] };
      rallies.push(cur);
    }
    cur.shots.push(j);
  });
  const keptRallies = rallies.filter(r => r.shots.length >= 2);
  const keptShotIdx = new Set(keptRallies.flatMap(r => r.shots));
  const finalShots = shots.filter((_, j) => keptShotIdx.has(j));
  const remap = new Map();
  shots.forEach((_, j) => { if (keptShotIdx.has(j)) remap.set(j, remap.size); });
  keptRallies.forEach((r, ri) => {
    r.shots = r.shots.map(j => remap.get(j));
    r.index = ri;
    const first = finalShots[r.shots[0]], lastS = finalShots[r.shots[r.shots.length - 1]];
    r.start = Math.max(T[0], first.t - 1.0);
    r.end = Math.min(T[N - 1], lastS.t + 1.5);
    r.id = Math.round(first.t * 10);
    r.serverSlot = first.slot;
    r.serverTeam = first.team;
    r.outcome = findRallyOutcome(match.outcomes, r);
  });

  // ---- in-rally mask
  const inRally = new Int16Array(N).fill(-1);
  keptRallies.forEach(r => {
    for (let i = bisect(T, r.start); i < N && T[i] <= r.end; i++) if (T[i] >= r.start) inRally[i] = r.index;
  });

  // ---- handedness: calibrated paddle hand, else majority paddle wrist from swings
  const handed = series.map((s, k) => {
    if (players[k].hand === 'L' || players[k].hand === 'R') return players[k].hand;
    const mine = finalShots.filter(sh => sh.slot === k);
    const right = mine.filter(sh => sh.wrist === 1).length;
    return mine.length ? (right >= mine.length / 2 ? 'R' : 'L') : 'R';
  });

  // ---- shot attributes
  const medSpeed = series.map((_, k) => median(finalShots.filter(sh => sh.slot === k).map(sh => sh.speed)) || sens);
  finalShots.forEach(sh => {
    const s = series[sh.slot];
    const i = sh.i;
    sh.cx = s.x[i]; sh.cy = s.y[i];
    sh.d = Number.isFinite(sh.cy) ? distToNet(sh.cy) : NaN;
    sh.zone = Number.isFinite(sh.cy) ? zoneOf(sh.cy) : 'unknown';
    const dom = handed[sh.slot];
    const lat = dom === 'R' ? s.latR[i] : s.latL[i];
    sh.fh = dom === 'R' ? lat >= 0 : lat <= 0;
    sh.reach = Math.abs(lat);
    const wristDy = sh.wrist === 1 ? s.dyR[i] : s.dyL[i];
    sh.overhead = Number.isFinite(wristDy) && Number.isFinite(s.noseDy[i]) && wristDy < s.noseDy[i] - 0.1;
    sh.rel = sh.speed / medSpeed[sh.slot];
  });
  keptRallies.forEach(r => {
    r.shots.forEach((j, n) => {
      const sh = finalShots[j];
      sh.rally = r.index; sh.idx = n;
      if (n === 0) sh.type = 'Serve';
      else if (n === 1) sh.type = 'Return';
      else if (n === 2) sh.type = sh.rel > 1.25 ? '3rd-shot drive' : '3rd-shot drop';
      else if (sh.overhead) sh.type = 'Overhead';
      else if (sh.zone === 'kitchen') sh.type = sh.rel < 0.85 ? 'Dink' : 'Volley / speed-up';
      else if (sh.zone === 'transition') sh.type = 'Reset (transition)';
      else sh.type = 'Drive (baseline)';
    });
  });

  // ---- metrics
  const half = Math.floor(keptRallies.length / 2);
  const metrics = series.map((s, k) => slotMetrics(k, s, T, inRally, finalShots, keptRallies, players, half, handed[k]));
  const team = {};
  for (const tm of ['A', 'B']) team[tm] = teamMetrics(tm, series, T, inRally, players, keptRallies);

  return { T, N, series, shots: finalShots, rallies: keptRallies, inRally, handed, metrics, team, duration: T[N - 1] - T[0] };
}

function firstIndexAfter(T, t) {
  const i = bisect(T, t);
  return T[i] < t ? i + 1 : i;
}

function slotMetrics(k, s, T, inRally, shots, rallies, players, half, hand) {
  const N = T.length;
  const team = players[k].team;
  const m = { slot: k };
  let present = 0, rallyFrames = 0, confSum = 0;
  const zone = { kitchen: 0, transition: 0, baseline: 0 };
  let distance = 0, speedSum = 0, speedN = 0, maxSpeed = 0;
  let readyN = 0, lowN = 0, tallN = 0;
  const knees = [], stances = [], depths = [];
  const myShotTimes = shots.filter(sh => sh.slot === k).map(sh => sh.t);
  const nearOwnShot = t => myShotTimes.some(x => Math.abs(x - t) < 0.5);
  // paddle hand below the hip line (dy > 0 means below hips in image space)
  const domLow = hand === 'R' ? i => s.dyR[i] > 0.05 && s.visR[i] > 0.3 : i => s.dyL[i] > 0.05 && s.visL[i] > 0.3;

  for (let i = 0; i < N; i++) {
    if (inRally[i] < 0) continue;
    rallyFrames++;
    if (!s.present[i] && !Number.isFinite(s.y[i])) continue;
    present++;
    if (Number.isFinite(s.conf[i])) confSum += s.conf[i];
    if (Number.isFinite(s.y[i])) zone[zoneOf(s.y[i])]++;
    if (i > 0 && inRally[i - 1] === inRally[i] && Number.isFinite(s.x[i]) && Number.isFinite(s.x[i - 1])) {
      const step = Math.hypot(s.x[i] - s.x[i - 1], s.y[i] - s.y[i - 1]);
      if (step < 4) distance += step;
    }
    if (Number.isFinite(s.speed[i])) { speedSum += s.speed[i]; speedN++; maxSpeed = Math.max(maxSpeed, s.speed[i]); }
    if (s.present[i] && Number.isFinite(s.y[i]) && distToNet(s.y[i]) <= KITCHEN_D && !nearOwnShot(T[i])) {
      readyN++;
      if (domLow(i)) lowN++;
      if (s.knee[i] > 165) tallN++;
      if (Number.isFinite(s.knee[i])) knees.push(s.knee[i]);
      if (Number.isFinite(s.stance[i])) stances.push(s.stance[i]);
    }
    if (Number.isFinite(s.y[i]) && distToNet(s.y[i]) <= 12) depths.push(distToNet(s.y[i]));
  }
  const zTot = zone.kitchen + zone.transition + zone.baseline || 1;
  m.coverage = rallyFrames ? present / rallyFrames : 0;
  m.conf = present ? confSum / present : 0;
  m.zone = { kitchen: zone.kitchen / zTot, transition: zone.transition / zTot, baseline: zone.baseline / zTot };
  m.distance = distance;
  m.distancePerRally = rallies.length ? distance / rallies.length : NaN;
  m.avgSpeed = speedN ? speedSum / speedN : NaN;
  m.maxSpeed = maxSpeed;
  m.readyFrames = readyN;
  m.paddleLowPct = readyN ? lowN / readyN : NaN;
  m.tallPct = readyN ? tallN / readyN : NaN;
  m.kneeAvg = mean(knees);
  m.stanceAvg = median(stances);
  m.kitchenDepth = mean(depths);

  // shots
  const mine = shots.filter(sh => sh.slot === k);
  m.shots = mine.length;
  m.shotTypes = {};
  mine.forEach(sh => { m.shotTypes[sh.type] = (m.shotTypes[sh.type] || 0) + 1; });
  m.fh = mine.filter(sh => sh.fh).length;
  m.bh = mine.length - m.fh;
  m.transitionContacts = mine.filter(sh => sh.zone === 'transition' && sh.idx > 1).map(sh => sh.t);
  m.overreach = mine.filter(sh => sh.reach > 2.2).map(sh => sh.t);
  m.thirdDrives = mine.filter(sh => sh.type === '3rd-shot drive').length;
  m.thirdDrops = mine.filter(sh => sh.type === '3rd-shot drop').length;

  // kitchen arrival
  const arrival = (t0, rally) => {
    const end = Math.min(rally.end + 1, t0 + 8);
    for (let i = firstIndexAfter(T, t0); i < N && T[i] <= end; i++) {
      if (Number.isFinite(s.y[i]) && distToNet(s.y[i]) <= KITCHEN_D) return T[i] - t0;
    }
    return rally.end - t0 >= 3 ? 8 : null; // never got there in a rally that lasted
  };
  m.arrivalReturn = [];
  m.arrivalThird = [];
  rallies.forEach(r => {
    const ret = shots[r.shots[1]], third = shots[r.shots[2]];
    if (ret && ret.slot === k) {
      const dt = arrival(ret.t, r);
      if (dt !== null) m.arrivalReturn.push({ t: ret.t, dt, rally: r.index });
    }
    // serving team: both partners should work up to the kitchen after the 3rd shot
    if (third && third.team === team) {
      const dt = arrival(third.t, r);
      if (dt !== null) m.arrivalThird.push({ t: third.t, dt, rally: r.index });
    }
  });

  // split step & reaction to opponent shots
  m.split = { on: 0, late: 0, none: 0, events: [] };
  m.reaction = [];
  shots.forEach((sh, j) => {
    if (sh.team === team || sh.rally === undefined) return;
    const i0 = bisect(T, sh.t);
    if (!s.present[i0]) return;
    // split step: hip dip around the opponent's contact
    const base = [];
    for (let i = firstIndexAfter(T, sh.t - 0.9); i < N && T[i] < sh.t - 0.4; i++) if (Number.isFinite(s.hipH[i])) base.push(s.hipH[i]);
    let minV = Infinity, minT = null;
    for (let i = firstIndexAfter(T, sh.t - 0.4); i < N && T[i] <= sh.t + 0.6; i++) {
      if (Number.isFinite(s.hipH[i]) && s.hipH[i] < minV) { minV = s.hipH[i]; minT = T[i]; }
    }
    if (base.length && minT !== null) {
      const depth = Math.max(...base) - minV;
      let kind = 'none';
      if (depth > 0.03) kind = minT - sh.t <= 0.15 ? 'on' : 'late';
      m.split[kind]++;
      if (kind !== 'on') m.split.events.push(sh.t);
    }
    // reaction: only for the player who hits the next shot
    const next = shots[j + 1];
    if (next && next.slot === k && next.rally === sh.rally) {
      for (let i = i0 + 1; i < N && T[i] <= sh.t + 1.2; i++) {
        if (s.speed[i] > 4) { m.reaction.push({ t: sh.t, dt: T[i] - sh.t, rally: sh.rally }); break; }
      }
    }
  });
  m.reactionAvg = mean(m.reaction.map(r => r.dt));
  const splitN = m.split.on + m.split.late + m.split.none;
  m.splitOnPct = splitN ? m.split.on / splitN : NaN;
  m.splitN = splitN;

  // fatigue: first half vs second half of rallies
  const halfOf = arr => [mean(arr.filter(e => e.rally < half).map(e => e.dt)), mean(arr.filter(e => e.rally >= half).map(e => e.dt))];
  const [a1, a2] = halfOf([...m.arrivalReturn, ...m.arrivalThird]);
  const [r1, r2] = halfOf(m.reaction);
  const sp1 = [], sp2 = [];
  for (let i = 0; i < N; i++) if (inRally[i] >= 0 && Number.isFinite(s.speed[i])) (inRally[i] < half ? sp1 : sp2).push(s.speed[i]);
  m.fatigue = { arr1: a1, arr2: a2, react1: r1, react2: r2, speed1: mean(sp1), speed2: mean(sp2) };

  // outcomes (needs user labels)
  m.errors = []; m.errorsFH = 0; m.errorsBH = 0; m.winners = 0;
  rallies.forEach(r => {
    const o = r.outcome;
    if (!o || o.by !== k) return;
    const myLast = r.shots.map(j => shots[j]).filter(sh => sh.slot === k).pop();
    if (o.how === 'error') {
      m.errors.push(myLast ? myLast.t : r.end - 1.5);
      if (myLast) myLast.fh ? m.errorsFH++ : m.errorsBH++;
    } else if (o.how === 'winner') m.winners++;
  });
  return m;
}

function teamMetrics(tm, series, T, inRally, players, rallies) {
  const idx = players.map((p, k) => (p.team === tm ? k : -1)).filter(k => k >= 0);
  const res = { won: 0, lost: 0, servedWon: 0, servedN: 0, recvWon: 0, recvN: 0, labeled: 0 };
  rallies.forEach(r => {
    if (!r.outcome?.winner) return;
    res.labeled++;
    const won = r.outcome.winner === tm;
    won ? res.won++ : res.lost++;
    if (r.serverTeam === tm) { res.servedN++; if (won) res.servedWon++; } else { res.recvN++; if (won) res.recvWon++; }
  });
  if (idx.length < 2) return res;
  const [a, b] = idx.map(k => series[k]);
  let both = 0, gap = 0, middle = 0, upBoth = 0;
  const gapEv = [], midEv = [];
  let gapRun = 0, midRun = 0;
  for (let i = 0; i < T.length; i++) {
    if (inRally[i] < 0 || !Number.isFinite(a.x[i]) || !Number.isFinite(b.x[i])) { gapRun = midRun = 0; continue; }
    both++;
    const up = distToNet(a.y[i]) <= 11 && distToNet(b.y[i]) <= 11;
    if (up) {
      upBoth++;
      if (Math.abs(a.x[i] - b.x[i]) > 12) { gap++; if (++gapRun === 3) gapEv.push(T[i]); } else gapRun = 0;
    } else gapRun = 0;
    if ((a.x[i] < 10) === (b.x[i] < 10)) { middle++; if (++midRun === 5) midEv.push(T[i]); } else midRun = 0;
  }
  res.gapPct = upBoth ? gap / upBoth : NaN;
  res.middleOpenPct = both ? middle / both : NaN;
  res.gapEvents = gapEv;
  res.middleEvents = midEv;
  res.frames = both;
  return res;
}
