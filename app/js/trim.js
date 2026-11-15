// "Game time": choose when play starts/ends (one or more games) so processing skips warm-ups,
// breaks between games and dead time. Includes a quick motion scan that suggests play segments.
import { $, clamp, fmtTime, fitCanvas, seekVideo, toast } from './util.js';

const parseTime = s => {
  const p = String(s).trim().split(':').map(Number);
  if (p.some(n => !Number.isFinite(n))) return NaN;
  return p.reduce((a, n) => a * 60 + n, 0);
};
const fmtT = t => { const m = Math.floor(t / 60), s = (t % 60).toFixed(0).padStart(2, '0'); return `${m}:${s === '60' ? '59' : s}`; };

export function setupTrim({ scanVideo }) {
  const v = $('#trimVideo');
  const st = { segs: [], cur: 0, dur: 0, activity: null, scanning: false, cancel: false, fps: 10 };

  function load(url, duration) {
    st.dur = duration;
    st.segs = [{ start: 0, end: duration }];
    st.cur = 0; st.activity = null;
    v.src = url;
    $('#trimCard').hidden = false;
    render();
  }

  const total = () => st.segs.reduce((s, g) => s + Math.max(0, g.end - g.start), 0);
  function normalize() {
    st.segs = st.segs.map(g => ({ start: clamp(Math.min(g.start, g.end), 0, st.dur), end: clamp(Math.max(g.start, g.end), 0, st.dur) }))
      .filter(g => g.end - g.start >= 1).sort((a, b) => a.start - b.start);
    // merge overlaps
    const out = [];
    for (const g of st.segs) {
      const last = out[out.length - 1];
      if (last && g.start <= last.end) last.end = Math.max(last.end, g.end); else out.push({ ...g });
    }
    st.segs = out.length ? out : [{ start: 0, end: st.dur }];
    st.cur = clamp(st.cur, 0, st.segs.length - 1);
  }

  function render() {
    drawBar();
    $('#trimTime').textContent = `${fmtTime(v.currentTime || 0)} / ${fmtTime(st.dur)}`;
    $('#trimList').innerHTML = st.segs.map((g, i) => `
      <div class="slot ${i === st.cur ? 'active' : ''}" data-i="${i}">
        <i style="background:#199e70"></i>
        <span class="seg-times"><input data-f="start" data-i="${i}" value="${fmtT(g.start)}" aria-label="Start"> → <input data-f="end" data-i="${i}" value="${fmtT(g.end)}" aria-label="End"></span>
        ${st.segs.length > 1 ? `<button type="button" class="btn small ghost" data-del="${i}" title="Remove">✕</button>` : '<span></span>'}
        <div class="meta">Game ${i + 1} · ${fmtTime(g.end - g.start)}</div>
      </div>`).join('');
    const used = total(), saved = st.dur - used;
    const fps = st.fps;
    $('#trimSummary').innerHTML = `Analyzing <b>${fmtTime(used)}</b> of ${fmtTime(st.dur)}${saved > 1 ? ` — skips <b>${fmtTime(saved)}</b> (${((saved / st.dur) * 100).toFixed(0)}%)` : ''}. Estimated processing ≈ ${fmtTime(used * fps * 0.15)}–${fmtTime(used * fps * 0.3)} on this computer.`;
  }

  function drawBar() {
    const cv = $('#trimBar');
    const { ctx, w, h } = fitCanvas(cv);
    ctx.fillStyle = '#232321'; ctx.fillRect(0, 0, w, h);
    if (!st.dur) return;
    const X = t => (t / st.dur) * w;
    if (st.activity) {
      const { t, e } = st.activity;
      const max = Math.max(...e) || 1;
      ctx.strokeStyle = 'rgba(195,194,183,0.55)'; ctx.lineWidth = 1;
      ctx.beginPath();
      e.forEach((val, i) => { const x = X(t[i]), y = h - 4 - (val / max) * (h - 10); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
    }
    st.segs.forEach((g, i) => {
      ctx.fillStyle = i === st.cur ? 'rgba(25,158,112,0.55)' : 'rgba(25,158,112,0.35)';
      ctx.fillRect(X(g.start), 2, Math.max(2, X(g.end) - X(g.start)), h - 4);
      ctx.fillStyle = '#199e70';
      ctx.fillRect(X(g.start), 0, 2, h); ctx.fillRect(X(g.end) - 2, 0, 2, h);
    });
    ctx.fillStyle = '#f0efec';
    ctx.fillRect(X(v.currentTime || 0) - 1, 0, 2, h);
  }

  // --- interactions
  $('#trimBar').addEventListener('click', e => {
    const r = e.currentTarget.getBoundingClientRect();
    v.currentTime = clamp(((e.clientX - r.left) / r.width) * st.dur, 0, st.dur);
  });
  v.addEventListener('timeupdate', render);
  v.addEventListener('seeked', render);
  v.addEventListener('play', () => { $('#trimPlay').textContent = '⏸'; });
  v.addEventListener('pause', () => { $('#trimPlay').textContent = '▶'; });
  $('#trimPlay').addEventListener('click', () => (v.paused ? v.play() : v.pause()));
  $('#trimBack5').addEventListener('click', () => { v.currentTime = clamp(v.currentTime - 5, 0, st.dur); });
  $('#trimFwd5').addEventListener('click', () => { v.currentTime = clamp(v.currentTime + 5, 0, st.dur); });
  $('#trimStartBtn').addEventListener('click', () => {
    const g = st.segs[st.cur];
    g.start = v.currentTime;
    if (g.end <= g.start) g.end = st.dur;
    normalize(); render();
  });
  $('#trimEndBtn').addEventListener('click', () => {
    const g = st.segs[st.cur];
    g.end = v.currentTime;
    if (g.end <= g.start) { toast('The end must be after the start of this game.'); g.end = st.dur; }
    normalize(); render();
  });
  $('#trimAdd').addEventListener('click', () => {
    const t = v.currentTime;
    const inside = st.segs.findIndex(g => t >= g.start && t <= g.end);
    if (inside >= 0) {
      // split: current game ends here, next game starts at the next "Set game start"
      const g = st.segs[inside];
      st.segs.splice(inside + 1, 0, { start: Math.min(st.dur, t + 1), end: g.end });
      g.end = t;
      st.cur = inside + 1;
      toast('Split here. Now scrub to where the next game starts and press “Set game start”.', 4500);
    } else {
      st.segs.push({ start: t, end: st.dur });
      st.cur = st.segs.length - 1;
    }
    normalize(); render();
  });
  $('#trimAll').addEventListener('click', () => { st.segs = [{ start: 0, end: st.dur }]; st.cur = 0; render(); });
  $('#trimList').addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) { st.segs.splice(+del.dataset.del, 1); normalize(); render(); return; }
    const row = e.target.closest('.slot');
    if (row && !e.target.matches('input')) { st.cur = +row.dataset.i; v.currentTime = st.segs[st.cur].start; render(); }
  });
  $('#trimList').addEventListener('change', e => {
    const i = +e.target.dataset.i, f = e.target.dataset.f;
    if (!f) return;
    const t = parseTime(e.target.value);
    if (!Number.isFinite(t)) { toast('Use m:ss, e.g. 12:30'); render(); return; }
    st.segs[i][f] = t; st.cur = i;
    normalize(); render();
  });

  // --- motion scan: suggests when play is happening
  $('#trimAuto').addEventListener('click', async () => {
    if (st.scanning) { st.cancel = true; return; }
    const btn = $('#trimAuto');
    st.scanning = true; st.cancel = false;
    const sv = scanVideo;
    const step = Math.max(1, st.dur / 1500);
    const W = 96, H = Math.round(96 * sv.videoHeight / sv.videoWidth);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    const ts = [], es = [];
    let prev = null;
    try {
      for (let t = 0; t <= st.dur; t += step) {
        if (st.cancel) break;
        await seekVideo(sv, t);
        g.drawImage(sv, 0, 0, W, H);
        const d = g.getImageData(0, Math.floor(H * 0.15), W, Math.floor(H * 0.85)).data;
        if (prev) {
          let sum = 0;
          for (let j = 0; j < d.length; j += 4) sum += Math.abs(d[j] - prev[j]) + Math.abs(d[j + 1] - prev[j + 1]);
          ts.push(t); es.push(sum / (d.length / 4));
        }
        prev = d;
        btn.textContent = `Scanning ${((t / st.dur) * 100).toFixed(0)}% (click to stop)`;
      }
      if (es.length < 10) { toast('Video too short to scan.'); return; }
      // smooth over ~15 s
      const win = Math.max(1, Math.round(15 / step / 2));
      const sm = es.map((_, i) => { const w = es.slice(Math.max(0, i - win), i + win + 1).sort((a, b) => a - b); return w[w.length >> 1]; });
      const sorted = [...sm].sort((a, b) => a - b);
      const p20 = sorted[Math.floor(sorted.length * 0.2)], p80 = sorted[Math.floor(sorted.length * 0.8)];
      const thr = p20 + 0.35 * (p80 - p20);
      let segs = [], cur = null;
      sm.forEach((val, i) => {
        if (val > thr) { if (!cur) cur = { start: ts[i], end: ts[i] }; cur.end = ts[i]; }
        else if (cur) { segs.push(cur); cur = null; }
      });
      if (cur) segs.push(cur);
      // merge short gaps, drop short bursts, pad
      const merged = [];
      for (const s of segs) {
        const last = merged[merged.length - 1];
        if (last && s.start - last.end < 20) last.end = s.end; else merged.push({ ...s });
      }
      segs = merged.filter(s => s.end - s.start >= 15).map(s => ({ start: Math.max(0, s.start - 3), end: Math.min(st.dur, s.end + 3) }));
      st.activity = { t: ts, e: sm };
      if (!segs.length || (segs.length === 1 && segs[0].end - segs[0].start > st.dur * 0.97)) {
        toast('No clear breaks found — play seems continuous. Set start/end by hand if needed.', 5000);
      } else {
        st.segs = segs; st.cur = 0;
        toast(`Suggested ${segs.length} play segment${segs.length > 1 ? 's' : ''} — review them on the bar before continuing.`, 5000);
      }
      normalize();
    } finally {
      st.scanning = false;
      btn.textContent = 'Suggest from motion';
      render();
    }
  });

  return {
    load,
    setFps: f => { st.fps = f; render(); },
    getSegments: () => st.segs.map(g => ({ start: +g.start.toFixed(2), end: +g.end.toFixed(2) })),
    hide: () => { $('#trimCard').hidden = true; v.removeAttribute('src'); },
  };
}
