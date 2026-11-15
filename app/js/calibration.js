// Player & ball calibration steps of "New analysis".
import { $, clamp, esc, fmtTime, seekVideo, toast } from './util.js';
import { applyH, sideOf, COURT, imageToCourt, UNLIMITED, outside, inArea } from './court.js';
import { L } from './pose.js';
import { FrameDetector } from './detector.js';
import { colorDist, finishDetection, skeletonBox, boxIoU, torsoColor, COLOR_WEIGHT } from './tracking.js';

/**
 * Standing stick figure in box coordinates (0..1), MediaPipe's 33 landmarks, facing the camera
 * (the person's left side is on the image right). Used when no skeleton can be fitted in a drawn box.
 */
const TEMPLATE = [
  [0.5, 0.07], [0.52, 0.055], [0.535, 0.05], [0.55, 0.05], [0.48, 0.055], [0.465, 0.05], [0.45, 0.05], [0.57, 0.06], [0.43, 0.06],
  [0.52, 0.09], [0.48, 0.09], [0.68, 0.2], [0.32, 0.2], [0.76, 0.36], [0.24, 0.36], [0.8, 0.5], [0.2, 0.5],
  [0.81, 0.54], [0.19, 0.54], [0.8, 0.55], [0.2, 0.55], [0.78, 0.53], [0.22, 0.53], [0.6, 0.52], [0.4, 0.52],
  [0.62, 0.74], [0.38, 0.74], [0.63, 0.94], [0.37, 0.94], [0.62, 0.97], [0.38, 0.97], [0.66, 0.995], [0.34, 0.995],
];
// joints you can drag (the face and fingers follow the head / wrists)
const HANDLES = [L.nose, L.ls, L.rs, L.le, L.re, L.lw, L.rw, L.lh, L.rh, L.lk, L.rk, L.la, L.ra];
const FOLLOWERS = { [L.nose]: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [L.lw]: [17, 19, 21], [L.rw]: [18, 20, 22], [L.la]: [29, 31], [L.ra]: [30, 32] };
import { BallDetector, sampleBallColor, ballConfigFromSamples } from './ball.js';
import { drawSkeleton, drawCourtOverlay, drawLabel, playerColor, BALL_COLOR } from './render.js';
import { toGrid, fromGrid, isEmpty, poseMasked, drawMask, attachPainter } from './mask.js';

/**
 * Play / pause / speed controls for a calibration canvas that mirrors the hidden video element.
 * While playing, render() is called every animation frame; onPause() runs when playback stops.
 */
export function attachPlayback(video, { playBtn, speedSel, scrub, render, onPause }) {
  let raf = 0;
  const loop = () => {
    if (video.paused || video.ended) { stop(); return; }
    scrub.value = video.currentTime;
    render();
    raf = requestAnimationFrame(loop);
  };
  const stop = () => {
    cancelAnimationFrame(raf); raf = 0;
    playBtn.textContent = '▶';
    scrub.value = video.currentTime;
    render();
    onPause?.();
  };
  playBtn.addEventListener('click', async () => {
    if (video.paused) {
      video.playbackRate = +speedSel.value || 1;
      try { await video.play(); } catch { return; }
      playBtn.textContent = '⏸';
      raf = requestAnimationFrame(loop);
    } else video.pause();
  });
  video.addEventListener('pause', () => { if (raf) stop(); });
  speedSel.addEventListener('change', () => { video.playbackRate = +speedSel.value || 1; });
  return { isPlaying: () => !video.paused, pause: () => video.pause() };
}

const rgbCss = c => (c ? `rgb(${c.map(Math.round).join(',')})` : 'transparent');
const hsv2rgb = (h, s, v) => {
  const f = n => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5) * 255, f(3) * 255, f(1) * 255];
};

export function setupCalibration({ video, getDraft, setStep, onReady }) {
  // ================================================================ players
  const pc = { dets: [], assign: [], hands: [], active: 0, detector: null, busy: false, t: 0, scale: 1, tool: 'draw', mask: null, hover: null, drag: null, dragged: false };
  const HANDS = { L: L.lw, R: L.rw };
  const wristPos = (det, side) => [det.lm[HANDS[side] * 3], det.lm[HANDS[side] * 3 + 1], det.lm[HANDS[side] * 3 + 2]];
  const plCanvas = $('#plCanvas');

  function drawFrame(canvas) {
    const scale = Math.min(1, 1280 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return { ctx, w: canvas.width, h: canvas.height };
  }

  const bbox = d => d.box || skeletonBox(d.lm) || { x0: 0, x1: 0, y0: 0, y1: 0 };

  const teamSide = team => (team === 'A' ? 'near' : 'far');

  /** Greedy matching of detections to player slots: the player's previous skeleton (position, overlap) + a little colour, else left/right order. */
  function autoAssign(dets) {
    const players = getDraft().players;
    const prev = pc.assign;
    const colorW = COLOR_WEIGHT[$('#plTrackBy').value] ?? COLOR_WEIGHT.skeleton;
    const teamIdx = players.map((p, k) => players.slice(0, k).filter(q => q.team === p.team).length);
    const teamSize = t => players.filter(p => p.team === t).length;
    const pairs = [];
    players.forEach((p, si) => {
      const pa = prev[si];
      dets.forEach((d, di) => {
        if (d.masked || sideOf(d.cy) !== teamSide(p.team)) return;
        let c;
        if (pa) {
          const cd = colorDist(pa.color, d.color);
          const iou = pa.lm ? boxIoU(bbox(pa), d.box) : 0;
          c = (cd === null ? colorW * 0.25 : colorW * cd) + 0.6 * Math.hypot(d.cx - pa.cx, d.cy - pa.cy) + 5 * (1 - iou);
        } else {
          const expX = teamSize(p.team) === 1 ? 10 : teamIdx[si] === 0 ? 5 : 15;
          c = Math.abs(d.cx - expX) + 0.2 * Math.abs(Math.abs(d.cy - COURT.NET) - 15);
        }
        pairs.push({ si, di, c });
      });
    });
    pairs.sort((a, b) => a.c - b.c);
    const out = players.map(() => null), usedD = new Set();
    for (const p of pairs) {
      if (out[p.si] || usedD.has(p.di)) continue;
      out[p.si] = dets[p.di]; usedD.add(p.di);
    }
    // keep hand-placed / drawn skeletons the detector could not replace
    players.forEach((_, si) => { if (!out[si] && (prev[si]?.manual || prev[si]?.drawn)) out[si] = prev[si]; });
    return out;
  }

  async function ensureDetector() {
    const d = getDraft();
    if (pc.detector && pc.detCal !== d.cal) { pc.detector.close(); pc.detector = null; } // court was re-calibrated
    if (!pc.detector) {
      $('#plHint').textContent = 'Loading pose model…';
      pc.detector = await FrameDetector.create({ crops: d.cfg.crops, nPlayers: d.players.length, cal: d.cal, vw: video.videoWidth, vh: video.videoHeight, mode: 'IMAGE', area: UNLIMITED, thorough: true, model: d.cfg.model === 'lite' ? 'full' : d.cfg.model });
      pc.detCal = d.cal;
    }
    return pc.detector;
  }

  /** Refresh court position, box and shirt colour after a skeleton was drawn or a joint moved. */
  function refreshDrawn(det) {
    const d = getDraft();
    const fresh = finishDetection(det.lm, d.cal);
    det.cx = fresh.cx; det.cy = fresh.cy; det.box = fresh.box; det.conf = Math.max(det.conf || 0, fresh.conf);
    det.masked = poseMasked(pc.mask, det.lm);
    try {
      const c = document.createElement('canvas');
      c.width = 640; c.height = Math.round(640 * video.videoHeight / video.videoWidth);
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(video, 0, 0, c.width, c.height);
      det.color = torsoColor(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height, det.lm) || det.color || null;
    } catch { /* tainted canvas: keep the previous colour */ }
  }

  /** The coach drew a box around the selected player: fit their skeleton inside it (or place a stick figure). */
  async function fitInBox(box) {
    const d = getDraft();
    const si = pc.active;
    const p = d.players[si];
    let det = null;
    try {
      const fd = await ensureDetector();
      det = fd.detectBox(video, box, { pad: 0.25 });
    } catch (e) { console.error(e); }
    let fitted = true;
    if (!det) {
      fitted = false;
      const lm = new Float32Array(33 * 3);
      TEMPLATE.forEach(([u, v], i) => { lm[i * 3] = box.x0 + u * (box.x1 - box.x0); lm[i * 3 + 1] = box.y0 + v * (box.y1 - box.y0); lm[i * 3 + 2] = 0.9; });
      det = { lm, conf: 0.9 };
    }
    det.drawn = true;
    refreshDrawn(det);
    if (!Number.isFinite(det.cy)) {
      toast('The bottom of that box is above the horizon — draw it down to the player’s feet.', 5000);
      return;
    }
    det.t = video.currentTime;
    pc.assign = pc.assign.map((a, k) => (k !== si && a && boxIoU(bbox(a), det.box) > 0.6 ? null : a));
    pc.assign[si] = det;
    pc.t = video.currentTime;
    toast(fitted ? `${p.label}: skeleton fitted. Drag any joint to correct it.` : `${p.label}: no skeleton found in the box — a stick figure was placed. Drag its joints (at least the feet) onto the player.`, fitted ? 2600 : 6000);
    if (sideOf(det.cy) !== teamSide(p.team)) toast(`Note: ${p.label} plays on the ${teamSide(p.team)} side but is on the ${sideOf(det.cy)} side in this frame.`, 5000);
    const next = pc.assign.findIndex(a => !a);
    pc.active = next >= 0 ? next : si;
    renderPlayers();
  }

  // ---- draw tool: drag a box around a player, or drag a joint of an identified skeleton
  const canvasPos = e => { const r = plCanvas.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, r]; };
  function jointAt(x, y, r) {
    let best = null, bd = 11;
    const order = [pc.active, ...pc.assign.map((_, k) => k).filter(k => k !== pc.active)];
    for (const k of order) {
      const a = pc.assign[k];
      if (!a?.lm) continue;
      for (const j of HANDLES) {
        if (a.lm[j * 3 + 2] < 0.2) continue;
        const dd = Math.hypot((x - a.lm[j * 3]) * r.width, (y - a.lm[j * 3 + 1]) * r.height);
        if (dd < bd) { bd = dd; best = { k, j }; }
      }
      if (best && k === pc.active) break; // the selected player's joints win
    }
    return best;
  }
  plCanvas.addEventListener('pointerdown', e => {
    if (pc.tool !== 'draw' || e.button !== 0) return;
    pc.dragged = false;
    if (!video.paused) { video.pause(); toast('Paused — now draw around a player.'); pc.dragged = true; return; }
    const [x, y, r] = canvasPos(e);
    const hit = jointAt(x, y, r);
    pc.drag = hit ? { kind: 'joint', ...hit, x0: x, y0: y } : { kind: 'box', x0: x, y0: y, x1: x, y1: y };
    if (hit) pc.active = hit.k;
    plCanvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  plCanvas.addEventListener('pointermove', e => {
    if (pc.tool !== 'draw') return;
    const [x, y, r] = canvasPos(e);
    if (!pc.drag) { plCanvas.style.cursor = jointAt(x, y, r) ? 'grab' : 'crosshair'; return; }
    if (Math.hypot((x - pc.drag.x0) * r.width, (y - pc.drag.y0) * r.height) > 4) pc.dragged = true;
    if (pc.drag.kind === 'joint') {
      const a = pc.assign[pc.drag.k], j = pc.drag.j;
      const dx = x - a.lm[j * 3], dy = y - a.lm[j * 3 + 1];
      for (const f of [j, ...(FOLLOWERS[j] || [])]) { a.lm[f * 3] += dx; a.lm[f * 3 + 1] += dy; a.lm[f * 3 + 2] = Math.max(a.lm[f * 3 + 2], 0.9); }
      a.drawn = true;
      plCanvas.style.cursor = 'grabbing';
    } else { pc.drag.x1 = x; pc.drag.y1 = y; }
    requestAnimationFrame(renderPlayers);
  });
  plCanvas.addEventListener('pointerup', e => {
    if (pc.tool !== 'draw' || !pc.drag) return;
    const g = pc.drag; pc.drag = null;
    const r = plCanvas.getBoundingClientRect();
    if (g.kind === 'joint') {
      const a = pc.assign[g.k];
      refreshDrawn(a); a.t = video.currentTime; pc.t = video.currentTime;
      plCanvas.style.cursor = 'grab';
      renderPlayers();
      return;
    }
    const box = { x0: Math.min(g.x0, g.x1), x1: Math.max(g.x0, g.x1), y0: Math.min(g.y0, g.y1), y1: Math.max(g.y0, g.y1) };
    if ((box.x1 - box.x0) * r.width < 8 || (box.y1 - box.y0) * r.height < 14) { renderPlayers(); return; } // a click, handled below
    fitInBox(box);
  });

  async function detectPlayers() {
    if (pc.busy || !video.paused) return;
    pc.busy = true;
    const d = getDraft();
    try {
      pc.dets = (await ensureDetector()).detect(video);
      pc.dets.forEach(det => { det.t = video.currentTime; });
      pc.dets.forEach(det => { det.masked = poseMasked(pc.mask, det.lm); });
      pc.t = video.currentTime;
      pc.assign = autoAssign(pc.dets);
      const found = pc.assign.filter(Boolean).length;
      $('#plHint').innerHTML = `Detected <b>${pc.dets.length}</b> people (on or around the court); <b>${found}/${d.players.length}</b> players matched. Check each name sits on the right person. If not, select the player on the right and <b>draw a box around them</b> (✏️) — or drag a joint to fix their skeleton. Then click a player’s <b>L</b>/<b>R</b> hand marker to set their paddle hand (or leave it on Auto).`;
      pc.active = Math.max(0, pc.assign.findIndex(a => !a));
    } catch (e) {
      console.error(e);
      $('#plHint').textContent = `Pose detection failed: ${e.message}. Check your internet connection (model loads from a CDN).`;
    }
    pc.busy = false;
    renderPlayers();
  }

  function renderPlayers() {
    const d = getDraft();
    const { ctx, w, h } = drawFrame(plCanvas);
    drawCourtOverlay(ctx, d.cal, w, h);
    drawMask(ctx, pc.mask, w, h);
    if (pc.hover && pc.tool !== 'select') {
      ctx.strokeStyle = pc.tool === 'erase' ? '#e34948' : '#f0efec'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(pc.hover[0] * w, pc.hover[1] * h, (+$('#plBrush').value / 100) * w, 0, Math.PI * 2); ctx.stroke();
    }
    $('#plTime').textContent = fmtTime(video.currentTime);
    const nErased = pc.dets.filter(x => x.masked).length;
    $('#plEraseInfo').textContent = isEmpty(pc.mask) ? '' : `${nErased} ${nErased === 1 ? 'person' : 'people'} in erased areas will be ignored.`;
    if (!video.paused) return; // skeletons belong to the paused frame — redetected on pause
    const assignedDets = new Set(pc.assign.filter(a => a && !a.manual));
    for (const det of pc.dets) {
      if (assignedDets.has(det)) continue;
      if (det.masked) {
        drawSkeleton(ctx, det.lm, w, h, 'rgba(227,73,72,0.45)', 1.5);
        const b = bbox(det);
        ctx.strokeStyle = 'rgba(227,73,72,0.9)'; ctx.lineWidth = 2;
        const cx = ((b.x0 + b.x1) / 2) * w, cy = b.y0 * h - 8;
        ctx.beginPath(); ctx.moveTo(cx - 5, cy - 5); ctx.lineTo(cx + 5, cy + 5); ctx.moveTo(cx + 5, cy - 5); ctx.lineTo(cx - 5, cy + 5); ctx.stroke();
      } else drawSkeleton(ctx, det.lm, w, h, 'rgba(200,200,190,0.6)', 2);
    }
    pc.assign.forEach((a, si) => {
      if (!a) return;
      const color = playerColor(d.players, si);
      const label = d.players[si].label;
      if (a.manual) {
        const [u, v] = applyH(d.cal.toImg, a.cx, a.cy);
        ctx.strokeStyle = color; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(u * w, v * h, 10, 0, Math.PI * 2); ctx.stroke();
        drawLabel(ctx, `${label} (manual)`, u * w, v * h - 14, color);
      } else {
        drawSkeleton(ctx, a.lm, w, h, color, si === pc.active ? 4 : 3);
        const b = bbox(a);
        drawLabel(ctx, label, ((b.x0 + b.x1) / 2) * w, b.y0 * h - 6, color);
        // hands: L / R markers, paddle hand highlighted (click a hand to set it)
        for (const side of ['L', 'R']) {
          const [hx, hy, hv] = wristPos(a, side);
          if (hv < 0.2) continue;
          const paddle = pc.hands[si] === side;
          ctx.fillStyle = paddle ? '#eedd33' : 'rgba(17,18,20,0.85)';
          ctx.strokeStyle = color; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(hx * w, hy * h, paddle ? 10 : 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.fillStyle = paddle ? '#111214' : '#f0efec';
          ctx.font = '700 10px Inter, system-ui, sans-serif'; ctx.textAlign = 'center';
          ctx.fillText(side, hx * w, hy * h + 3.5); ctx.textAlign = 'left';
        }
      }
    });
    // draw tool: box being drawn, draggable joints of the selected player
    if (pc.drag?.kind === 'box') {
      const g = pc.drag;
      ctx.setLineDash([6, 4]); ctx.strokeStyle = playerColor(d.players, pc.active); ctx.lineWidth = 2;
      ctx.strokeRect(Math.min(g.x0, g.x1) * w, Math.min(g.y0, g.y1) * h, Math.abs(g.x1 - g.x0) * w, Math.abs(g.y1 - g.y0) * h);
      ctx.setLineDash([]);
    }
    const act = pc.assign[pc.active];
    if (pc.tool === 'draw' && act?.lm) {
      for (const j of HANDLES) {
        if (act.lm[j * 3 + 2] < 0.2 || j === L.lw || j === L.rw) continue; // wrists have their L/R markers
        ctx.fillStyle = '#f0efec'; ctx.strokeStyle = playerColor(d.players, pc.active); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(act.lm[j * 3] * w, act.lm[j * 3 + 1] * h, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
    $('#plSlots').innerHTML = d.players.map((p, si) => {
      const a = pc.assign[si];
      const status = !a ? '<span style="color:var(--sev-high)">not identified</span>'
        : a.manual ? (a.color ? `placed by hand · shirt <span class="swatch" style="background:${rgbCss(a.color)}"></span>` : 'placed by hand (no shirt colour)')
        : `${a.drawn ? '✏️ drawn · ' : 'skeleton · '}${fmtFeet(a.cy, a.cx)}${Math.abs((a.t ?? pc.t) - video.currentTime) > 0.05 ? ` · <span style="color:var(--sev-med)">from ${fmtTime(a.t ?? pc.t)} — redraw here</span>` : ''}`;
      return `<div class="slot ${si === pc.active ? 'active' : ''}" data-si="${si}">
        <i style="background:${playerColor(d.players, si)}"></i>
        <input data-label="${si}" value="${esc(p.label)}" aria-label="Player name">
        <span class="chip">${p.team === 'A' ? 'near' : 'far'}</span>
        <div class="meta">${status}${a ? ` <a href="#" data-clear="${si}">clear</a>` : ''}</div>
        <div class="meta hand-pick">Paddle hand:
          ${[['auto', 'Auto'], ['L', 'Left'], ['R', 'Right']].map(([v, t]) => `<button type="button" class="${(pc.hands[si] || 'auto') === v ? 'on' : ''}" data-hand="${v}" data-si="${si}">${t}</button>`).join('')}
        </div>
      </div>`;
    }).join('');
    $('#plTime').textContent = fmtTime(video.currentTime);
  }
  const fmtFeet = (cy, cx) => {
    const [os, ob] = outside(cx, cy);
    if (ob > 0.5) return `${ob.toFixed(0)} ft behind the baseline`;
    if (os > 0.5) return `${os.toFixed(0)} ft outside the sideline`;
    return `${Math.max(0, Math.abs(cy - COURT.NET) - COURT.NVZ).toFixed(0)} ft behind NVZ`;
  };

  $('#plSlots').addEventListener('click', e => {
    const hb = e.target.closest('[data-hand]');
    if (hb) { const si = +hb.dataset.si; pc.hands[si] = hb.dataset.hand === 'auto' ? null : hb.dataset.hand; pc.active = si; renderPlayers(); return; }
    const clr = e.target.closest('[data-clear]');
    if (clr) { e.preventDefault(); pc.assign[+clr.dataset.clear] = null; pc.active = +clr.dataset.clear; renderPlayers(); return; }
    const s = e.target.closest('.slot');
    if (s && !e.target.matches('input')) { pc.active = +s.dataset.si; renderPlayers(); }
  });
  $('#plSlots').addEventListener('focusin', e => {
    const s = e.target.closest('.slot');
    if (s && pc.active !== +s.dataset.si) { pc.active = +s.dataset.si; $$slots(); }
  });
  const $$slots = () => document.querySelectorAll('#plSlots .slot').forEach(el => el.classList.toggle('active', +el.dataset.si === pc.active));
  $('#plSlots').addEventListener('input', e => {
    const k = e.target.dataset.label;
    if (k !== undefined) { getDraft().players[+k].label = e.target.value || `Player ${+k + 1}`; }
  });

  plCanvas.addEventListener('click', e => {
    if (pc.tool === 'erase' || pc.tool === 'restore' || (pc.tool === 'draw' && pc.dragged)) return; // eraser strokes, box drawing and joint drags handle themselves
    if (!video.paused) { video.pause(); toast('Paused — now click a player.'); return; }
    const d = getDraft();
    const r = plCanvas.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    // clicking a hand of an identified player marks it as that player's paddle hand
    for (let k = 0; k < pc.assign.length; k++) {
      const a = pc.assign[k];
      if (!a || a.manual) continue;
      for (const side of ['L', 'R']) {
        const [hx, hy, hv] = wristPos(a, side);
        if (hv < 0.2) continue;
        if (Math.hypot((x - hx) * r.width, (y - hy) * r.height) <= 12) {
          pc.hands[k] = side; pc.active = k;
          toast(`${d.players[k].label}: paddle in the ${side === 'L' ? 'left' : 'right'} hand.`);
          renderPlayers();
          return;
        }
      }
    }
    const si = pc.active;
    const p = d.players[si];
    // hit-test detected skeletons
    let hit = null, best = Infinity;
    for (const det of pc.dets) {
      if (det.masked) continue; // erased (spectator)
      const b = bbox(det);
      const padX = 0.01, padY = 0.01;
      if (x < b.x0 - padX || x > b.x1 + padX || y < b.y0 - padY || y > b.y1 + padY) continue;
      const dist = Math.hypot(x - (b.x0 + b.x1) / 2, y - (b.y0 + b.y1) / 2);
      if (dist < best) { best = dist; hit = det; }
    }
    let entry;
    if (hit) entry = hit;
    else {
      // manual placement: any point on the ground plane is fine, even well outside the lines
      const p = imageToCourt(d.cal, x, y);
      if (!p || !inArea(p[0], p[1], { side: 60, back: 80 })) {
        toast('Click on the player’s feet (on the ground). That point is above the horizon or too far away to map onto the court.', 5000);
        return;
      }
      entry = { manual: true, cx: p[0], cy: p[1], color: manualShirtColor(x, y, p) };
    }
    if (sideOf(entry.cy) !== teamSide(p.team)) {
      // allowed: players move around (walking back, collecting balls); just let the user know
      toast(`Note: ${p.label} plays on the ${teamSide(p.team)} side but is on the ${sideOf(entry.cy)} side in this frame. That's fine if they're just moving around — if the teams are swapped, change “Your team” in step 1.`, 6000);
    }
    pc.assign = pc.assign.map((a, k) => (k !== si && a === entry ? null : a));
    pc.assign[si] = entry;
    const next = pc.assign.findIndex(a => !a);
    pc.active = next >= 0 ? next : si;
    renderPlayers();
  });

  /**
   * Shirt colour for a player placed by clicking their feet (no skeleton): estimate their height in the
   * image from the court scale at that spot, then average the pixels where the torso should be.
   */
  function manualShirtColor(x, y, court) {
    const d = getDraft();
    const [ax, ay] = applyH(d.cal.toImg, court[0] - 1, court[1]);
    const [bx, by] = applyH(d.cal.toImg, court[0] + 1, court[1]);
    const pxPerFt = Math.hypot((bx - ax) * video.videoWidth, (by - ay) * video.videoHeight) / 2;
    const H = pxPerFt * 5.6;                      // typical standing height in px
    if (!(H > 8)) return null;
    const cx = x * video.videoWidth, fy = y * video.videoHeight;
    const x0 = Math.round(cx - H * 0.1), w = Math.max(2, Math.round(H * 0.2));
    const y0 = Math.round(fy - H * 0.75), h = Math.max(2, Math.round(H * 0.2));
    if (x0 < 0 || y0 < 0 || x0 + w > video.videoWidth || y0 + h > video.videoHeight) return null;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(video, x0, y0, w, h, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data;
    let r = 0, gg = 0, b = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) { r += px[i]; gg += px[i + 1]; b += px[i + 2]; n++; }
    return n ? [Math.round(r / n), Math.round(gg / n), Math.round(b / n)] : null;
  }

  let scrubTimer = null;
  $('#plScrub').addEventListener('input', async e => {
    await seekVideo(video, +e.target.value);
    renderPlayers();
    clearTimeout(scrubTimer);
    scrubTimer = setTimeout(detectPlayers, 350);
  });
  $('#plDetect').addEventListener('click', detectPlayers);
  $('#plBack').addEventListener('click', () => { video.pause(); setStep(2); });

  // --- play the video during player calibration (skeletons are re-detected when paused)
  attachPlayback(video, {
    playBtn: $('#plPlay'), speedSel: $('#plSpeed'), scrub: $('#plScrub'),
    render: () => { if ($('[data-pane="3"]').classList.contains('active')) renderPlayers(); },
    onPause: () => { if ($('[data-pane="3"]').classList.contains('active')) { clearTimeout(scrubTimer); scrubTimer = setTimeout(detectPlayers, 200); } },
  });

  // --- eraser: paint over spectators / benches / other courts so they are never detected
  const plPainter = attachPainter(plCanvas, {
    getGrid: () => pc.mask,
    getBrush: () => +$('#plBrush').value / 100,
    isRestore: () => pc.tool === 'restore',
    aspect: () => video.videoWidth / video.videoHeight,
    onHover: p => { pc.hover = p; requestAnimationFrame(renderPlayers); },
    onChange: () => {
      pc.dets.forEach(det => { det.masked = poseMasked(pc.mask, det.lm); });
      // a player standing in a freshly erased area is unassigned
      pc.assign = pc.assign.map(a => (a && !a.manual && a.masked ? null : a));
      requestAnimationFrame(renderPlayers);
    },
  });
  document.querySelectorAll('[data-pltool]').forEach(b => b.addEventListener('click', () => {
    pc.tool = b.dataset.pltool;
    document.querySelectorAll('[data-pltool]').forEach(x => x.classList.toggle('on', x === b));
    const painting = pc.tool === 'erase' || pc.tool === 'restore';
    plPainter.setMode(painting);
    if (painting) video.pause();
    plCanvas.style.cursor = pc.tool === 'draw' ? 'crosshair' : painting ? 'cell' : '';
    renderPlayers();
  }));
  $('#plEraseClear').addEventListener('click', () => {
    pc.mask.g.fill(0);
    pc.dets.forEach(det => { det.masked = false; });
    renderPlayers();
  });

  $('#plConfirm').addEventListener('click', () => {
    const d = getDraft();
    const missing = d.players.filter((_, si) => !pc.assign[si]).map(p => p.label);
    if (missing.length && !confirm(`${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not identified. Continue and let the tracker find ${missing.length > 1 ? 'them' : 'this player'} automatically?`)) return;
    d.players.forEach((p, si) => {
      const a = pc.assign[si];
      const box = a?.lm ? bbox(a) : null;
      p.seed = a ? { cx: +a.cx.toFixed(2), cy: +a.cy.toFixed(2), t: +(a.t ?? pc.t).toFixed(2), box: box ? { x0: +box.x0.toFixed(4), y0: +box.y0.toFixed(4), x1: +box.x1.toFixed(4), y1: +box.y1.toFixed(4) } : null } : null;
      p.color = a?.color || null;
    });
    d.players.forEach((p, si) => { p.hand = pc.hands[si] || null; }); // null = detect from swings
    d.cfg.playArea = UNLIMITED; // players are followed wherever they move
    d.cfg.trackBy = $('#plTrackBy').value;
    d.cfg.ignore = isEmpty(pc.mask) ? null : fromGrid(pc.mask); // eraser zones
    video.pause();
    if (d.cfg.ball) startBall(); else onReady();
  });

  async function startPlayers() {
    video.pause();
    const d = getDraft();
    pc.assign = d.players.map(() => null);
    pc.hands = d.players.map(p => p.hand || null);
    pc.mask = toGrid(d.cfg.ignore);
    pc.dets = [];
    $('#plTrackBy').value = d.cfg.trackBy || 'skeleton';
    plCanvas.style.cursor = pc.tool === 'draw' ? 'crosshair' : '';
    const s = $('#plScrub');
    s.max = video.duration;
    s.value = clamp((d.cfg.rangeStart || 0) + 1, 0, video.duration);
    await seekVideo(video, +s.value);
    setStep(3);
    renderPlayers();
    detectPlayers();
  }

  // ================================================================ ball
  const bc = { samples: [], hover: null, test: null, full: null, fullT: -1 };
  const ballCanvas = $('#ballCanvas');
  const sizeEl = $('#ballSize');

  function fullFrame() {
    if (bc.full && bc.fullT === video.currentTime) return bc.full;
    const c = bc.full || document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0);
    bc.full = c; bc.fullT = video.currentTime;
    return c;
  }

  function renderBall() {
    const { ctx, w, h } = drawFrame(ballCanvas);
    const dSrc = +sizeEl.value;
    const rDisp = (dSrc / 2) * (w / video.videoWidth);
    // samples on this frame
    for (const s of bc.samples) {
      if (Math.abs(s.t - video.currentTime) > 0.02) continue;
      ctx.strokeStyle = BALL_COLOR; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(s.x * w, s.y * h, Math.max(4, rDisp + 3), 0, Math.PI * 2); ctx.stroke();
    }
    // test result
    if (bc.test && Math.abs(bc.test.t - video.currentTime) < 0.02) {
      ctx.lineWidth = 1.5;
      for (const b of bc.test.blobs) {
        ctx.strokeStyle = 'rgba(200,200,190,0.8)';
        ctx.beginPath(); ctx.arc(b.x * w, b.y * h, Math.max(5, rDisp + 5), 0, Math.PI * 2); ctx.stroke();
      }
      if (bc.test.pick) {
        ctx.strokeStyle = '#199e70'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(bc.test.pick[0] * w, bc.test.pick[1] * h, Math.max(7, rDisp + 7), 0, Math.PI * 2); ctx.stroke();
      }
    }
    // hover ring
    if (bc.hover) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(bc.hover[0] * w, bc.hover[1] * h, Math.max(2, rDisp), 0, Math.PI * 2); ctx.stroke();
    }
    drawZoom();
    $('#ballTime').textContent = `${fmtTime(video.currentTime)}.${String(Math.floor((video.currentTime % 1) * 100)).padStart(2, '0')}`;
    $('#ballSizeVal').textContent = `${sizeEl.value} px`;
    $('#ballSamples').innerHTML = bc.samples.length ? bc.samples.map((s, i) => `
      <div class="sample"><span class="swatch" style="background:${rgbCss(hsv2rgb(s.h, s.s, s.v))}"></span>
        Sample ${i + 1} · ${fmtTime(s.t)} · hue ${s.h.toFixed(0)}°
        <button class="btn small ghost" data-goto-sample="${i}">view</button><button class="btn small ghost" data-del-sample="${i}">✕</button></div>`).join('')
      : '<p class="muted small">No samples yet — click the ball.</p>';
    $('#ballConfirm').disabled = !bc.samples.length;
  }

  function drawZoom() {
    const z = $('#ballZoom'), zc = z.getContext('2d');
    zc.imageSmoothingEnabled = false;
    zc.fillStyle = '#000'; zc.fillRect(0, 0, z.width, z.height);
    if (!bc.hover) return;
    const src = fullFrame();
    const span = Math.max(24, +sizeEl.value * 4);
    const cx = bc.hover[0] * video.videoWidth, cy = bc.hover[1] * video.videoHeight;
    zc.drawImage(src, cx - span / 2, cy - span / 2, span, span, 0, 0, z.width, z.height);
    const r = (+sizeEl.value / 2) * (z.width / span);
    zc.strokeStyle = '#fff'; zc.lineWidth = 1.5;
    zc.beginPath(); zc.arc(z.width / 2, z.height / 2, r, 0, Math.PI * 2); zc.stroke();
  }

  const ballPos = e => { const r = ballCanvas.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
  ballCanvas.addEventListener('mousemove', e => { bc.hover = ballPos(e); renderBall(); });
  ballCanvas.addEventListener('mouseleave', () => { bc.hover = null; renderBall(); });
  ballCanvas.addEventListener('click', e => {
    if (!video.paused) { video.pause(); toast('Paused — now click the ball.'); return; }
    const [x, y] = ballPos(e);
    const d = +sizeEl.value;
    const size = Math.max(5, Math.round(d + 4));
    const sx = Math.round(x * video.videoWidth - size / 2), sy = Math.round(y * video.videoHeight - size / 2);
    const patch = fullFrame().getContext('2d', { willReadFrequently: true }).getImageData(sx, sy, size, size).data;
    const col = sampleBallColor(patch, size, d / 2);
    if (!col) { toast('Could not read the colour there.'); return; }
    if (col.s < 0.15) toast('That spot looks grey/white — make sure you clicked on the ball itself.', 4000);
    bc.samples.push({ ...col, d, t: video.currentTime, x, y });
    bc.test = null;
    renderBall();
  });
  $('#ballSamples').addEventListener('click', async e => {
    const del = e.target.closest('[data-del-sample]'), go = e.target.closest('[data-goto-sample]');
    if (del) { bc.samples.splice(+del.dataset.delSample, 1); renderBall(); }
    if (go) { const s = bc.samples[+go.dataset.gotoSample]; $('#ballScrub').value = s.t; await seekVideo(video, s.t); renderBall(); }
  });
  sizeEl.addEventListener('input', renderBall);
  $('#ballScrub').addEventListener('input', async e => { await seekVideo(video, +e.target.value); renderBall(); });
  const stepFrame = async dir => {
    const t = clamp(video.currentTime + dir / 30, 0, video.duration);
    $('#ballScrub').value = t;
    await seekVideo(video, t); renderBall();
  };
  $('#ballPrev').addEventListener('click', () => stepFrame(-1));
  $('#ballNext').addEventListener('click', () => stepFrame(1));

  $('#ballTest').addEventListener('click', async () => {
    const d = getDraft();
    const cfgBall = ballConfigFromSamples(bc.samples.map(s => ({ ...s, d: +sizeEl.value })));
    if (!cfgBall) { toast('Add at least one ball sample first.'); return; }
    const t = video.currentTime;
    const det = new BallDetector(video.videoWidth, video.videoHeight, d.cal, cfgBall);
    await seekVideo(video, Math.max(0, t - 1 / d.cfg.fps));
    det.detect(video, t - 1 / d.cfg.fps);
    await seekVideo(video, t);
    const res = det.detect(video, t, true);
    bc.test = { t, ...res };
    $('#ballTestResult').innerHTML = res.pick
      ? `<span style="color:#0ca30c">✓ Ball found</span> (green ring)${res.blobs.length > 1 ? ` · ${res.blobs.length - 1} other candidate${res.blobs.length > 2 ? 's' : ''} (grey)` : ''}.`
      : res.blobs.length ? `${res.blobs.length} candidates (grey) but none chosen — add another sample or adjust size.` : 'No ball found on this frame. The ball must be moving; try another frame, add a sample here, or adjust the size.';
    renderBall();
  });
  $('#ballBack').addEventListener('click', () => { video.pause(); setStep(3); });

  // --- play the video to find a moment where the ball is visible, then pause and click it
  attachPlayback(video, {
    playBtn: $('#ballPlay'), speedSel: $('#ballSpeed'), scrub: $('#ballScrub'),
    render: () => { if ($('[data-pane="4"]').classList.contains('active')) renderBall(); },
  });
  $('#ballSkip').addEventListener('click', () => { getDraft().cfg.ball = false; getDraft().cfg.ballCal = null; onReady(); });
  $('#ballConfirm').addEventListener('click', () => {
    const d = getDraft();
    d.cfg.ballCal = ballConfigFromSamples(bc.samples.map(s => ({ ...s, d: +sizeEl.value })));
    onReady();
  });

  async function startBall() {
    video.pause();
    const d = getDraft();
    bc.samples = []; bc.test = null; bc.full = null;
    // default ball size: ~2.9 in ball at the far kitchen line, from the court scale in the image
    const [ax] = applyH(d.cal.toImg, 0, 15), [bx] = applyH(d.cal.toImg, 20, 15);
    const pxPerFt = Math.abs(bx - ax) * video.videoWidth / 20;
    sizeEl.value = clamp(Math.round(pxPerFt * 0.24 * 1.3), 3, 48);
    const s = $('#ballScrub');
    s.max = video.duration;
    s.value = video.currentTime;
    setStep(4);
    renderBall();
  }

  return { startPlayers, startBall, dispose: () => { pc.detector?.close(); pc.detector = null; } };
}
