import { BONES } from './pose.js';
import { applyH, COURT_LINES, NET_LINE } from './court.js';
import { fitCanvas, fmtTime } from './util.js';

export const PLAYER_COLORS = { A: ['#3987e5', '#199e70'], B: ['#d95926', '#d55181'] };
export const TEAM_COLORS = { A: '#3987e5', B: '#d95926' };
export const BALL_COLOR = '#eedd33';
const INK = '#f0efec', INK2 = '#c3c2b7', MUTED = '#8f8e86', GRID = '#33332f', SURF = '#1a1a19';

export function playerColor(players, k) {
  const p = players[k];
  const sameTeam = players.slice(0, k).filter(q => q.team === p.team).length;
  return PLAYER_COLORS[p.team][sameTeam % 2];
}

/** lm: Float32Array 33*3 normalized. */
export function drawSkeleton(ctx, lm, w, h, color, lineW = 2.5) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineW;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const [a, b] of BONES) {
    if (lm[a * 3 + 2] < 0.25 || lm[b * 3 + 2] < 0.25) continue;
    ctx.moveTo(lm[a * 3] * w, lm[a * 3 + 1] * h);
    ctx.lineTo(lm[b * 3] * w, lm[b * 3 + 1] * h);
  }
  ctx.stroke();
  ctx.fillStyle = color;
  for (const j of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
    if (lm[j * 3 + 2] < 0.25) continue;
    ctx.beginPath();
    ctx.arc(lm[j * 3] * w, lm[j * 3 + 1] * h, j === 0 ? lineW * 1.8 : lineW * 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function drawCourtOverlay(ctx, cal, w, h) {
  const P = (x, y) => { const [u, v] = applyH(cal.toImg, x, y); return [u * w, v * h]; };
  // kitchen shading
  ctx.fillStyle = 'rgba(25,158,112,0.13)';
  ctx.beginPath();
  [[0, 15], [20, 15], [20, 29], [0, 29]].forEach(([x, y], i) => { const [u, v] = P(x, y); i ? ctx.lineTo(u, v) : ctx.moveTo(u, v); });
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(240,239,236,0.55)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (const [a, b] of COURT_LINES) { const p = P(...a), q = P(...b); ctx.moveTo(...p); ctx.lineTo(...q); }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(238,221,51,0.7)';
  ctx.beginPath(); ctx.moveTo(...P(...NET_LINE[0])); ctx.lineTo(...P(...NET_LINE[1])); ctx.stroke();
}

export function drawLabel(ctx, text, x, y, color) {
  ctx.font = '600 12px Inter, system-ui, sans-serif';
  const tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(17,18,20,0.8)';
  ctx.beginPath(); ctx.roundRect(x - tw / 2 - 6, y - 20, tw + 12, 18, 4); ctx.fill();
  ctx.fillStyle = color;
  ctx.fillRect(x - tw / 2 - 6, y - 20, 3, 18);
  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.fillText(text, x + 1, y - 7);
  ctx.textAlign = 'left';
}

// ---------- top-down court ----------
const VIEW = { x0: -6, x1: 26, y0: -8, y1: 52 };
export function courtMapper(w, h) {
  const sx = w / (VIEW.x1 - VIEW.x0), sy = h / (VIEW.y1 - VIEW.y0);
  const s = Math.min(sx, sy);
  const ox = (w - (VIEW.x1 - VIEW.x0) * s) / 2, oy = (h - (VIEW.y1 - VIEW.y0) * s) / 2;
  return { s, map: (x, y) => [ox + (x - VIEW.x0) * s, oy + (y - VIEW.y0) * s] };
}

export function drawCourtDiagram(ctx, w, h) {
  const { map } = courtMapper(w, h);
  ctx.fillStyle = SURF; ctx.fillRect(0, 0, w, h);
  const [a0, a1] = [map(0, 0), map(20, 44)];
  ctx.fillStyle = '#1f2a26'; ctx.fillRect(a0[0], a0[1], a1[0] - a0[0], a1[1] - a0[1]);
  const [k0, k1] = [map(0, 15), map(20, 29)];
  ctx.fillStyle = 'rgba(25,158,112,0.16)'; ctx.fillRect(k0[0], k0[1], k1[0] - k0[0], k1[1] - k0[1]);
  ctx.strokeStyle = 'rgba(240,239,236,0.6)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (const [p, q] of COURT_LINES) { ctx.moveTo(...map(...p)); ctx.lineTo(...map(...q)); }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(238,221,51,0.8)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(...map(-1, 22)); ctx.lineTo(...map(21, 22)); ctx.stroke();
  return map;
}

export function drawTopDown(canvas, entries) {
  const { ctx, w, h } = fitCanvas(canvas);
  const map = drawCourtDiagram(ctx, w, h);
  for (const e of entries) {
    if (!Number.isFinite(e.x)) continue;
    if (e.trail?.length > 1) {
      ctx.strokeStyle = e.color; ctx.globalAlpha = 0.4; ctx.lineWidth = 2;
      ctx.beginPath();
      e.trail.forEach(([x, y], i) => { const p = map(x, y); i ? ctx.lineTo(...p) : ctx.moveTo(...p); });
      ctx.stroke(); ctx.globalAlpha = 1;
    }
    const [u, v] = map(e.x, e.y);
    ctx.fillStyle = e.color;
    ctx.strokeStyle = SURF; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(u, v, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = INK2; ctx.font = '11px Inter, system-ui, sans-serif';
    ctx.fillText(e.label, u + 9, v + 4);
  }
}

/** Sequential single-hue heatmap on the court diagram. points: [[x,y],...] in court feet. */
export function drawHeatmap(canvas, points, hue = '#3987e5') {
  const { ctx, w, h } = fitCanvas(canvas);
  const map = drawCourtDiagram(ctx, w, h);
  const res = 1; // ft per cell
  const gw = (VIEW.x1 - VIEW.x0) / res, gh = (VIEW.y1 - VIEW.y0) / res;
  const grid = new Float32Array(gw * gh);
  for (const [x, y] of points) {
    if (!Number.isFinite(x)) continue;
    const gx = Math.floor((x - VIEW.x0) / res), gy = Math.floor((y - VIEW.y0) / res);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const X = gx + dx, Y = gy + dy;
      if (X < 0 || Y < 0 || X >= gw || Y >= gh) continue;
      grid[Y * gw + X] += Math.exp(-(dx * dx + dy * dy) / 2.5);
    }
  }
  let max = 0; for (const v of grid) max = Math.max(max, v);
  if (!max) {
    ctx.fillStyle = MUTED; ctx.font = '12px Inter, system-ui'; ctx.textAlign = 'center';
    ctx.fillText('No data', w / 2, h / 2); ctx.textAlign = 'left';
    return;
  }
  const r = parseInt(hue.slice(1, 3), 16), g = parseInt(hue.slice(3, 5), 16), b = parseInt(hue.slice(5, 7), 16);
  const [p0] = [map(VIEW.x0, VIEW.y0)];
  const cell = map(VIEW.x0 + res, VIEW.y0 + res);
  const cw = cell[0] - p0[0], ch = cell[1] - p0[1];
  for (let Y = 0; Y < gh; Y++) for (let X = 0; X < gw; X++) {
    const v = grid[Y * gw + X] / max;
    if (v < 0.04) continue;
    ctx.fillStyle = `rgba(${r},${g},${b},${(0.12 + 0.78 * v).toFixed(3)})`;
    ctx.fillRect(p0[0] + X * cw, p0[1] + Y * ch, cw + 0.5, ch + 0.5);
  }
  drawCourtLinesOnly(ctx, map);
}
function drawCourtLinesOnly(ctx, map) {
  ctx.strokeStyle = 'rgba(240,239,236,0.5)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (const [p, q] of COURT_LINES) { ctx.moveTo(...map(...p)); ctx.lineTo(...map(...q)); }
  ctx.stroke();
}

// ---------- timeline ----------
export function drawTimeline(canvas, o) {
  const { ctx, w, h } = fitCanvas(canvas);
  const { t0, t1, rallies, shots, players, current, marks, outcomeColor } = o;
  const X = t => ((t - t0) / (t1 - t0 || 1)) * w;
  ctx.fillStyle = SURF; ctx.fillRect(0, 0, w, h);
  // rallies
  for (const r of rallies) {
    const c = r.outcome?.winner ? outcomeColor(r.outcome.winner) : '#4a4a45';
    ctx.fillStyle = c; ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.roundRect(X(r.start), 8, Math.max(2, X(r.end) - X(r.start) - 2), 24, 4); ctx.fill();
    ctx.globalAlpha = 1;
  }
  // shots
  for (const s of shots) {
    ctx.fillStyle = playerColor(players, s.slot);
    const x = X(s.t);
    ctx.fillRect(x - 1, s.team === 'A' ? 22 : 10, 2, 9);
  }
  // finding markers
  if (marks?.length) {
    ctx.fillStyle = INK;
    for (const m of marks) {
      const x = X(m);
      ctx.beginPath(); ctx.moveTo(x, 36); ctx.lineTo(x - 5, 44); ctx.lineTo(x + 5, 44); ctx.closePath(); ctx.fill();
    }
  }
  // axis
  ctx.fillStyle = MUTED; ctx.font = '10px Inter, system-ui';
  const step = niceStep((t1 - t0) / 8);
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    ctx.fillRect(X(t), h - 14, 1, 4);
    ctx.fillText(fmtTime(t), X(t) + 3, h - 4);
  }
  // playhead
  if (Number.isFinite(current)) {
    ctx.fillStyle = INK; ctx.fillRect(X(current) - 1, 0, 2, h);
  }
}
function niceStep(raw) {
  const steps = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
  return steps.find(s => s >= raw) || 3600;
}

// ---------- line chart (with hover) ----------
export function drawLineChart(canvas, tip, cfg) {
  const { ctx, w, h } = fitCanvas(canvas);
  const { series, xLabels, yFmt = v => v.toFixed(1), markerX } = cfg;
  const pad = { l: 44, r: 12, t: 12, b: 26 };
  ctx.fillStyle = SURF; ctx.fillRect(0, 0, w, h);
  const all = series.flatMap(s => s.values.filter(Number.isFinite));
  if (!all.length) {
    ctx.fillStyle = MUTED; ctx.font = '12px Inter, system-ui'; ctx.fillText('Not enough data yet', pad.l, h / 2);
    canvas.onmousemove = null; return;
  }
  let lo = Math.min(...all), hi = Math.max(...all);
  if (cfg.zero) lo = Math.min(0, lo);
  if (hi === lo) { hi += 1; lo -= 1; }
  const span = hi - lo; lo -= span * 0.08; hi += span * 0.08;
  const n = Math.max(...series.map(s => s.values.length));
  const X = i => pad.l + (n <= 1 ? (w - pad.l - pad.r) / 2 : (i / (n - 1)) * (w - pad.l - pad.r));
  const Y = v => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
  // grid
  ctx.strokeStyle = GRID; ctx.lineWidth = 1; ctx.fillStyle = MUTED; ctx.font = '10px Inter, system-ui';
  for (let g = 0; g <= 3; g++) {
    const v = lo + (g / 3) * (hi - lo), y = Y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(yFmt(v), 4, y + 3);
  }
  if (xLabels) {
    const every = Math.ceil(xLabels.length / 6);
    xLabels.forEach((l, i) => { if (i % every === 0) ctx.fillText(l, X(i) - 10, h - 8); });
  }
  if (Number.isFinite(markerX)) {
    ctx.strokeStyle = INK2; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(X(markerX), pad.t); ctx.lineTo(X(markerX), h - pad.b); ctx.stroke(); ctx.setLineDash([]);
  }
  for (const s of series) {
    ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.beginPath();
    let started = false;
    s.values.forEach((v, i) => {
      if (!Number.isFinite(v)) { started = false; return; }
      started ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v));
      started = true;
    });
    ctx.stroke();
    if (s.markers) {
      s.values.forEach((v, i) => {
        if (!Number.isFinite(v)) return;
        ctx.fillStyle = s.color; ctx.strokeStyle = SURF; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(X(i), Y(v), 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      });
    }
  }
  canvas.onmousemove = e => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < n; i++) { const d = Math.abs(X(i) - mx); if (d < bd) { bd = d; bi = i; } }
    const rows = series.map(s => `<div><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${s.color};margin-right:4px"></i>${s.label}: <b>${Number.isFinite(s.values[bi]) ? yFmt(s.values[bi]) : '–'}</b></div>`).join('');
    tip.innerHTML = `<div class="muted">${xLabels ? xLabels[bi] : bi}</div>${rows}`;
    tip.style.display = 'block';
    tip.style.left = Math.min(rect.width - 150, X(bi) + 10) + 'px';
    tip.style.top = '8px';
  };
  canvas.onmouseleave = () => { tip.style.display = 'none'; };
}
