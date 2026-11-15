// Player & ball calibration steps of "New analysis".
import { $, clamp, esc, fmtTime, seekVideo, toast } from './util.js';
import { applyH, sideOf, COURT, imageToCourt, UNLIMITED, outside, inArea } from './court.js';
import { L } from './pose.js';
import { FrameDetector } from './detector.js';
import { colorDist } from './tracking.js';
import { BallDetector, sampleBallColor, ballConfigFromSamples } from './ball.js';
import { drawSkeleton, drawCourtOverlay, drawLabel, playerColor, BALL_COLOR } from './render.js';

const rgbCss = c => (c ? `rgb(${c.map(Math.round).join(',')})` : 'transparent');
const hsv2rgb = (h, s, v) => {
  const f = n => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5) * 255, f(3) * 255, f(1) * 255];
};

export function setupCalibration({ video, getDraft, setStep, onReady }) {
  // ================================================================ players
  const pc = { dets: [], assign: [], hands: [], active: 0, detector: null, busy: false, t: 0, scale: 1 };
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

  function bbox(d) {
    let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
    for (let i = 0; i < 33; i++) {
      if (d.lm[i * 3 + 2] < 0.3) continue;
      const x = d.lm[i * 3], y = d.lm[i * 3 + 1];
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    return { x0, x1, y0, y1 };
  }

  const teamSide = team => (team === 'A' ? 'near' : 'far');

  /** Greedy matching of detections to player slots: shirt colour + position from the previous frame, else left/right order. */
  function autoAssign(dets) {
    const players = getDraft().players;
    const prev = pc.assign;
    const teamIdx = players.map((p, k) => players.slice(0, k).filter(q => q.team === p.team).length);
    const teamSize = t => players.filter(p => p.team === t).length;
    const pairs = [];
    players.forEach((p, si) => {
      const pa = prev[si];
      dets.forEach((d, di) => {
        if (sideOf(d.cy) !== teamSide(p.team)) return;
        let c;
        if (pa) {
          const cd = colorDist(pa.color, d.color);
          c = (cd === null ? 6 : 25 * cd) + 0.3 * Math.hypot(d.cx - pa.cx, d.cy - pa.cy);
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
    // keep manual placements the detector could not replace
    players.forEach((_, si) => { if (!out[si] && prev[si]?.manual) out[si] = prev[si]; });
    return out;
  }

  async function detectPlayers() {
    if (pc.busy) return;
    pc.busy = true;
    const d = getDraft();
    try {
      if (pc.detector && pc.detCal !== d.cal) { pc.detector.close(); pc.detector = null; } // court was re-calibrated
      if (!pc.detector) {
        $('#plHint').textContent = 'Loading pose model…';
        pc.detector = await FrameDetector.create({ model: d.cfg.model, crops: d.cfg.crops, nPlayers: d.players.length, cal: d.cal, vw: video.videoWidth, vh: video.videoHeight, mode: 'IMAGE', area: UNLIMITED });
        pc.detCal = d.cal;
      }
      pc.dets = pc.detector.detect(video);
      pc.t = video.currentTime;
      pc.assign = autoAssign(pc.dets);
      const found = pc.assign.filter(Boolean).length;
      $('#plHint').innerHTML = `Detected <b>${pc.dets.length}</b> people (on or around the court); <b>${found}/${d.players.length}</b> players matched. Check each name sits on the right person — select a player on the right, then click their skeleton (or their feet if no skeleton). Then click a player’s <b>L</b>/<b>R</b> hand marker to set their paddle hand (or leave it on Auto).`;
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
    const assignedDets = new Set(pc.assign.filter(a => a && !a.manual));
    for (const det of pc.dets) if (!assignedDets.has(det)) drawSkeleton(ctx, det.lm, w, h, 'rgba(200,200,190,0.6)', 2);
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
    $('#plSlots').innerHTML = d.players.map((p, si) => {
      const a = pc.assign[si];
      const status = !a ? '<span style="color:var(--sev-high)">not identified</span>'
        : a.manual ? 'manual position (no shirt colour)'
        : `shirt <span class="swatch" style="background:${rgbCss(a.color)}"></span> · ${fmtFeet(a.cy, a.cx)}`;
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
      entry = { manual: true, cx: p[0], cy: p[1], color: null };
    }
    if (sideOf(entry.cy) !== teamSide(p.team)) {
      toast(`${p.label} is on the ${teamSide(p.team)} team, but that person is on the ${sideOf(entry.cy)} side. Change “Your team” in step 1 if sides are swapped.`, 5000);
      return;
    }
    pc.assign = pc.assign.map((a, k) => (k !== si && a === entry ? null : a));
    pc.assign[si] = entry;
    const next = pc.assign.findIndex(a => !a);
    pc.active = next >= 0 ? next : si;
    renderPlayers();
  });

  let scrubTimer = null;
  $('#plScrub').addEventListener('input', async e => {
    await seekVideo(video, +e.target.value);
    renderPlayers();
    clearTimeout(scrubTimer);
    scrubTimer = setTimeout(detectPlayers, 350);
  });
  $('#plDetect').addEventListener('click', detectPlayers);
  $('#plBack').addEventListener('click', () => setStep(2));

  $('#plConfirm').addEventListener('click', () => {
    const d = getDraft();
    const missing = d.players.filter((_, si) => !pc.assign[si]).map(p => p.label);
    if (missing.length && !confirm(`${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not identified. Continue and let the tracker find ${missing.length > 1 ? 'them' : 'this player'} automatically?`)) return;
    d.players.forEach((p, si) => {
      const a = pc.assign[si];
      p.seed = a ? { cx: +a.cx.toFixed(2), cy: +a.cy.toFixed(2), t: +pc.t.toFixed(2) } : null;
      p.color = a?.color || null;
    });
    d.players.forEach((p, si) => { p.hand = pc.hands[si] || null; }); // null = detect from swings
    d.cfg.playArea = UNLIMITED; // players are followed wherever they move
    if (d.cfg.ball) startBall(); else onReady();
  });

  async function startPlayers() {
    const d = getDraft();
    pc.assign = d.players.map(() => null);
    pc.hands = d.players.map(p => p.hand || null);
    pc.dets = [];
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
  $('#ballBack').addEventListener('click', () => setStep(3));
  $('#ballSkip').addEventListener('click', () => { getDraft().cfg.ball = false; getDraft().cfg.ballCal = null; onReady(); });
  $('#ballConfirm').addEventListener('click', () => {
    const d = getDraft();
    d.cfg.ballCal = ballConfigFromSamples(bc.samples.map(s => ({ ...s, d: +sizeEl.value })));
    onReady();
  });

  async function startBall() {
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
