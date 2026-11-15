import { $, $$, bisect, clamp, containSize, esc, fmt, fmtPct, fmtTime, median, toast, uid, fitCanvas, seekVideo, setMediaLayout, loadVideoMeta, download } from './util.js';
import { makeCalibration, calibrationWorkspace, imageToCalibrationCanvas, calibrationCanvasToImage, applyH, COURT_LINES, distToNet, UNLIMITED } from './court.js';
import { processVideo } from './processor.js';
import { analyze } from './analysis.js';
import { coach, buildPlan } from './coach.js';
import { DRILLS, FOCUS_LIST } from './drills.js';
import { saveMatch, getMatch, listSummaries, deleteMatch, matchToJSON, matchFromJSON, saveVideo, getVideo, hasVideo, deleteVideo } from './db.js';
import { exportVideo, askSaveLocation, canEncodeMp4, canPickFile, outputSize, totalDuration } from './exporter.js';
import { drawSkeleton, drawPaddleHand, drawPlayerBox, drawCourtOverlay, drawLabel, drawTopDown, drawTopDownAt, drawHeatmap, drawTimeline, drawLineChart, playerColor, TEAM_COLORS, BALL_COLOR } from './render.js';
import { pickHighlights, recordReel } from './highlights.js';
import { L } from './pose.js';
import { importFromLink } from './importer.js';
import { setupCalibration, attachPlayback } from './calibration.js';
import { toGrid, fromGrid, isEmpty, poseMasked, maskedAt, drawMask, attachPainter } from './mask.js';
import { computeAccuracy, CLASSES, PHASES } from './accuracy.js';
import { setupTrim } from './trim.js';
import { buildCallouts, activeCallouts, drawCallouts, headFromPose } from './callouts.js';

// ------------------------------------------------------------------ state
const state = {
  view: 'dashboard',
  file: null, fileURL: null,       // currently loaded video file
  draft: null,                     // match being set up
  calPts: [], calView: null, dragIdx: -1,
  cancel: false,
  match: null, A: null, C: null,   // loaded match, analysis, coach result
  lens: 'all', selected: null, statTab: 'overview',
  playlist: null,
  shot: null,
  summaries: [],
};
const procVideo = document.createElement('video');
procVideo.muted = true; procVideo.playsInline = true; procVideo.preload = 'auto';
const video = $('#video');

// ------------------------------------------------------------------ key metrics (for trends & compare)
const KEY_METRICS = [
  { id: 'accuracy', label: 'Shot accuracy', better: 'higher', get: m => m.accuracy, f: v => (Number.isFinite(v) ? `${v.toFixed(1)}%` : '–') },
  { id: 'arrivalReturn', label: 'Kitchen arrival after return', unit: 's', better: 'lower', get: m => median(m.arrivalReturn.map(e => e.dt)), f: v => `${fmt(v, 1)} s` },
  { id: 'arrivalThird', label: 'Kitchen arrival after 3rd shot', unit: 's', better: 'lower', get: m => median(m.arrivalThird.map(e => e.dt)), f: v => `${fmt(v, 1)} s` },
  { id: 'transition', label: 'Time in transition zone', better: 'lower', get: m => m.zone.transition, f: v => fmtPct(v) },
  { id: 'kitchen', label: 'Time at the kitchen', better: 'higher', get: m => m.zone.kitchen, f: v => fmtPct(v) },
  { id: 'paddleLow', label: 'Paddle low at kitchen', better: 'lower', get: m => m.paddleLowPct, f: v => fmtPct(v) },
  { id: 'tall', label: 'Standing tall at kitchen', better: 'lower', get: m => m.tallPct, f: v => fmtPct(v) },
  { id: 'knee', label: 'Avg knee angle at kitchen', better: 'lower', get: m => m.kneeAvg, f: v => `${fmt(v, 0)}°` },
  { id: 'split', label: 'Split step on time', better: 'higher', get: m => m.splitOnPct, f: v => fmtPct(v) },
  { id: 'reaction', label: 'First-step reaction', better: 'lower', get: m => m.reactionAvg, f: v => `${fmt(v, 2)} s` },
  { id: 'bh', label: 'Backhand share of shots', better: 'none', get: m => (m.shots ? m.bh / m.shots : NaN), f: v => fmtPct(v) },
  { id: 'distance', label: 'Distance per rally', better: 'none', get: m => m.distancePerRally, f: v => `${fmt(v, 0)} ft` },
];

const meSlot = match => {
  const i = match.players.findIndex(p => p.isMe);
  return i >= 0 ? i : match.players.findIndex(p => p.team === match.cfg.myTeam);
};

// ------------------------------------------------------------------ navigation
function show(view) {
  state.view = view;
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  if (view !== 'analysis' && !video.paused) video.pause();
  if (view === 'dashboard') renderDashboard();
  if (view === 'analysis') renderAnalysis();
  if (view === 'report') renderReport();
  if (view === 'plan') renderPlan();
  if (view === 'compare') renderCompare();
  if (view === 'drills') renderDrills();
}
$$('#nav button').forEach(b => b.addEventListener('click', () => show(b.dataset.view)));
document.addEventListener('click', e => { const g = e.target.closest('[data-goto]'); if (g) show(g.dataset.goto); });

// ------------------------------------------------------------------ step 1: video & setup
function setStep(n) {
  $$('#steps li').forEach(li => { const s = +li.dataset.step; li.classList.toggle('active', s === n); li.classList.toggle('done', s < n); });
  $$('.step-pane').forEach(p => p.classList.toggle('active', +p.dataset.pane === n));
}

async function setVideoFile(file) {
  if (state.fileURL) URL.revokeObjectURL(state.fileURL);
  state.file = file;
  state.fileURL = URL.createObjectURL(file);
  try {
    await loadVideoMeta(procVideo, state.fileURL);
  } catch (e) {
    toast(e.message, 5000);
    return false;
  }
  return true;
}

$('#videoInput').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (f) await pickVideo(f);
  e.target.value = '';
});
const dz = $('#dropzone');
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
dz.addEventListener('drop', async e => {
  e.preventDefault(); dz.classList.remove('drag');
  const f = e.dataTransfer.files[0];
  if (f && f.type.startsWith('video')) await pickVideo(f);
});

// ---- game time (trim)
const trim = setupTrim({ scanVideo: procVideo });
$('#setupForm').fps.addEventListener('change', e => trim.setFps(+e.target.value));

// ---- import from link (YouTube etc.)
const linkStatusText = s => {
  const title = s.title ? `“${s.title}” — ` : '';
  if (s.stage === 'download') return `${title}downloading on the local server… ${fmt(s.progress, 0)}%`;
  return `${title}loading into the browser… ${fmt(s.progress, 0)}%`;
};
async function runLinkImport(url, { onFile, statusEl, progEl, button }) {
  button.disabled = true;
  progEl.hidden = false;
  statusEl.textContent = 'Starting import… (the first import also downloads the yt-dlp helper)';
  try {
    const file = await importFromLink(url, s => {
      statusEl.textContent = linkStatusText(s);
      progEl.firstElementChild.style.width = `${s.progress || 0}%`;
    });
    await onFile(file);
    statusEl.textContent = `Imported: ${file.name} (${(file.size / 1e6).toFixed(0)} MB)`;
  } catch (e) {
    statusEl.textContent = e.message;
    toast(e.message, 5000);
  } finally {
    button.disabled = false;
    progEl.hidden = true;
  }
}
$('#linkBtn').addEventListener('click', () => {
  const url = $('#linkInput').value;
  runLinkImport(url, { onFile: f => pickVideo(f, url.trim()), statusEl: $('#linkStatus'), progEl: $('#linkProg'), button: $('#linkBtn') });
});
$('#linkInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#linkBtn').click(); });

async function pickVideo(f, sourceUrl = null) {
  state.sourceUrl = sourceUrl;
  $('#videoInfo').textContent = 'Loading…';
  if (!(await setVideoFile(f))) { $('#videoInfo').textContent = 'Could not open this video.'; return; }
  const v = procVideo;
  $('#videoInfo').innerHTML = `<b>${esc(f.name)}</b> · ${v.videoWidth}×${v.videoHeight} · ${fmtTime(v.duration)} · ${(f.size / 1e6).toFixed(0)} MB`;
  const form = $('#setupForm');
  if (!form.name.value) form.name.value = f.name.replace(/\.[^.]+$/, '');
  trim.load(state.fileURL, v.duration);
  trim.setFps(+form.fps.value);
  $('#toCalibrate').disabled = false;
}

$('#toCalibrate').addEventListener('click', async () => {
  const fd = new FormData($('#setupForm'));
  const format = fd.get('format');
  const players = format === 'doubles'
    ? [
      { team: 'A', label: 'Me' }, { team: 'A', label: 'Partner' },
      { team: 'B', label: 'Opponent 1' }, { team: 'B', label: 'Opponent 2' },
    ]
    : [{ team: 'A', label: 'Me' }, { team: 'B', label: 'Opponent' }];
  const myTeam = fd.get('myTeam');
  if (myTeam === 'B') { // labels follow the user's side
    players.forEach(p => { p.team = p.team === 'A' ? 'B' : 'A'; });
    players.sort((a, b) => a.team.localeCompare(b.team));
  }
  players.forEach(p => { p.isMe = p.label === 'Me'; });
  $('#trimVideo').pause();
  state.draft = {
    id: uid(),
    name: fd.get('name') || state.file.name,
    createdAt: Date.now(),
    cfg: {
      format, skill: fd.get('skill'), myTeam,
      fps: +fd.get('fps'), model: fd.get('model'),
      crops: fd.get('crops') === 'on', ball: fd.get('ball') === 'on', keepVideo: fd.get('keepVideo') === 'on',
      segments: trim.getSegments(),
      playArea: UNLIMITED, // players are followed wherever they move
      sensitivity: 3.5,
    },
    players,
    outcomes: {},
  };
  const segs = state.draft.cfg.segments;
  state.draft.cfg.rangeStart = segs[0].start;          // used by calibration frame defaults
  state.draft.cfg.rangeEnd = segs[segs.length - 1].end;
  state.calPts = [];
  setStep(2);
  const scrub = $('#calScrub');
  scrub.max = procVideo.duration;
  scrub.value = Math.min(procVideo.duration, (state.draft.cfg.rangeStart || 0) + 1);
  await seekVideo(procVideo, +scrub.value);
  drawCal();
});

// ------------------------------------------------------------------ step 2: calibration
const calCanvas = $('#calCanvas');
const CAL_NAMES = ['far-left', 'far-right', 'near-right', 'near-left'];

function drawCal() {
  const v = procVideo;
  const view = calibrationWorkspace(v.videoWidth, v.videoHeight);
  state.calView = view;
  if (calCanvas.width !== view.width) calCanvas.width = view.width;
  if (calCanvas.height !== view.height) calCanvas.height = view.height;
  const ctx = calCanvas.getContext('2d');
  const w = calCanvas.width, h = calCanvas.height;
  const f = view.frame;
  // The dark margin is usable calibration space for parts of the court cropped out of video.
  ctx.fillStyle = '#101112'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(240,239,236,0.38)'; ctx.font = '600 12px Inter, system-ui';
  ctx.fillText('OUTSIDE VIDEO — estimate where the court lines meet', 12, 20);
  ctx.drawImage(v, f.x, f.y, f.w, f.h);
  ctx.strokeStyle = 'rgba(240,239,236,0.65)'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
  ctx.strokeRect(f.x, f.y, f.w, f.h); ctx.setLineDash([]);
  if (state.calPts.length === 4) {
    ctx.save();
    try {
      ctx.translate(f.x, f.y);
      drawCourtOverlay(ctx, makeCalibration(state.calPts), f.w, f.h);
    } catch { /* degenerate */ } finally { ctx.restore(); }
  }
  state.calPts.forEach(([x, y], i) => {
    const [px, py] = imageToCalibrationCanvas(view, x, y);
    const offFrame = x < 0 || x > 1 || y < 0 || y > 1;
    ctx.fillStyle = offFrame ? '#eedd33' : '#199e70'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = '600 13px Inter, system-ui';
    ctx.fillText(`${i + 1} ${CAL_NAMES[i]}`, clamp(px + 10, 4, w - 110), clamp(py - 8, 16, h - 4));
  });
  const next = state.calPts.length;
  const outside = state.calPts.filter(([x, y]) => x < 0 || x > 1 || y < 0 || y > 1).length;
  $('#calHint').innerHTML = next < 4
    ? `Click corner <b>${next + 1}: ${CAL_NAMES[next]}</b> (far-left → far-right → near-right → near-left). If it is cropped, place it in the dark <b>outside-video</b> area where the visible lines would meet.`
    : `Check that the projected court lines sit on the real lines and drag points to adjust.${outside ? ` <b>${outside}</b> corner${outside === 1 ? ' is' : 's are'} outside the video.` : ''}`;
  $('#calConfirm').disabled = next < 4;
}
const calCanvasPos = e => {
  const r = calCanvas.getBoundingClientRect();
  return [(e.clientX - r.left) * calCanvas.width / r.width, (e.clientY - r.top) * calCanvas.height / r.height];
};
const calPos = e => {
  const [px, py] = calCanvasPos(e);
  const [x, y] = calibrationCanvasToImage(state.calView, px, py);
  const b = state.calView.bounds;
  return [clamp(x, b.x0, b.x1), clamp(y, b.y0, b.y1)];
};
calCanvas.addEventListener('pointerdown', e => {
  const [x, y] = calPos(e);
  const r = calCanvas.getBoundingClientRect();
  const [mx, my] = calCanvasPos(e);
  const hit = state.calPts.findIndex(([ix, iy]) => {
    const [px, py] = imageToCalibrationCanvas(state.calView, ix, iy);
    return Math.hypot((px - mx) * r.width / calCanvas.width, (py - my) * r.height / calCanvas.height) < 14;
  });
  if (hit >= 0) state.dragIdx = hit;
  else if (state.calPts.length < 4) state.calPts.push([x, y]);
  calCanvas.setPointerCapture?.(e.pointerId);
  e.preventDefault();
  drawCal();
});
window.addEventListener('pointermove', e => {
  if (state.dragIdx < 0) return;
  state.calPts[state.dragIdx] = calPos(e);
  drawCal();
});
window.addEventListener('pointerup', () => { state.dragIdx = -1; });
window.addEventListener('pointercancel', () => { state.dragIdx = -1; });
$('#calReset').addEventListener('click', () => { state.calPts = []; drawCal(); });
attachPlayback(procVideo, {
  playBtn: $('#calPlay'), speedSel: $('#calSpeed'), scrub: $('#calScrub'),
  render: () => { if ($('[data-pane="2"]').classList.contains('active')) { drawCal(); $('#calTime').textContent = fmtTime(procVideo.currentTime); } },
});
$('#calScrub').addEventListener('input', async e => {
  $('#calTime').textContent = fmtTime(+e.target.value);
  await seekVideo(procVideo, +e.target.value);
  drawCal();
});

$('#calConfirm').addEventListener('click', async () => {
  let cal;
  try { cal = makeCalibration(state.calPts); } catch { toast('Those points do not form a court — reset and try again.'); return; }
  state.draft.cal = cal;
  state.draft.video = { name: state.file.name, size: state.file.size, duration: procVideo.duration, w: procVideo.videoWidth, h: procVideo.videoHeight, sourceUrl: state.sourceUrl || null };
  await calib.startPlayers();
});

// ------------------------------------------------------------------ steps 3–4: player & ball calibration
const calib = setupCalibration({
  video: procVideo,
  getDraft: () => state.draft,
  setStep,
  onReady: async () => { procVideo.pause(); calib.dispose(); await runProcessing(); },
});

// ------------------------------------------------------------------ step 3: processing
$('#cancelProc').addEventListener('click', () => { state.cancel = true; });

async function runProcessing() {
  const match = state.draft;
  state.cancel = false;
  setStep(5);
  const pc = $('#procCanvas');
  const previewSize = containSize(procVideo.videoWidth, procVideo.videoHeight, { maxWidth: 960, maxHeight: 720 });
  pc.width = previewSize.width;
  pc.height = previewSize.height;
  setMediaLayout(pc.closest('.cal-wrap'), procVideo.videoWidth, procVideo.videoHeight);
  const pctx = pc.getContext('2d');
  let n = 0;
  try {
    const samples = await processVideo(match, procVideo, {
      onStatus: s => { $('#procStatus').textContent = s; },
      onProgress: (f, eta) => {
        $('#procBar').style.width = `${(f * 100).toFixed(1)}%`;
        $('#procStatus').textContent = `Analyzing… ${(f * 100).toFixed(0)}% · about ${fmtTime(eta)} left`;
      },
      onFrame: sample => {
        if (n++ % 3) return;
        pctx.drawImage(procVideo, 0, 0, pc.width, pc.height);
        drawCourtOverlay(pctx, sample.c ? makeCalibration(sample.c) : match.cal, pc.width, pc.height);
        sample.p.forEach((p, k) => p && drawSkeleton(pctx, p.lm, pc.width, pc.height, playerColor(match.players, k), 2));
        if (sample.b) { pctx.fillStyle = BALL_COLOR; pctx.beginPath(); pctx.arc(sample.b[0] * pc.width, sample.b[1] * pc.height, 5, 0, 7); pctx.fill(); }
      },
      isCancelled: () => state.cancel,
    });
    if (samples.length < 20) { toast('Not enough frames were analyzed.'); setStep(3); return; }
    match.samples = samples;
    if (state.cancel) toast('Stopped early — analyzing the part that was processed.');
    await openMatch(match, true);
    if (match.cfg.keepVideo) {
      saveVideo(match.id, state.file).then(refreshStoreButton).catch(e => toast(`Analysis saved, but the video copy wasn't: ${e.message}`, 6000));
    }
    setStep(1);
    show('analysis');
  } catch (e) {
    console.error(e);
    $('#procStatus').textContent = `Error: ${e.message}. Check your internet connection (the pose model loads from a CDN) and try again.`;
  }
}

// ------------------------------------------------------------------ open / save / recompute
function summaryOf(match, A, C) {
  const k = meSlot(match);
  const key = {};
  if (k >= 0) KEY_METRICS.forEach(km => { key[km.id] = km.get(A.metrics[k]); });
  return {
    id: match.id, name: match.name, createdAt: match.createdAt, duration: A.duration,
    format: match.cfg.format, skill: match.cfg.skill, rallies: A.rallies.length, shots: A.shots.length,
    me: k >= 0 ? match.players[k].label : '',
    topFix: C.findings.filter(f => f.lens === 'fix').slice(0, 3).map(f => ({ title: f.title, who: f.who, evidence: f.evidence, severity: f.severity, drill: f.drills[0] })),
    topExploit: C.findings.filter(f => f.lens === 'exploit').slice(0, 3).map(f => ({ title: f.title, who: f.who })),
    key,
  };
}

async function persist() {
  const { match, A, C } = state;
  if (!match) return;
  try { await saveMatch(match, summaryOf(match, A, C)); } catch (e) { console.error(e); toast('Could not save to browser storage: ' + e.message); }
}

function recompute() {
  state.A = analyze(state.match);
  state.R = computeAccuracy(state.match, state.A);
  state.R.perPlayer.forEach((p, k) => { state.A.metrics[k].accuracy = p.accuracy; });
  state.C = coach(state.match, state.A);
  state.CO = buildCallouts(state.match, state.A);
}

async function openMatch(match, isNew = false) {
  if (state.erase?.on) closeEraser();
  if (state.erase) state.erase.undo = [];
  state.match = match;
  state.selected = null; state.playlist = null; state.shot = null;
  recompute();
  if (isNew) await persist();
  // video
  const v = match.video;
  if (state.file && state.file.name === v.name && state.file.size === v.size) {
    if (video.src !== state.fileURL) await loadVideoMeta(video, state.fileURL).catch(() => {});
    $('#attachVideo').hidden = true;
  } else if (await loadStoredVideo(match)) {
    $('#attachVideo').hidden = true;
  } else {
    video.removeAttribute('src'); video.load();
    $('#attachVideo').hidden = false;
    $('#reimportBtn').hidden = !v.sourceUrl;
    $('#attachNote').textContent = v.sourceUrl ? `Pick the same file, or re-import from ${v.sourceUrl}` : 'Pick the same file you analyzed.';
  }
  setMediaLayout($('#playerWrap'), v.w, v.h);
  refreshStoreButton();
}

async function loadStoredVideo(match) {
  const f = await getVideo(match.id).catch(() => null);
  if (!f) return false;
  if (!(await setVideoFile(f))) return false;
  try { await loadVideoMeta(video, state.fileURL); return true; } catch { return false; }
}

$('#attachInput').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  if (state.match && (f.name !== state.match.video.name || f.size !== state.match.video.size)) toast('This file differs from the analyzed one — overlays may not line up.', 4000);
  if (!(await setVideoFile(f))) return;
  await loadVideoMeta(video, state.fileURL).catch(err => toast(err.message));
  $('#attachVideo').hidden = true;
  renderAnalysis();
});

$('#reimportBtn').addEventListener('click', () => {
  const url = state.match?.video.sourceUrl;
  if (!url) return;
  const prog = document.createElement('div'); prog.className = 'progress slim'; prog.innerHTML = '<div></div>';
  runLinkImport(url, {
    onFile: async f => {
      if (!(await setVideoFile(f))) return;
      await loadVideoMeta(video, state.fileURL);
      $('#attachVideo').hidden = true;
      renderAnalysis();
    },
    statusEl: $('#attachNote'), progEl: prog, button: $('#reimportBtn'),
  });
});

// ------------------------------------------------------------------ eraser (remove spectators after analysis)
state.erase = { on: false, grid: null, tool: 'erase', hover: null, undo: [] };
const overlayCanvas = $('#overlay');
const erasePainter = attachPainter(overlayCanvas, {
  getGrid: () => state.erase.grid,
  getBrush: () => +$('#eBrush').value / 100,
  isRestore: () => state.erase.tool === 'restore',
  aspect: () => state.match.video.w / state.match.video.h,
  onHover: p => { state.erase.hover = p; drawOverlayNow(true); },
  onChange: () => drawOverlayNow(true),
});

function openEraser() {
  if (!state.match) return;
  video.pause(); stopPlaylist();
  state.erase.on = true;
  state.erase.grid = toGrid(state.match.cfg.ignore);
  overlayCanvas.classList.add('painting');
  erasePainter.setMode(true);
  $('#eraseBar').hidden = false;
  $('#eUndo').disabled = !state.erase.undo.length;
  $('#eInfo').textContent = 'Paint over spectators on the video (pause on a frame where they are visible). Removing applies to the whole match.';
  drawOverlayNow(true);
}
function closeEraser() {
  state.erase.on = false;
  overlayCanvas.classList.remove('painting');
  erasePainter.setMode(false);
  $('#eraseBar').hidden = true;
  drawOverlayNow(true);
}
$('#btnErase').addEventListener('click', () => (state.erase.on ? closeEraser() : openEraser()));
$('#eDone').addEventListener('click', closeEraser);
document.querySelectorAll('[data-etool]').forEach(b => b.addEventListener('click', () => {
  state.erase.tool = b.dataset.etool;
  document.querySelectorAll('[data-etool]').forEach(x => x.classList.toggle('on', x === b));
}));

$('#eApply').addEventListener('click', () => {
  const { match } = state, grid = state.erase.grid;
  if (isEmpty(grid)) { toast('Paint over the spectators first.'); return; }
  const removed = [];
  const perPlayer = match.players.map(() => 0);
  match.samples.forEach((s, i) => {
    s.p.forEach((p, k) => {
      if (p && poseMasked(grid, p.lm)) { removed.push({ i, k, p }); s.p[k] = null; perPlayer[k]++; }
    });
    if (s.b && maskedAt(grid, s.b[0], s.b[1])) { removed.push({ i, ball: s.b }); s.b = null; }
  });
  state.erase.undo.push({ removed, prevIgnore: match.cfg.ignore || null });
  match.cfg.ignore = fromGrid(grid);
  recompute(); renderAnalysis(); persist();
  $('#eUndo').disabled = false;
  const fps = match.cfg.fps || 10;
  const detail = match.players.map((p, k) => (perPlayer[k] ? `${p.label} ${fmtTime(perPlayer[k] / fps)}` : '')).filter(Boolean).join(', ');
  $('#eInfo').textContent = removed.length
    ? `Removed ${removed.length} detections (${detail || 'ball only'}). If a real player was lost while a spectator was tracked, use “Re-analyze with erased areas”.`
    : 'Nothing was detected in the erased areas. The areas are saved and will be ignored if you re-analyze.';
  toast(removed.length ? 'Spectator detections removed.' : 'Erased areas saved.');
});

$('#eUndo').addEventListener('click', () => {
  const last = state.erase.undo.pop();
  if (!last) return;
  const { match } = state;
  for (const r of last.removed) {
    if (r.ball) match.samples[r.i].b = r.ball; else match.samples[r.i].p[r.k] = r.p;
  }
  match.cfg.ignore = last.prevIgnore;
  state.erase.grid = toGrid(last.prevIgnore);
  recompute(); renderAnalysis(); persist();
  $('#eUndo').disabled = !state.erase.undo.length;
  toast(`Restored ${last.removed.length} detections.`);
});

$('#eReanalyze').addEventListener('click', async () => {
  if (!videoReady()) return;
  if (!confirm('Run the whole analysis again with the erased areas ignored from the start? Calibration, names, hands and labeled rallies are kept.')) return;
  const m = state.match;
  m.cfg.ignore = isEmpty(state.erase.grid) ? null : fromGrid(state.erase.grid);
  closeEraser();
  if (procVideo.src !== state.fileURL) await loadVideoMeta(procVideo, state.fileURL);
  state.draft = { ...m, samples: undefined };
  state.erase.undo = [];
  show('new');
  await runProcessing();
});

// ------------------------------------------------------------------ analysis view
function renderAnalysis() {
  const has = !!state.match;
  $('#noMatch').hidden = has;
  $('#analysisRoot').hidden = !has;
  if (!has) return;
  const { match } = state;
  $('#matchTitle').textContent = match.name;
  $('#coachSummary').innerHTML = state.C.summary;
  renderFindings();
  renderReview();
  renderLegends();
  renderHeatSelect();
  renderHeatmap();
  renderStats();
  renderShotInspector();
  requestAnimationFrame(() => { drawTimelineNow(); drawOverlayNow(true); });
}

function renderLegends() {
  const { match } = state;
  const items = match.players.map((p, k) => `<span><i style="background:${playerColor(match.players, k)}"></i>${esc(p.label)}</span>`).join('');
  $('#playerLegend').innerHTML = items;
  $('#tlLegend').innerHTML = `${items}<span><i style="background:${TEAM_COLORS.A};opacity:.4"></i>rally won by near team</span><span><i style="background:${TEAM_COLORS.B};opacity:.4"></i>won by far team</span><span><i style="background:#4a4a45"></i>unlabeled rally</span><span>▲ selected finding</span>`;
}

// ---- game review (accuracy)
const clsInfo = id => CLASSES.find(c => c.id === id);
const symHtml = c => `<span class="cls-sym" style="background:${c.color}">${c.sym}</span>`;

function renderReview() {
  const { match, R } = state;
  const P = match.players;
  $('#reviewNote').textContent = R.labeledCount === R.totalRallies
    ? 'Scores use rally outcomes, what the opponent did with each shot, tactical fit and body mechanics.'
    : `${R.labeledCount || 0}/${R.totalRallies || 0} rally outcomes labeled. Unlabeled final shots stay neutral; label the outcome to score winners and errors.`;
  $('#accTiles').innerHTML = P.map((p, k) => {
    const pp = R.perPlayer[k];
    return `<div class="acc-tile" style="border-top-color:${playerColor(P, k)}">
      <span>${esc(p.label)}</span><b>${Number.isFinite(pp.accuracy) ? pp.accuracy.toFixed(1) : '–'}<small style="display:inline;font-size:14px">%</small></b>
      <small>${pp.n} shots · ${p.team === match.cfg.myTeam ? 'your team' : 'opponent'}</small></div>`;
  }).join('');
  const head = `<tr><th></th>${P.map((p, k) => `<th class="num"><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${playerColor(P, k)};margin-right:4px"></i>${esc(p.label)}</th>`).join('')}</tr>`;
  const rows = CLASSES.map(c => `<tr><td>${symHtml(c)}${c.name}</td>${P.map((_, k) => {
    const n = R.perPlayer[k].counts[c.id];
    return `<td class="num count"><a href="#" class="${n ? '' : 'zero'}" data-cls="${c.id}" data-slot="${k}" title="Play these shots">${n}</a></td>`;
  }).join('')}</tr>`).join('');
  const phases = PHASES.map(ph => `<tr><td class="muted">${ph.name}</td>${P.map((_, k) => { const v = R.perPlayer[k].byPhase[ph.id]; return `<td class="num muted">${Number.isFinite(v) ? v.toFixed(0) + '%' : '–'}</td>`; }).join('')}</tr>`).join('');
  $('#accTable').innerHTML = `<table>${head}${rows}<tr><th colspan="${P.length + 1}">Accuracy by phase</th></tr>${phases}</table>`;
  // accuracy across rallies (rolling mean of 3 rallies)
  const roll = arr => arr.map((_, i) => { const w = arr.slice(Math.max(0, i - 2), i + 1).filter(Number.isFinite); return w.length ? w.reduce((a, b) => a + b, 0) / w.length : NaN; });
  drawLineChart($('#accChart'), $('#accTip'), {
    series: P.map((p, k) => ({ label: p.label, color: playerColor(P, k), values: roll(R.perPlayer[k].byRally) })),
    xLabels: state.A.rallies.map(r => `Rally ${r.index + 1}`),
    yFmt: v => `${v.toFixed(0)}%`,
  });
  $('#accLegend').innerHTML = `${P.map((p, k) => `<span><i style="background:${playerColor(P, k)}"></i>${esc(p.label)}</span>`).join('')}<span class="muted">accuracy across the match (3-rally average)</span>`;
}

$('#accTable').addEventListener('click', e => {
  const a = e.target.closest('[data-cls]'); if (!a) return;
  e.preventDefault();
  const k = +a.dataset.slot, cls = a.dataset.cls;
  const items = state.R.review.filter(x => x.slot === k && x.cls === cls);
  if (!items.length) return;
  const name = clsInfo(cls).name;
  startPlaylist(items.map((x, i) => ({ start: Math.max(0, x.t - 2.5), end: x.t + 2, label: `${state.match.players[k].label} — ${name} ${i + 1}/${items.length}: ${x.why.map(w => w.text).join('; ') || state.A.shots[x.j].type}` })));
});

// ---- findings
$('#lensTabs').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  state.lens = b.dataset.lens;
  $$('#lensTabs button').forEach(x => x.classList.toggle('active', x === b));
  renderFindings();
});

/** Jump the video to just before a moment and play it (the user keeps full control). */
async function jumpTo(t, { lead = 1.5, play = true } = {}) {
  if (!videoReady()) return;
  stopPlaylist();
  video.pause();
  await seekVideo(video, clamp(t - lead, 0, video.duration || t));
  drawOverlayNow(true);
  const wrap = $('#playerWrap').getBoundingClientRect();
  if (wrap.top < 0 || wrap.bottom > window.innerHeight) $('#playerWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (play) video.play().catch(() => {});
}

/** The moments a finding is about (event times from its clips). */
const momentsOf = f => f.clips.map(c => Math.min(c.end - 2, c.start + 2.5));

function renderCallouts() {
  const el = $('#findings');
  const { match } = state;
  const team = calloutTeam($('#tCoachWho').value);
  const list = (state.CO || []).filter(c => team === 'all' || match.players[c.slot].team === team);
  if (!list.length) { el.innerHTML = '<p class="muted">No coach comments for this filter.</p>'; return; }
  const ICON = { fix: '📣', exploit: '🎯', good: '👍' };
  el.innerHTML = `<div class="callout-list">${list.map(c => `
    <button type="button" class="callout-item k-${c.kind}" data-t="${c.t0}" data-t1="${c.t1}">
      <span class="mono">${fmtTime(c.t0)}</span>
      <i style="background:${playerColor(match.players, c.slot)}"></i>
      <b>${esc(match.players[c.slot].label)}</b>
      <span>${ICON[c.kind] || '📣'} ${esc(c.text)}</span>
    </button>`).join('')}</div>`;
}

function renderFindings() {
  if (state.lens === 'callouts') { renderCallouts(); return; }
  const list = state.C.findings.filter(f => state.lens === 'all' || f.lens === state.lens);
  const el = $('#findings');
  if (!list.length) {
    el.innerHTML = `<p class="muted">No issues above target for this view. ${state.C.strengths.length ? 'Strengths: ' + state.C.strengths.slice(0, 4).map(s => esc(`${s.who} — ${s.title.toLowerCase()}`)).join('; ') + ' (better than target).' : ''}</p>`;
    return;
  }
  el.innerHTML = list.map(f => `
    <div class="finding sev-${f.severity} ${state.selected === f.id ? 'selected' : ''}" data-id="${f.id}">
      <div class="f-head"><span class="f-title">${esc(f.title)}</span><span class="chip sev-${f.severity}">${f.severity}</span></div>
      <div class="f-player">${esc(f.who)} · <span class="chip lens">${f.lens === 'fix' ? 'fix' : 'exploit'}</span> · confidence ${fmtPct(f.conf)}</div>
      <div class="f-evidence">${esc(f.evidence)}${f.impact ? ` · in ${fmtPct(f.impact.share)} of lost points` : ''}</div>
      <div class="f-label">${f.lens === 'fix' ? 'What happens' : 'Opportunity'}</div><p>${esc(f.problem)}</p>
      <div class="f-label">${f.lens === 'fix' ? 'Counter / fix' : 'How to exploit'}</div><p>${esc(f.counter)}</p>
      ${f.clips.length ? `<div class="f-label">When it happened — click to watch</div>
      <div class="moments">${momentsOf(f).slice(0, 12).map(t => `<button type="button" class="moment" data-t="${t}">▶ ${fmtTime(t)}</button>`).join('')}${f.clips.length > 12 ? `<span class="muted small">+${f.clips.length - 12} more</span>` : ''}</div>` : ''}
      <div class="f-actions">
        ${f.clips.length ? `<button class="btn small primary" data-act="play">▶ Play ${f.clips.length} clip${f.clips.length > 1 ? 's' : ''}</button>` : ''}
        ${f.lens === 'fix' ? f.drills.map(d => `<button class="btn small ghost" data-act="drill" data-drill="${d}">Drill: ${esc(DRILLS[d].name)}</button>`).join('') : ''}
      </div>
    </div>`).join('');
}

$('#findings').addEventListener('click', e => {
  const co = e.target.closest('.callout-item');
  if (co) { jumpTo(+co.dataset.t, { lead: 1.0 }); return; }
  const card = e.target.closest('.finding'); if (!card) return;
  const f = state.C.findings.find(x => x.id === card.dataset.id);
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'drill') { state.drillHighlight = e.target.closest('[data-act]').dataset.drill; show('drills'); return; }
  const wasSelected = state.selected === f.id;
  state.selected = f.id;
  renderFindings();
  drawTimelineNow();
  if (act === 'play') { startPlaylist(f.clips.map((c, i) => ({ ...c, label: `${f.title} — clip ${i + 1}/${f.clips.length}` }))); return; }
  const mo = e.target.closest('.moment');
  if (mo) { jumpTo(+mo.dataset.t); return; }
  // clicking the comment itself goes to the first moment it happened
  if (!wasSelected && f.clips.length) jumpTo(momentsOf(f)[0]);
  else if (!f.clips.length) toast('This finding is a match-wide pattern without a single moment to show.');
});

// ---- playlist
function startPlaylist(clips) {
  if (!videoReady()) return;
  state.playlist = { clips, i: 0 };
  playClip();
}
async function playClip() {
  const pl = state.playlist; if (!pl) return;
  const c = pl.clips[pl.i];
  $('#playlistBar').hidden = false;
  $('#playlistLabel').textContent = `${c.label || `Clip ${pl.i + 1}/${pl.clips.length}`} · ${fmtTime(c.start)}`;
  await seekVideo(video, c.start);
  video.play();
}
function stopPlaylist() { state.playlist = null; $('#playlistBar').hidden = true; }
$('#plNext').addEventListener('click', () => { const pl = state.playlist; if (!pl) return; pl.i = Math.min(pl.clips.length - 1, pl.i + 1); playClip(); });
$('#plPrev').addEventListener('click', () => { const pl = state.playlist; if (!pl) return; pl.i = Math.max(0, pl.i - 1); playClip(); });
$('#plStop').addEventListener('click', () => { video.pause(); stopPlaylist(); });

$('#btnHighlights').addEventListener('click', () => {
  const clips = pickHighlights(state.A, state.match.cfg.myTeam);
  if (!clips.length) { toast('No rallies detected yet.'); return; }
  startPlaylist(clips);
});

// ---- save analyzed video (overlays burned in)
const ex = { running: false, cancel: false };
const exForm = $('#exportForm');

function exportSegments(range) {
  const { A } = state;
  if (range === 'all') {
    const segs = state.match.cfg.segments;
    return segs?.length ? segs.map((g, i) => ({ start: Math.max(g.start, A.T[0]), end: Math.min(g.end, A.T[A.N - 1]), label: segs.length > 1 ? `Game ${i + 1}` : undefined })).filter(g => g.end > g.start)
      : [{ start: A.T[0], end: A.T[A.N - 1] }];
  }
  if (range === 'rallies') return A.rallies.map(r => ({ start: r.start, end: r.end, label: `Rally ${r.index + 1}` }));
  if (range === 'highlights') return pickHighlights(A, state.match.cfg.myTeam);
  const f = state.C.findings.find(x => x.id === state.selected);
  return f ? f.clips.map((c, i) => ({ ...c, label: `${f.title} — ${f.who} (${i + 1}/${f.clips.length})`, finding: f })) : [];
}

function updateExportEstimate() {
  const segs = exportSegments(exForm.range.value);
  const fps = +exForm.fps.value;
  const { width, height } = outputSize(state.match.video.w, state.match.video.h, +exForm.height.value);
  const dur = totalDuration(segs);
  const mb = (width * height * fps * 0.12 * dur) / 8 / 1e6;
  const fin = state.C.findings.find(x => x.id === state.selected);
  exForm.range.querySelector('[value=finding]').textContent = fin ? `Clips of “${fin.title}” (${fin.who})` : 'Clips of the selected finding (select one in the Coach panel)';
  exForm.range.querySelector('[value=finding]').disabled = !fin;
  $('#exEstimate').textContent = segs.length
    ? `${segs.length} segment${segs.length > 1 ? 's' : ''} · ${fmtTime(dur)} of video · ${width}×${height} · ≈ ${mb < 1 ? '<1' : mb.toFixed(0)} MB. ${canEncodeMp4() ? 'Export runs frame by frame — roughly 1–3× the video length.' : 'Recording runs in real time.'}`
    : 'Nothing to export for this selection.';
  $('#exStart').disabled = !segs.length || ex.running;
}

$('#btnSaveVideo').addEventListener('click', () => {
  if (!videoReady()) return;
  stopPlaylist(); video.pause();
  $('#exFormat').textContent = canEncodeMp4()
    ? `Saves an MP4 (H.264) with the analysis drawn on the video${canPickFile() ? ' — you choose where to save it.' : '.'} No audio.`
    : 'This browser can’t encode MP4, so the video is recorded in real time as WebM. No audio.';
  if (!state.selected) exForm.range.value = exForm.range.value === 'finding' ? 'rallies' : exForm.range.value;
  $('#exProgressWrap').hidden = !ex.running;
  updateExportEstimate();
  $('#exportDlg').showModal();
});
exForm.addEventListener('change', updateExportEstimate);
$('#exClose').addEventListener('click', () => {
  if (ex.running) { ex.cancel = true; $('#exStatus').textContent = 'Stopping…'; return; }
  $('#exportDlg').close();
});
$('#exportDlg').addEventListener('cancel', e => { if (ex.running) e.preventDefault(); });

$('#exStart').addEventListener('click', async () => {
  const segs = exportSegments(exForm.range.value);
  if (!segs.length) return;
  const o = Object.fromEntries(['box', 'skel', 'court', 'ball', 'labels', 'minimap', 'hud', 'notes', 'coach'].map(k => [k, exForm[k].checked]));
  o.shot = o.hud;
  o.coachWho = $('#tCoachWho').value;
  const mp4 = canEncodeMp4();
  const suffix = { all: 'full', rallies: 'rallies', highlights: 'highlights', finding: 'clips' }[exForm.range.value];
  const name = `${state.match.name}-analysis-${suffix}.${mp4 ? 'mp4' : 'webm'}`.replace(/[\\/:*?"<>|]+/g, ' ');
  let handle = null;
  try { handle = await askSaveLocation(name, mp4); } catch (e) { if (e.name === 'AbortError') return; }
  ex.running = true; ex.cancel = false;
  $('#exStart').disabled = true; $('#exClose').textContent = 'Stop';
  $('#exProgressWrap').hidden = false;
  const t0 = performance.now();
  try {
    const { blob, ext } = await exportVideo({
      video, segments: segs, fps: +exForm.fps.value, height: +exForm.height.value, fileHandle: handle,
      draw: (ctx, w, h, t, seg) => drawExportFrame(ctx, w, h, t, seg, o),
      isCancelled: () => ex.cancel,
      onProgress: p => {
        const el = (performance.now() - t0) / 1000;
        $('#exBar').style.width = `${(p * 100).toFixed(1)}%`;
        $('#exStatus').textContent = `Rendering ${(p * 100).toFixed(0)}% · about ${fmtTime(el / Math.max(p, 1e-3) - el)} left`;
      },
    });
    const finalName = ext === 'mp4' ? name : name.replace(/\.mp4$/, '.webm');
    if (blob) download(finalName, blob); // fallback or no file picker
    $('#exStatus').textContent = ex.cancel ? 'Stopped — the part rendered so far was saved.' : `Saved ${finalName}${ext !== 'mp4' && handle ? ' (MP4 encoder unavailable — saved as WebM to Downloads)' : ''}.`;
    toast(ex.cancel ? 'Partial video saved.' : 'Analyzed video saved.');
  } catch (e) {
    console.error(e);
    $('#exStatus').textContent = `Export failed: ${e.message}`;
  }
  ex.running = false;
  $('#exClose').textContent = 'Close';
  updateExportEstimate();
});

function wrapText(ctx, text, maxW) {
  const words = text.split(' '), lines = [];
  let line = '';
  for (const wd of words) {
    const test = line ? `${line} ${wd}` : wd;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = wd; } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function panel(ctx, x, y, w, h) {
  ctx.fillStyle = 'rgba(17,18,20,0.78)';
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 8); ctx.fill();
}

/** One output frame for "Save analyzed video". */
function drawExportFrame(ctx, w, h, t, seg, o) {
  const { match, A, C } = state;
  ctx.drawImage(video, 0, 0, w, h);
  drawOverlayLayer(ctx, w, h, t, o);
  const u = h / 720; // UI scale
  const font = (px, wt = 500) => `${wt} ${Math.round(px * u)}px Inter, system-ui, sans-serif`;

  // rally & shot info (top-left)
  if (o.hud) {
    const r = A.rallies.find(x => t >= x.start && t <= x.end);
    const last = r ? r.shots.map(j => A.shots[j]).filter(s => s.t <= t + 0.05).pop() : null;
    const lines = [`${match.name} · ${fmtTime(t)}`];
    if (r) lines.push(`Rally ${r.index + 1} · shot ${last ? last.idx + 1 : 0}/${r.shots.length}${r.outcome?.winner ? ` · won by ${match.players.filter(p => p.team === r.outcome.winner).map(p => p.label).join(' & ')}` : ''}`);
    if (last) lines.push(`${match.players[last.slot].label}: ${last.type} (${last.fh ? 'FH' : 'BH'})`);
    ctx.font = font(15, 600);
    const bw = Math.max(...lines.map(l => ctx.measureText(l).width)) + 24 * u;
    panel(ctx, 12 * u, 12 * u, bw, (lines.length * 22 + 14) * u);
    lines.forEach((l, i) => {
      ctx.font = font(i ? 14 : 15, i ? 500 : 700);
      ctx.fillStyle = i ? '#c3c2b7' : '#f0efec';
      ctx.fillText(l, 24 * u, (34 + i * 22) * u);
    });
  }
  // segment title (top-centre)
  if (seg.label) { ctx.font = font(15, 600); drawLabel(ctx, seg.label, w / 2, 40 * u, '#199e70'); }

  // mini court map (bottom-right)
  if (o.minimap) {
    const mh = h * 0.42, mw = (mh * 32) / 60;
    const i = bisect(A.T, t);
    drawTopDownAt(ctx, w - mw - 12 * u, h - mh - 12 * u, mw, mh, match.players.map((p, k) => {
      const s = A.series[k], trail = [];
      for (let j = Math.max(0, i - 15); j <= i; j++) if (Number.isFinite(s.x[j])) trail.push([s.x[j], s.y[j]]);
      return { x: s.x[i], y: s.y[i], color: playerColor(match.players, k), label: p.label, trail };
    }));
  }

  // coach note (bottom-left): the finding whose clip covers this moment
  if (o.notes) {
    const f = seg.finding || C.findings.find(fd => fd.clips.some(c => t >= c.start && t <= c.end));
    if (f) {
      const maxW = Math.min(w * 0.5, 560 * u);
      ctx.font = font(13);
      const body = wrapText(ctx, `${f.lens === 'fix' ? 'Fix' : 'Exploit'}: ${f.counter}`, maxW - 24 * u).slice(0, 3);
      const bh = (46 + body.length * 18) * u;
      const y0 = h - bh - 12 * u;
      panel(ctx, 12 * u, y0, maxW, bh);
      ctx.fillStyle = f.severity === 'high' ? '#e66767' : f.severity === 'medium' ? '#c98500' : '#8f8e86';
      ctx.fillRect(12 * u, y0, 4 * u, bh);
      ctx.font = font(15, 700); ctx.fillStyle = '#f0efec';
      ctx.fillText(`${f.title} — ${f.who}`, 26 * u, y0 + 24 * u);
      ctx.font = font(13); ctx.fillStyle = '#c3c2b7';
      body.forEach((l, k) => ctx.fillText(l, 26 * u, y0 + (44 + k * 18) * u));
    }
  }
  ctx.font = font(11); ctx.fillStyle = 'rgba(240,239,236,0.55)';
  ctx.fillText('CourtSense', w - 80 * u, 22 * u);
}

// ---- keep the original video inside the app (IndexedDB)
async function refreshStoreButton() {
  const btn = $('#btnStoreVideo');
  if (!state.match) return;
  const stored = await hasVideo(state.match.id).catch(() => false);
  btn.textContent = stored ? '✓ Video kept in app' : 'Keep video in app';
  btn.title = stored ? 'Click to remove the stored copy and free space' : 'Store the video with this analysis so it reopens without re-attaching';
  btn.dataset.stored = stored ? '1' : '';
}
$('#btnStoreVideo').addEventListener('click', async () => {
  const btn = $('#btnStoreVideo');
  const id = state.match.id;
  if (btn.dataset.stored) {
    if (!confirm('Remove the stored copy of this video from the app? The analysis itself is kept.')) return;
    await deleteVideo(id); toast('Stored video removed.');
  } else {
    if (!state.file || !video.src) { toast('Attach the video first.'); return; }
    btn.disabled = true; btn.textContent = 'Saving video…';
    try { await saveVideo(id, state.file); toast('Video kept in the app.'); } catch (e) { toast(e.message, 5000); }
    btn.disabled = false;
  }
  refreshStoreButton();
});

$('#btnExportJson').addEventListener('click', () => {
  download(`${state.match.name}.courtsense.json`, new Blob([matchToJSON(state.match)], { type: 'application/json' }));
});

function videoReady() {
  if (!video.src || video.readyState < 1) { toast('Attach the video file first.'); return false; }
  return true;
}

// ---- player controls
const playBtn = $('#btnPlay');
playBtn.addEventListener('click', () => { if (!videoReady()) return; video.paused ? video.play() : video.pause(); });
video.addEventListener('play', () => { playBtn.textContent = '⏸'; });
video.addEventListener('pause', () => { playBtn.textContent = '▶'; });
const stepBy = dir => { if (!videoReady()) return; video.pause(); video.currentTime = clamp(video.currentTime + dir / (state.match.cfg.fps || 10), 0, video.duration); };
$('#btnBack').addEventListener('click', () => stepBy(-1));
$('#btnFwd').addEventListener('click', () => stepBy(1));
$$('.speed button').forEach(b => b.addEventListener('click', () => {
  video.playbackRate = +b.dataset.rate;
  $$('.speed button').forEach(x => x.classList.toggle('active', x === b));
}));
['#tBox', '#tSkel', '#tBall', '#tCourt', '#tLabels', '#tCoach', '#tCoachWho'].forEach(id => $(id).addEventListener('change', () => drawOverlayNow(true)));
$('#tCoachWho').addEventListener('change', () => { if (state.lens === 'callouts') renderFindings(); });

// seek bar, ±5 s, click the video to play/pause
const seek = $('#seek');
let seeking = false;
const jump = s => { if (!videoReady()) return; stopPlaylist(); video.currentTime = clamp(video.currentTime + s, 0, video.duration); };
$('#btnBack5').addEventListener('click', () => jump(-5));
$('#btnFwd5').addEventListener('click', () => jump(5));
seek.addEventListener('input', () => { if (!videoReady()) return; seeking = true; stopPlaylist(); video.currentTime = +seek.value; });
seek.addEventListener('change', () => { seeking = false; });
video.addEventListener('loadedmetadata', () => { seek.max = video.duration || 1; });
$('#playerWrap').addEventListener('click', e => {
  if (state.erase?.on || e.target.closest('canvas.painting')) return;
  playBtn.click();
});
function syncSeek() {
  if (seeking || !video.duration) return;
  if (+seek.max !== video.duration) seek.max = video.duration;
  seek.value = video.currentTime;
  seek.style.setProperty('--p', `${(video.currentTime / video.duration) * 100}%`);
  // highlight the coach comments on screen right now
  if (state.lens === 'callouts') {
    const t = video.currentTime;
    $$('#findings .callout-item').forEach(b => b.classList.toggle('now', t >= +b.dataset.t && t <= +b.dataset.t1));
  }
}
document.addEventListener('keydown', e => {
  if (state.view !== 'analysis' || !state.match || e.target.closest('input,select,textarea,dialog')) return;
  if (e.code === 'Space') { e.preventDefault(); playBtn.click(); }
  if (e.code === 'ArrowLeft') stepBy(-1);
  if (e.code === 'ArrowRight') stepBy(1);
  if (e.code === 'KeyJ') jump(-5);
  if (e.code === 'KeyL') jump(5);
});

// ---- overlay drawing
function calibrationAt(t) {
  const S = state.match.samples, T = state.A.T;
  const i = bisect(T, t), a = S[i], b = S[i + 1];
  if (!a?.c && !b?.c) return state.match.cal;
  const ca = a?.c || b.c, cb = b?.c || ca;
  const f = a && b && b.t > a.t ? clamp((t - a.t) / (b.t - a.t), 0, 1) : 0;
  try { return makeCalibration(ca.map((p, j) => [p[0] + (cb[j][0] - p[0]) * f, p[1] + (cb[j][1] - p[1]) * f])); }
  catch { return state.match.cal; }
}

function poseAt(k, t) {
  const S = state.match.samples, T = state.A.T;
  const i = bisect(T, t);
  const a = S[i], b = S[i + 1];
  const pa = a?.p[k], pb = b?.p[k];
  if (pa && pb && b.t - a.t < 0.5 && t >= a.t) {
    const f = clamp((t - a.t) / (b.t - a.t), 0, 1);
    const lm = new Float32Array(pa.lm.length);
    for (let j = 0; j < lm.length; j++) lm[j] = pa.lm[j] + (pb.lm[j] - pa.lm[j]) * f;
    return { lm, cx: pa.cx + (pb.cx - pa.cx) * f, cy: pa.cy + (pb.cy - pa.cy) * f };
  }
  const near = [a, b].filter(s => s?.p[k] && Math.abs(s.t - t) < 0.3).sort((x, y) => Math.abs(x.t - t) - Math.abs(y.t - t))[0];
  return near ? near.p[k] : null;
}

const viewOverlayOpts = () => ({ box: $('#tBox').checked, court: $('#tCourt').checked, skel: $('#tSkel').checked, labels: $('#tLabels').checked, ball: $('#tBall').checked, shot: true, coach: $('#tCoach').checked, coachWho: $('#tCoachWho').value });

/** Team filter for coach callouts: 'all' | 'mine' | 'opp' -> 'all' | 'A' | 'B'. */
function calloutTeam(who) {
  const mine = state.match.cfg.myTeam || 'A';
  return who === 'mine' ? mine : who === 'opp' ? (mine === 'A' ? 'B' : 'A') : 'all';
}

function drawOverlayLayer(ctx, w, h, t, o = viewOverlayOpts()) {
  const { match, A } = state;
  if (o.court) drawCourtOverlay(ctx, calibrationAt(t), w, h);
  const lw = Math.max(2, w / 500);
  match.players.forEach((p, k) => {
    const pose = poseAt(k, t);
    if (!pose) return;
    const color = playerColor(match.players, k);
    const box = o.box ? drawPlayerBox(ctx, pose.lm, w, h, color, lw) : null;
    if (o.skel) { drawSkeleton(ctx, pose.lm, w, h, color, lw); drawPaddleHand(ctx, pose.lm, w, h, A.handed[k], color); }
    if (o.labels || box) {
      const nx = box ? box.x + box.w / 2 : pose.lm[L.nose * 3] * w, ny = box ? box.y + 2 : pose.lm[L.nose * 3 + 1] * h;
      if (!o.labels) { drawLabel(ctx, p.label, nx, ny - 8, color); return; }
      const zone = Number.isFinite(pose.cy) ? ` · ${fmt(Math.max(0, distToNet(pose.cy) - 7), 0)} ft to NVZ` : '';
      drawLabel(ctx, `${p.label}${zone}`, nx, ny - 8, color);
    }
  });
  // Shot flash and compact game-review rating. Keep the rating visible just
  // after contact so it can be read without covering the play.
  const rv = o.shot && state.R?.review
    ? state.R.review.filter(x => t >= x.t - 0.15 && t <= x.t + 0.85).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0]
    : null;
  const sh = rv ? A.shots[rv.j] : (o.shot ? A.shots.find(s => Math.abs(s.t - t) < 0.2) : null);
  if (sh) {
    const pose = poseAt(sh.slot, sh.t);
    if (pose) {
      const wi = sh.wrist === 1 ? L.rw : L.lw;
      const x = pose.lm[wi * 3] * w, y = pose.lm[wi * 3 + 1] * h;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 16, 0, Math.PI * 2); ctx.stroke();
      const fontSize = Math.max(10, Math.min(13, Math.round(w / 105)));
      ctx.font = `600 ${fontSize}px Inter, system-ui`; ctx.fillStyle = '#fff';
      ctx.fillText(`${sh.type} · ${sh.fh ? 'FH' : 'BH'}`, x + 20, y + 2);
      if (rv) {
        const c = clsInfo(rv.cls);
        const label = `${c.sym} ${c.name}`;
        ctx.font = `700 ${fontSize}px Inter, system-ui`;
        const tw = ctx.measureText(label).width;
        const bx = Math.max(4, Math.min(w - tw - 18, x + 18));
        const by = Math.max(fontSize + 7, Math.min(h - 6, y + fontSize + 9));
        ctx.fillStyle = 'rgba(17,18,20,0.84)';
        ctx.beginPath(); ctx.roundRect(bx, by - fontSize - 5, tw + 14, fontSize + 9, 4); ctx.fill();
        ctx.fillStyle = c.color;
        ctx.fillText(label, bx + 7, by - 3);
      }
    }
  }
  // ball trail
  if (o.ball) {
    const S = match.samples, T = A.T;
    const i = bisect(T, t);
    for (let j = Math.max(0, i - 4); j <= i; j++) {
      const b = S[j]?.b;
      if (!b || t - S[j].t > 0.5) continue;
      ctx.globalAlpha = 0.3 + 0.7 * (1 - (i - j) / 5);
      ctx.fillStyle = BALL_COLOR;
      ctx.beginPath(); ctx.arc(b[0] * w, b[1] * h, Math.max(3, w / 300), 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  // coach callouts: speech bubbles above the player
  if (o.coach && state.CO?.length) {
    const act = activeCallouts(state.CO, t, match.players, calloutTeam(o.coachWho || 'all'));
    drawCallouts(ctx, w, h, t, act, k => { const p = poseAt(k, t); return p ? headFromPose(p.lm, w, h) : null; }, match.players, playerColor);
  }
}

let lastDrawT = -1;
function drawOverlayNow(force = false) {
  if (!state.match || state.view !== 'analysis') return;
  const t = video.src ? video.currentTime : state.A.T[0];
  if (!force && t === lastDrawT) return;
  lastDrawT = t;
  const oc = $('#overlay');
  const { ctx, w, h } = fitCanvas(oc);
  ctx.clearRect(0, 0, w, h);
  if (!video.src) { ctx.fillStyle = '#111'; ctx.fillRect(0, 0, w, h); }
  drawOverlayLayer(ctx, w, h, t);
  if (state.erase.on) {
    drawMask(ctx, state.erase.grid, w, h);
    const hv = state.erase.hover;
    if (hv) { ctx.strokeStyle = state.erase.tool === 'erase' ? '#e34948' : '#f0efec'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(hv[0] * w, hv[1] * h, (+document.getElementById('eBrush').value / 100) * w, 0, Math.PI * 2); ctx.stroke(); }
  }
  $('#timeLabel').textContent = `${fmtTime(t)} / ${fmtTime(video.duration || state.match.video.duration)}`;
  drawTimelineNow(t);
  drawTopDownNow(t);
}

function drawTopDownNow(t) {
  const { match, A } = state;
  const i = bisect(A.T, t);
  drawTopDown($('#topdown'), match.players.map((p, k) => {
    const s = A.series[k];
    const trail = [];
    for (let j = Math.max(0, i - 15); j <= i; j++) if (Number.isFinite(s.x[j])) trail.push([s.x[j], s.y[j]]);
    return { x: s.x[i], y: s.y[i], color: playerColor(match.players, k), label: p.label, trail };
  }));
}

function drawTimelineNow(t = video.currentTime) {
  if (!state.match) return;
  const { A, match } = state;
  const f = state.C.findings.find(x => x.id === state.selected);
  drawTimeline($('#timeline'), {
    t0: A.T[0], t1: A.T[A.N - 1], rallies: A.rallies, shots: A.shots, players: match.players,
    current: t, marks: f ? f.clips.map(c => c.start + 2.5) : [], outcomeColor: w => TEAM_COLORS[w],
  });
}

const tl = $('#timeline');
const tlTime = e => { const r = tl.getBoundingClientRect(); const { A } = state; return A.T[0] + ((e.clientX - r.left) / r.width) * (A.T[A.N - 1] - A.T[0]); };
const tlShot = e => {
  const r = tl.getBoundingClientRect(); const t = tlTime(e);
  const tol = 5 / r.width * (state.A.T[state.A.N - 1] - state.A.T[0]);
  let best = null, bd = tol;
  for (const s of state.A.shots) { const d = Math.abs(s.t - t); if (d < bd) { bd = d; best = s; } }
  return best;
};
tl.addEventListener('click', e => {
  if (!state.match) return;
  stopPlaylist();
  const sh = tlShot(e);
  if (sh) { selectShot(sh); return; }
  if (video.src) video.currentTime = tlTime(e);
});
tl.addEventListener('mousemove', e => {
  if (!state.match) return;
  const tip = $('#tlTip'); const sh = tlShot(e); const t = tlTime(e);
  const r = state.A.rallies.find(x => t >= x.start && t <= x.end);
  const p = sh ? state.match.players[sh.slot].label : '';
  tip.innerHTML = sh ? `<b>${esc(sh.type)}</b> · ${esc(p)} · ${sh.fh ? 'forehand' : 'backhand'} · ${fmtTime(sh.t)}` : r ? `Rally ${r.index + 1} · ${r.shots.length} shots · ${fmtTime(t)}` : fmtTime(t);
  tip.style.display = 'block';
  tip.style.left = Math.min(tl.clientWidth - 200, e.offsetX + 10) + 'px';
  tip.style.top = '-30px';
});
tl.addEventListener('mouseleave', () => { $('#tlTip').style.display = 'none'; });

// ---- shot inspector
function selectShot(sh) {
  state.shot = sh;
  if (video.src) { video.pause(); seekVideo(video, sh.t); }
  renderShotInspector();
}
function renderShotInspector() {
  const sh = state.shot, el = $('#shotInspector'), cv = $('#angleChart');
  if (!sh || !state.match) { el.innerHTML = 'Click a shot tick on the timeline or a shot in the Shots tab.'; drawLineChart(cv, $('#angleTip'), { series: [] }); return; }
  const { A, match } = state;
  const s = A.series[sh.slot];
  const hand = A.handed[sh.slot];
  const i = sh.i;
  const elbow = hand === 'R' ? s.elbowR : s.elbowL;
  const dy = hand === 'R' ? s.dyR[i] : s.dyL[i];
  el.innerHTML = `
    <table>
      <tr><th>Player</th><td>${esc(match.players[sh.slot].label)} (${hand === 'R' ? 'right' : 'left'}-handed)</td></tr>
      <tr><th>Shot</th><td>${esc(sh.type)} · ${sh.fh ? 'forehand' : 'backhand'} · rally ${sh.rally + 1}, shot ${sh.idx + 1}</td></tr>
      <tr><th>Position</th><td>${esc(sh.zone)} · ${fmt(Math.max(0, sh.d - 7), 1)} ft behind NVZ line</td></tr>
      <tr><th>At contact</th><td>knee ${fmt(s.knee[i], 0)}° · elbow ${fmt(elbow[i], 0)}° · paddle ${dy > 0.05 ? 'below' : 'above'} hips · reach ${fmt(sh.reach, 1)}× shoulders</td></tr>
      <tr><th>Swing speed</th><td>${fmt(sh.speed, 1)} torso-lengths/s (${fmt(sh.rel, 2)}× their median)</td></tr>
      ${(() => {
        const rv = state.R.review.find(x => x.j === A.shots.indexOf(sh));
        if (!rv) return '';
        const c = clsInfo(rv.cls);
        return `<tr><th>Rating</th><td>${symHtml(c)}<b>${c.name}</b> · ${rv.score}/100
          <ul class="why">${rv.why.map(w => `<li class="${w.d >= 0 ? 'pos' : 'neg'}">${w.d >= 0 ? '+' : ''}${w.d} ${esc(w.text)}</li>`).join('') || '<li>Neutral shot</li>'}</ul></td></tr>`;
      })()}
    </table>`;
  const T = A.T;
  const lo = bisect(T, sh.t - 1.5), hi = bisect(T, sh.t + 1.5);
  const idx = []; for (let j = lo; j <= hi; j++) idx.push(j);
  drawLineChart(cv, $('#angleTip'), {
    series: [
      { label: 'Knee angle', color: '#3987e5', values: idx.map(j => s.knee[j]) },
      { label: 'Elbow angle', color: '#d95926', values: idx.map(j => elbow[j]) },
    ],
    xLabels: idx.map(j => `${(T[j] - sh.t).toFixed(1)} s`),
    yFmt: v => `${v.toFixed(0)}°`,
    markerX: idx.indexOf(i),
  });
}

// ---- heatmap
function renderHeatSelect() {
  const sel = $('#heatPlayer');
  const cur = sel.value;
  sel.innerHTML = state.match.players.map((p, k) => `<option value="${k}">${esc(p.label)}</option>`).join('');
  if (cur && +cur < state.match.players.length) sel.value = cur;
}
function renderHeatmap() {
  const { A, match } = state;
  const k = +$('#heatPlayer').value || 0;
  const mode = $('#heatMode').value;
  const s = A.series[k];
  let pts;
  if (mode === 'pos') { pts = []; for (let i = 0; i < A.N; i++) if (A.inRally[i] >= 0 && Number.isFinite(s.x[i])) pts.push([s.x[i], s.y[i]]); }
  else pts = A.shots.filter(sh => sh.slot === k).map(sh => [sh.cx, sh.cy]);
  drawHeatmap($('#heatmap'), pts, playerColor(match.players, k));
}
$('#heatPlayer').addEventListener('change', renderHeatmap);
$('#heatMode').addEventListener('change', renderHeatmap);

// ---- stats tabs
$('#statTabs').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  state.statTab = b.dataset.tab;
  $$('#statTabs button').forEach(x => x.classList.toggle('active', x === b));
  renderStats();
});

function zoneBar(z) {
  return `<div class="bar" title="kitchen ${fmtPct(z.kitchen)} · transition ${fmtPct(z.transition)} · baseline ${fmtPct(z.baseline)}">
    <span style="width:${z.kitchen * 100}%;background:#199e70"></span><span style="width:${z.transition * 100}%;background:#c98500"></span><span style="width:${z.baseline * 100}%;background:#8f8e86"></span></div>`;
}

function renderStats() {
  const { A, match } = state;
  const P = match.players;
  const head = `<tr><th>Metric</th>${P.map((p, k) => `<th class="num"><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${playerColor(P, k)};margin-right:4px"></i>${esc(p.label)}</th>`).join('')}</tr>`;
  const row = (label, f) => `<tr><td>${label}</td>${A.metrics.map((m, k) => `<td class="num">${f(m, k)}</td>`).join('')}</tr>`;
  let html = '';
  const tab = state.statTab;
  if (tab === 'overview') {
    html = `<table>${head}
      ${row('Tracking coverage (rally time)', m => fmtPct(m.coverage))}
      ${row('Pose confidence', m => fmtPct(m.conf))}
      ${row('Shots detected', m => m.shots)}
      ${row('Distance covered', m => `${fmt(m.distance, 0)} ft`)}
      ${row('Avg / max speed', m => `${fmt(m.avgSpeed, 1)} / ${fmt(m.maxSpeed, 1)} ft/s`)}
      ${row('Zones <span class="muted small">(kitchen · transition · baseline)</span>', m => zoneBar(m.zone))}
      ${row('Kitchen / transition / baseline', m => `${fmtPct(m.zone.kitchen)} · ${fmtPct(m.zone.transition)} · ${fmtPct(m.zone.baseline)}`)}
    </table>
    <p class="muted small">Zones: kitchen = within 3 ft behind the NVZ line or closer; transition = 10–18 ft from the net; baseline = deeper.</p>`;
  } else if (tab === 'shots') {
    const types = [...new Set(A.shots.map(s => s.type))];
    html = `<table>${head}
      ${types.map(t => row(esc(t), m => m.shotTypes[t] || 0)).join('')}
      ${row('Forehand / backhand', m => `${m.fh} / ${m.bh}`)}
      ${row('Handedness (detected)', (m, k) => (A.handed[k] === 'R' ? 'right' : 'left'))}
    </table>
    <h3>All shots</h3>
    <div style="max-height:260px;overflow:auto"><table><tr><th>Time</th><th>Player</th><th>Type</th><th>Side</th><th>Zone</th><th>Rally</th></tr>
      ${A.shots.map((s, j) => `<tr class="shot-row" data-j="${j}" style="cursor:pointer"><td class="mono">${fmtTime(s.t)}</td><td>${esc(P[s.slot].label)}</td><td>${esc(s.type)}</td><td>${s.fh ? 'FH' : 'BH'}</td><td>${s.zone}</td><td>${s.rally + 1}</td></tr>`).join('')}
    </table></div>
    <p class="muted small">Shots are detected from wrist-swing peaks in the pose data and alternated between teams. Adjust sensitivity in “Players & settings”.</p>`;
  } else if (tab === 'movement') {
    html = `<table>${head}
      ${row('Kitchen arrival after return (median)', m => `${fmt(median(m.arrivalReturn.map(e => e.dt)), 1)} s <span class="muted">n=${m.arrivalReturn.length}</span>`)}
      ${row('Kitchen arrival after 3rd shot (median)', m => `${fmt(median(m.arrivalThird.map(e => e.dt)), 1)} s <span class="muted">n=${m.arrivalThird.length}</span>`)}
      ${row('First-step reaction', m => `${fmt(m.reactionAvg, 2)} s <span class="muted">n=${m.reaction.length}</span>`)}
      ${row('Split step on time', m => `${fmtPct(m.splitOnPct)} <span class="muted">n=${m.splitN}</span>`)}
      ${row('Paddle below hips (at kitchen)', m => fmtPct(m.paddleLowPct))}
      ${row('Standing tall (knee > 165°)', m => fmtPct(m.tallPct))}
      ${row('Avg knee angle at kitchen', m => `${fmt(m.kneeAvg, 0)}°`)}
      ${row('Stance width', m => `${fmt(m.stanceAvg, 2)}× shoulders`)}
      ${row('Distance behind NVZ when up', m => `${fmt(m.kitchenDepth - 7, 1)} ft`)}
      ${row('Reaching shots', m => m.overreach.length)}
      ${row('Speed 1st half → 2nd half', m => `${fmt(m.fatigue.speed1, 1)} → ${fmt(m.fatigue.speed2, 1)} ft/s`)}
    </table>`;
  } else if (tab === 'team') {
    const teams = ['A', 'B'];
    const name = tm => P.filter(p => p.team === tm).map(p => esc(p.label)).join(' & ') + ` <span class="muted">(${tm === 'A' ? 'near' : 'far'})</span>`;
    const trow = (label, f) => `<tr><td>${label}</td>${teams.map(tm => `<td class="num">${f(A.team[tm])}</td>`).join('')}</tr>`;
    html = `<table><tr><th>Metric</th>${teams.map(tm => `<th class="num">${name(tm)}</th>`).join('')}</tr>
      ${trow('Rallies won / lost (labeled)', t => `${t.won} / ${t.lost}`)}
      ${trow('Won when serving', t => `${t.servedWon}/${t.servedN}`)}
      ${trow('Won when receiving', t => `${t.recvWon}/${t.recvN}`)}
      ${match.cfg.format === 'doubles' ? trow('Partners > 12 ft apart (both at kitchen)', t => fmtPct(t.gapPct)) + trow('Both on the same half', t => fmtPct(t.middleOpenPct)) : ''}
    </table>`;
  } else if (tab === 'rallies') {
    const opt = (v, cur, label) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
    html = `<p class="muted small">Label who won each rally and how it ended — this unlocks error analysis and ranks findings by points lost. Saved automatically.</p>
    <div style="max-height:380px;overflow:auto"><table><tr><th>#</th><th>Time</th><th>Shots</th><th>Server</th><th>Winner</th><th>Ended by</th><th>Player</th><th></th></tr>
    ${A.rallies.map(r => {
      const o = r.outcome || {};
      return `<tr class="rally-row" data-rid="${r.id}">
        <td>${r.index + 1}</td><td class="mono">${fmtTime(r.start)}</td><td>${r.shots.length}</td><td>${esc(P[r.serverSlot].label)}</td>
        <td><select data-f="winner">${opt('', o.winner || '', '–')}${opt('A', o.winner, 'Near team')}${opt('B', o.winner, 'Far team')}</select></td>
        <td><select data-f="how">${opt('', o.how || '', '–')}${opt('winner', o.how, 'Winner')}${opt('error', o.how, 'Error')}</select></td>
        <td><select data-f="by">${opt('-1', String(o.by ?? -1), '–')}${P.map((p, k) => opt(String(k), String(o.by ?? -1), esc(p.label))).join('')}</select></td>
        <td><button class="btn small ghost" data-play="${r.index}">▶</button></td></tr>`;
    }).join('')}</table></div>`;
  }
  $('#statBody').innerHTML = html;
}

$('#statBody').addEventListener('click', e => {
  const sr = e.target.closest('.shot-row');
  if (sr) { selectShot(state.A.shots[+sr.dataset.j]); return; }
  const pb = e.target.closest('[data-play]');
  if (pb) { const r = state.A.rallies[+pb.dataset.play]; startPlaylist([{ start: r.start, end: r.end, label: `Rally ${r.index + 1}` }]); }
});
let saveTimer = null;
$('#statBody').addEventListener('change', e => {
  const tr = e.target.closest('.rally-row'); if (!tr) return;
  const rid = tr.dataset.rid;
  const o = state.match.outcomes[rid] || { winner: '', how: '', by: -1 };
  const f = e.target.dataset.f;
  o[f] = f === 'by' ? +e.target.value : e.target.value;
  // auto-fill winner from an error/winner by a player
  if ((f === 'by' || f === 'how') && o.by >= 0 && o.how) {
    const team = state.match.players[o.by].team;
    o.winner = o.how === 'winner' ? team : team === 'A' ? 'B' : 'A';
    tr.querySelector('[data-f=winner]').value = o.winner;
  }
  state.match.outcomes[rid] = o;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    recompute();
    $('#coachSummary').innerHTML = state.C.summary;
    renderFindings(); renderReview(); drawTimelineNow();
    persist();
  }, 400);
});

// ---- settings dialog
$('#btnSettings').addEventListener('click', () => {
  const { match } = state;
  const P = match.players;
  $('#playerEdit').innerHTML = `
    <label>Skill level <select name="skill">${['3.0', '3.5', '4.0', '4.5'].map(s => `<option ${s === match.cfg.skill ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
    <label>Your team <select name="myTeam"><option value="A" ${match.cfg.myTeam === 'A' ? 'selected' : ''}>Near side</option><option value="B" ${match.cfg.myTeam === 'B' ? 'selected' : ''}>Far side</option></select></label>
    <h3>Players <span class="muted small">(name · “me”)</span></h3>
    ${P.map((p, k) => `<div class="player-edit-row"><i style="background:${playerColor(P, k)}"></i>
      <input name="label${k}" value="${esc(p.label)}">
      <select name="hand${k}" title="Paddle hand"><option value="">Hand: auto (${state.A.handed[k] === "L" ? "left" : "right"})</option><option value="R" ${p.hand === "R" ? "selected" : ""}>Right hand</option><option value="L" ${p.hand === "L" ? "selected" : ""}>Left hand</option></select>
      <label class="check"><input type="radio" name="me" value="${k}" ${p.isMe ? 'checked' : ''}> me</label></div>`).join('')}
    <button type="button" class="btn small ghost" id="swapBtn">Swap names within each team</button>
    <h3>Fix an identity switch <span class="muted small">(tracker swapped two players)</span></h3>
    <p class="muted small">Pause the video at the moment the labels jumped to the wrong person, then swap from that time onward.</p>
    <div class="actions">${['A', 'B'].map(tm => {
      const ks = P.map((p, k) => (p.team === tm ? k : -1)).filter(k => k >= 0);
      return ks.length === 2 ? `<button type="button" class="btn small ghost" data-swapfrom="${ks.join(',')}">Swap ${esc(P[ks[0]].label)} ↔ ${esc(P[ks[1]].label)} from ${fmtTime(video.currentTime || 0)}</button>` : '';
    }).join('')}</div>
    ${match.cfg.ballCal ? `<p class="muted small">Ball calibration: hue ${match.cfg.ballCal.h.toFixed(0)}° ± ${match.cfg.ballCal.tolH.toFixed(0)}°, ${match.cfg.ballCal.d.toFixed(0)} px, ${match.cfg.ballCal.n} sample(s).</p>` : ''}`;
  $$('[data-swapfrom]').forEach(b => {
    b.onclick = () => {
      const [a, c] = b.dataset.swapfrom.split(',').map(Number);
      const t0 = video.currentTime || 0;
      let n = 0;
      for (const s of match.samples) if (s.t >= t0) { [s.p[a], s.p[c]] = [s.p[c], s.p[a]]; n++; }
      recompute(); renderAnalysis(); persist();
      toast(`Swapped ${P[a].label} ↔ ${P[c].label} for ${n} frames from ${fmtTime(t0)}.`);
      $('#settingsDlg').close('cancel');
    };
  });
  const form = $('#settingsForm');
  form.sensitivity.value = match.cfg.sensitivity ?? 3.5;
  $('#sensVal').textContent = form.sensitivity.value;
  $('#swapBtn').onclick = () => {
    for (const tm of ['A', 'B']) {
      const ks = P.map((p, k) => (p.team === tm ? k : -1)).filter(k => k >= 0);
      if (ks.length === 2) { const a = form[`label${ks[0]}`], b = form[`label${ks[1]}`]; [a.value, b.value] = [b.value, a.value]; }
    }
  };
  $('#settingsDlg').showModal();
});
$('#settingsForm').sensitivity.addEventListener('input', e => { $('#sensVal').textContent = e.target.value; });
$('#settingsDlg').addEventListener('close', () => {
  if ($('#settingsDlg').returnValue !== 'save') return;
  const form = $('#settingsForm');
  const { match } = state;
  match.players.forEach((p, k) => { p.label = form[`label${k}`].value || p.label; p.isMe = form.me.value === String(k); p.hand = form[`hand${k}`].value || null; });
  match.cfg.skill = form.skill.value;
  match.cfg.myTeam = form.myTeam.value;
  match.cfg.sensitivity = +form.sensitivity.value;
  recompute();
  renderAnalysis();
  persist();
  toast('Saved.');
});

// ------------------------------------------------------------------ render loop
function loop() {
  requestAnimationFrame(loop);
  if (state.view !== 'analysis' || !state.match) return;
  drawOverlayNow();
  syncSeek();
  const pl = state.playlist;
  if (pl && !video.paused && video.currentTime >= pl.clips[pl.i].end) {
    if (pl.i < pl.clips.length - 1) { pl.i++; playClip(); } else { video.pause(); stopPlaylist(); }
  }
}
requestAnimationFrame(loop);
window.addEventListener('resize', () => { if (state.match && state.view === 'analysis') { drawOverlayNow(true); renderHeatmap(); renderShotInspector(); } });

// ------------------------------------------------------------------ dashboard
async function renderDashboard() {
  state.summaries = await listSummaries().catch(() => []);
  const S = state.summaries;
  const ml = $('#matchList');
  ml.innerHTML = S.length ? S.map(s => `
    <div class="match-card">
      <b>${esc(s.name)}</b>
      <span class="muted small">${new Date(s.createdAt).toLocaleDateString()} · ${s.format} · ${s.skill} · ${fmtTime(s.duration)}</span>
      <span class="small">${s.rallies} rallies · ${s.shots} shots</span>
      ${s.topFix[0] ? `<span class="small">Top fix: ${esc(s.topFix[0].title)}</span>` : ''}
      <div class="actions"><button class="btn small primary" data-open="${s.id}">Open</button><button class="btn small ghost" data-del="${s.id}">Delete</button></div>
    </div>`).join('') : '<p class="muted">No matches yet. Click “Analyze a match” to start.</p>';

  const fa = $('#focusAreas');
  const latest = S[0];
  fa.innerHTML = latest?.topFix?.length ? latest.topFix.map((f, i) => `
    <div class="focus-item"><div class="focus-num">${i + 1}</div><div>
      <b>${esc(f.title)}</b> <span class="chip sev-${f.severity}">${f.severity}</span><br>
      <span class="muted small">${esc(f.who)} · ${esc(f.evidence)}</span><br>
      ${f.drill ? `<a href="#" data-drill="${f.drill}" class="small">Drill: ${esc(DRILLS[f.drill].name)}</a>` : ''}
    </div></div>`).join('') : latest ? '<p class="muted">No issues above target in your latest match. Nice.</p>' : '<p class="muted">No matches analyzed yet.</p>';

  const sel = $('#trendMetric');
  if (!sel.options.length) sel.innerHTML = KEY_METRICS.map(k => `<option value="${k.id}">${k.label}</option>`).join('');
  renderTrend();
}
function renderTrend() {
  const S = [...state.summaries].sort((a, b) => a.createdAt - b.createdAt);
  const km = KEY_METRICS.find(k => k.id === $('#trendMetric').value) || KEY_METRICS[0];
  drawLineChart($('#trendChart'), $('#trendTip'), {
    series: [{ label: km.label, color: '#3987e5', values: S.map(s => s.key?.[km.id]), markers: true }],
    xLabels: S.map(s => new Date(s.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })),
    yFmt: v => km.f(v),
  });
  $('#trendNote').textContent = S.length < 2 ? 'Analyze more matches to see your progress.' : `${km.better === 'lower' ? 'Lower' : km.better === 'higher' ? 'Higher' : 'Neither direction'} is better. Player marked “me” in each match.`;
}
$('#trendMetric').addEventListener('change', renderTrend);
$('#matchList').addEventListener('click', async e => {
  const o = e.target.closest('[data-open]'), d = e.target.closest('[data-del]');
  if (o) {
    const m = await getMatch(o.dataset.open);
    if (!m) { toast('Match not found.'); return; }
    await openMatch(m);
    show('analysis');
  }
  if (d && confirm('Delete this analysis? This cannot be undone.')) {
    await deleteMatch(d.dataset.del);
    if (state.match?.id === d.dataset.del) { state.match = null; }
    renderDashboard();
  }
});
$('#focusAreas').addEventListener('click', e => {
  const a = e.target.closest('[data-drill]'); if (!a) return;
  e.preventDefault(); state.drillHighlight = a.dataset.drill; show('drills');
});
$('#importJson').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const m = matchFromJSON(await f.text());
    if (!m.samples || !m.cal) throw new Error('Not a CourtSense analysis file');
    await openMatch(m, true);
    toast('Imported.');
    show('analysis');
  } catch (err) { toast('Import failed: ' + err.message); }
  e.target.value = '';
});

// ------------------------------------------------------------------ report
function renderReport() {
  const el = $('#reportBody');
  if (!state.match) { el.innerHTML = '<div class="card empty">Open a match first.</div>'; return; }
  const { match, A, C } = state;
  const P = match.players;
  const fix = C.findings.filter(f => f.lens === 'fix');
  const exp = C.findings.filter(f => f.lens === 'exploit');
  const fcard = f => `<div class="finding sev-${f.severity}"><div class="f-head"><span class="f-title">${esc(f.title)} — ${esc(f.who)}</span><span class="chip sev-${f.severity}">${f.severity}</span></div>
    <div class="f-evidence">${esc(f.evidence)}${f.impact ? ` · in ${fmtPct(f.impact.share)} of lost points` : ''}</div><p>${esc(f.problem)}</p><p><b>${f.lens === 'fix' ? 'Fix' : 'Exploit'}:</b> ${esc(f.counter)}</p>
    ${f.lens === 'fix' ? `<p class="small muted">Drills: ${f.drills.map(d => esc(DRILLS[d].name)).join(', ')}</p>` : ''}</div>`;
  const me = meSlot(match);
  const plan = buildPlan(C, match);
  el.innerHTML = `
    <div class="card">
      <h1>${esc(match.name)}</h1>
      <p class="muted">${new Date(match.createdAt).toLocaleString()} · ${match.cfg.format} · level ${match.cfg.skill} · ${P.map(p => esc(p.label)).join(', ')}</p>
      <div class="kpis">
        <div class="kpi"><b>${A.rallies.length}</b><span>rallies</span></div>
        <div class="kpi"><b>${A.shots.length}</b><span>shots</span></div>
        <div class="kpi"><b>${fmtTime(A.duration)}</b><span>analyzed</span></div>
        <div class="kpi"><b>${C.labeled}</b><span>rallies labeled</span></div>
        ${me >= 0 ? KEY_METRICS.slice(0, 4).map(k => `<div class="kpi"><b>${k.f(k.get(A.metrics[me]))}</b><span>${esc(k.label)} (${esc(P[me].label)})</span></div>`).join('') : ''}
      </div>
      <h2>Game review — accuracy</h2>
      <table><tr><th></th>${P.map(p => `<th class="num">${esc(p.label)}</th>`).join('')}</tr>
        <tr><td><b>Accuracy</b></td>${state.R.perPlayer.map(pp => `<td class="num"><b>${Number.isFinite(pp.accuracy) ? pp.accuracy.toFixed(1) + '%' : '–'}</b></td>`).join('')}</tr>
        ${CLASSES.map(c => `<tr><td>${symHtml(c)}${c.name}</td>${state.R.perPlayer.map(pp => `<td class="num">${pp.counts[c.id]}</td>`).join('')}</tr>`).join('')}
        ${PHASES.map(ph => `<tr><td class="muted">${ph.name}</td>${state.R.perPlayer.map(pp => `<td class="num muted">${Number.isFinite(pp.byPhase[ph.id]) ? pp.byPhase[ph.id].toFixed(0) + '%' : '–'}</td>`).join('')}</tr>`).join('')}
      </table>
      <h2>Coach summary</h2><p>${C.summary}</p>
      <h2>Fix my game</h2>${fix.slice(0, 6).map(fcard).join('') || '<p class="muted">Nothing above target.</p>'}
      <h2>Opportunities against the opponents</h2>${exp.slice(0, 6).map(fcard).join('') || '<p class="muted">No clear weaknesses detected.</p>'}
      <h2>Strengths</h2><p>${C.strengths.map(s => esc(`${s.who}: ${s.title.toLowerCase()} better than target`)).join(' · ') || '<span class="muted">—</span>'}</p>
      <h2>Movement metrics</h2>
      <table><tr><th>Metric</th>${P.map(p => `<th class="num">${esc(p.label)}</th>`).join('')}</tr>
        ${KEY_METRICS.map(k => `<tr><td>${esc(k.label)}</td>${A.metrics.map(m => `<td class="num">${k.f(k.get(m))}</td>`).join('')}</tr>`).join('')}
      </table>
      <h2>This week’s plan</h2>
      <ul>${plan.days.map(d => `<li><b>${esc(d.title)}</b>: ${d.items.map(i => esc(i.name)).join(', ')}${d.note ? ` — <span class="muted">${esc(d.note)}</span>` : ''}</li>`).join('')}</ul>
      <p class="muted small">Generated by CourtSense from single-camera pose estimation. Metrics are estimates; confidence and sample size (n) are shown for each finding.</p>
    </div>`;
}

// ------------------------------------------------------------------ plan
function renderPlan() {
  const el = $('#planBody');
  if (!state.match) { el.innerHTML = '<div class="card empty">Open a match first — the plan is built from your top findings.</div>'; return; }
  const plan = buildPlan(state.C, state.match);
  el.innerHTML = `
    <div class="card"><h2>Built from</h2>${plan.focus.length ? plan.focus.map((f, i) => `<div class="focus-item"><div class="focus-num">${i + 1}</div><div><b>${esc(f.title)}</b> · ${esc(f.who)}<br><span class="muted small">${esc(f.evidence)}</span></div></div>`).join('') : '<p class="muted">No issues above target — a general maintenance plan is shown.</p>'}</div>
    <div class="plan-grid">${plan.days.map(d => `
      <div class="day ${d.title.includes('Rest') ? 'rest' : ''}"><h3>${esc(d.title)}</h3>
        <ul>${d.items.map(i => `<li>${i.id ? `<a href="#" data-drill="${i.id}">${esc(i.name)}</a>` : esc(i.name)}${i.minutes ? ` <span class="muted">${i.minutes} min</span>` : ''}</li>`).join('')}</ul>
        ${d.note ? `<p class="muted small">${esc(d.note)}</p>` : ''}</div>`).join('')}</div>`;
}
$('#planBody').addEventListener('click', e => {
  const a = e.target.closest('[data-drill]'); if (!a) return;
  e.preventDefault(); state.drillHighlight = a.dataset.drill; show('drills');
});

// ------------------------------------------------------------------ compare
async function renderCompare() {
  state.summaries = await listSummaries().catch(() => []);
  const S = state.summaries;
  const opts = S.map(s => `<option value="${s.id}">${esc(s.name)} — ${new Date(s.createdAt).toLocaleDateString()}</option>`).join('');
  const a = $('#cmpA'), b = $('#cmpB');
  const va = a.value, vb = b.value;
  a.innerHTML = opts; b.innerHTML = opts;
  if (va) a.value = va; else if (S[1]) a.value = S[1].id;
  if (vb) b.value = vb; else if (S[0]) b.value = S[0].id;
  drawCompare();
}
function drawCompare() {
  const S = state.summaries;
  const A = S.find(s => s.id === $('#cmpA').value), B = S.find(s => s.id === $('#cmpB').value);
  const el = $('#cmpBody');
  if (!A || !B || A === B) { el.innerHTML = '<p class="muted">Pick two different analyzed matches.</p>'; return; }
  el.innerHTML = `<table><tr><th>Metric (${esc(B.me)})</th><th class="num">${esc(A.name)}</th><th class="num">${esc(B.name)}</th><th class="num">Change</th></tr>
    ${KEY_METRICS.map(k => {
      const va = A.key?.[k.id], vb = B.key?.[k.id];
      let cls = '', d = '–';
      if (Number.isFinite(va) && Number.isFinite(vb)) {
        const diff = vb - va;
        d = `${diff >= 0 ? '▲' : '▼'} ${k.f(Math.abs(diff))}`;
        if (k.better !== 'none' && Math.abs(diff) > 1e-6) cls = (k.better === 'lower') === (diff < 0) ? 'delta-good' : 'delta-bad';
      }
      return `<tr><td>${esc(k.label)}</td><td class="num">${k.f(va)}</td><td class="num">${k.f(vb)}</td><td class="num ${cls}">${d}</td></tr>`;
    }).join('')}</table>
    <p class="muted small">Green = improvement, red = got worse (for metrics with a better direction).</p>`;
}
$('#cmpA').addEventListener('change', drawCompare);
$('#cmpB').addEventListener('change', drawCompare);

// ------------------------------------------------------------------ drills
function renderDrills() {
  const sel = $('#drillFilter');
  if (!sel.options.length) sel.innerHTML = `<option value="">All focus areas</option>${FOCUS_LIST.map(f => `<option>${esc(f)}</option>`).join('')}`;
  const hl = state.drillHighlight;
  if (hl) sel.value = '';
  const ids = Object.keys(DRILLS).filter(id => !sel.value || DRILLS[id].focus === sel.value);
  $('#drillGrid').innerHTML = ids.map(id => {
    const d = DRILLS[id];
    return `<div class="drill ${hl === id ? 'highlight' : ''}" id="drill-${id}">
      <h3>${esc(d.name)}</h3><span class="chip">${esc(d.focus)}</span> <span class="muted small">${d.minutes} min · ${d.players} players</span>
      <p class="small">${esc(d.setup)}</p><ol class="small">${d.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>
      <p class="small"><b>Success:</b> ${esc(d.success)}</p><p class="small muted">Cues: ${d.cues.map(esc).join(' · ')}</p></div>`;
  }).join('');
  if (hl) { $(`#drill-${hl}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); state.drillHighlight = null; }
}
$('#drillFilter').addEventListener('change', renderDrills);

// ------------------------------------------------------------------ boot
window.addEventListener('error', e => toast(`Error: ${e.message}`, 8000));
window.addEventListener('unhandledrejection', e => toast(`Error: ${e.reason?.message || e.reason}`, 8000));
(async () => {
  const link = location.hash.match(/open=([\w-]+)/);
  const view = location.hash.match(/view=(\w+)/)?.[1];
  if (link) {
    const m = await getMatch(link[1]).catch(() => null);
    if (m) { await openMatch(m); show(view || 'analysis'); return; }
  }
  show(view && $(`#view-${view}`) ? view : 'dashboard');
})();
