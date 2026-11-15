export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
export const median = a => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const ratio = (n, d) => (d ? n / d : NaN);
export const fmtTime = s => {
  if (!Number.isFinite(s)) return '–';
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
};
export const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');
export const fmtPct = (v, d = 0) => (Number.isFinite(v) ? (v * 100).toFixed(d) + '%' : '–');
export const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Binary search: index of the last element with arr[i] <= t (or 0). */
export function bisect(arr, t) {
  let lo = 0, hi = arr.length - 1;
  if (hi < 0) return -1;
  if (t <= arr[0]) return 0;
  if (t >= arr[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= t) lo = mid; else hi = mid;
  }
  return lo;
}

export function toast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

/** Size a canvas's backing store to its CSS box × devicePixelRatio. Returns ctx scaled to CSS px. */
export function fitCanvas(canvas, cssW, cssH) {
  const dpr = window.devicePixelRatio || 1;
  const w = cssW ?? canvas.clientWidth, h = cssH ?? canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

/** Preserve source aspect ratio inside a pixel box (no upscaling unless requested). */
export function containSize(srcW, srcH, { maxWidth = 1280, maxHeight = 900, upscale = false } = {}) {
  if (!(srcW > 0) || !(srcH > 0)) throw new Error('Source dimensions are required');
  const scale = Math.min(upscale ? Infinity : 1, maxWidth / srcW, maxHeight / srcH);
  return { width: Math.max(1, Math.round(srcW * scale)), height: Math.max(1, Math.round(srcH * scale)), scale };
}

/** Apply source aspect ratio and a viewport-height cap to a video/canvas stage. */
export function setMediaLayout(stage, srcW, srcH) {
  if (!stage || !(srcW > 0) || !(srcH > 0)) return;
  const portrait = srcH > srcW;
  stage.style.aspectRatio = `${srcW} / ${srcH}`;
  stage.classList.toggle('portrait-media', portrait);
  if (portrait) stage.style.setProperty('--portrait-max-width', `${Math.min(78, 78 * srcW / srcH).toFixed(3)}vh`);
  else stage.style.removeProperty('--portrait-max-width');
}

export function seekVideo(video, t) {
  return new Promise(resolve => {
    if (Math.abs(video.currentTime - t) < 1e-3 && video.readyState >= 2) return resolve();
    const done = () => { clearTimeout(timer); video.removeEventListener('seeked', done); resolve(); };
    const timer = setTimeout(done, 3000);
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}

export function loadVideoMeta(video, url) {
  return new Promise((resolve, reject) => {
    video.onloadeddata = () => resolve();
    video.onerror = () => reject(new Error('Cannot decode this video in the browser. Try MP4 (H.264).'));
    video.src = url;
    video.load();
  });
}

export function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
