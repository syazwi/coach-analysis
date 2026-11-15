// "Eraser" ignore-zones: a coarse grid over the video frame. People whose feet or hips fall in an
// erased cell (spectators, benches, the next court) are not picked up as players; the ball finder
// skips those pixels too. Stored on the match as { w, h, cells: [indices] } (JSON-friendly).
import { L } from './pose.js';

export const MASK_W = 160, MASK_H = 90;

export const emptyMask = () => ({ w: MASK_W, h: MASK_H, cells: [] });

export function toGrid(m) {
  const w = m?.w || MASK_W, h = m?.h || MASK_H;
  const g = new Uint8Array(w * h);
  for (const i of m?.cells || []) if (i >= 0 && i < g.length) g[i] = 1;
  return { g, w, h };
}
export function fromGrid({ g, w, h }) {
  const cells = [];
  for (let i = 0; i < g.length; i++) if (g[i]) cells.push(i);
  return { w, h, cells };
}
export const isEmpty = grid => !grid || !grid.g.some(v => v);

/** Paint a disc at normalized (x, y) with radius r (fraction of frame width). val 1 = erase, 0 = restore. */
export function paint(grid, x, y, r, val, aspect) {
  const { g, w, h } = grid;
  const rx = r * w, ry = r * w * (h / w) * aspect; // keep the brush round on screen
  const cx = x * w, cy = y * h;
  for (let j = Math.max(0, Math.floor(cy - ry)); j <= Math.min(h - 1, Math.ceil(cy + ry)); j++) {
    for (let i = Math.max(0, Math.floor(cx - rx)); i <= Math.min(w - 1, Math.ceil(cx + rx)); i++) {
      const dx = (i + 0.5 - cx) / rx, dy = (j + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) g[j * w + i] = val;
    }
  }
}

export function maskedAt(grid, x, y) {
  if (!grid) return false;
  const i = Math.floor(x * grid.w), j = Math.floor(y * grid.h);
  if (i < 0 || j < 0 || i >= grid.w || j >= grid.h) return false;
  return grid.g[j * grid.w + i] === 1;
}

/** A pose counts as erased when its feet or its hip centre lie in an erased area. */
export function poseMasked(grid, lm) {
  if (!grid) return false;
  const v = i => lm[i * 3 + 2] > 0.2;
  const feetX = (lm[L.la * 3] + lm[L.ra * 3]) / 2, feetY = Math.max(lm[L.la * 3 + 1], lm[L.ra * 3 + 1]);
  if ((v(L.la) || v(L.ra)) && maskedAt(grid, feetX, feetY)) return true;
  const hipX = (lm[L.lh * 3] + lm[L.rh * 3]) / 2, hipY = (lm[L.lh * 3 + 1] + lm[L.rh * 3 + 1]) / 2;
  return (v(L.lh) || v(L.rh)) && maskedAt(grid, hipX, hipY);
}

/** Red hatch over erased cells. */
export function drawMask(ctx, grid, W, H) {
  if (!grid) return;
  const { g, w, h } = grid;
  const cw = W / w, ch = H / h;
  ctx.fillStyle = 'rgba(227,73,72,0.32)';
  for (let j = 0; j < h; j++) {
    let run = -1;
    for (let i = 0; i <= w; i++) {
      const on = i < w && g[j * w + i];
      if (on && run < 0) run = i;
      if (!on && run >= 0) { ctx.fillRect(run * cw, j * ch, (i - run) * cw + 0.5, ch + 0.5); run = -1; }
    }
  }
}

/** Union of two masks (same grid size). */
export function mergeMasks(a, b) {
  const A = toGrid(a), B = toGrid(b);
  for (let i = 0; i < A.g.length; i++) if (B.g[i]) A.g[i] = 1;
  return fromGrid(A);
}

/**
 * Mouse/touch painting on a canvas. Returns { setMode(on), destroy() }.
 * opts: getGrid(), getBrush() (fraction of width), isRestore(), onChange(), aspect()
 */
export function attachPainter(canvas, opts) {
  let down = false, on = false;
  const pos = e => { const r = canvas.getBoundingClientRect(); const p = e.touches ? e.touches[0] : e; return [(p.clientX - r.left) / r.width, (p.clientY - r.top) / r.height]; };
  const stroke = e => {
    const [x, y] = pos(e);
    paint(opts.getGrid(), x, y, opts.getBrush(), opts.isRestore?.() || e.altKey || e.button === 2 ? 0 : 1, opts.aspect());
    opts.onChange?.();
  };
  const md = e => { if (!on) return; e.preventDefault(); e.stopImmediatePropagation(); down = true; stroke(e); };
  const mm = e => { if (!on) return; opts.onHover?.(pos(e)); if (down) { e.preventDefault(); stroke(e); } };
  const mu = () => { down = false; };
  const ctx = e => { if (on) e.preventDefault(); };
  canvas.addEventListener('mousedown', md, true);
  canvas.addEventListener('touchstart', md, { capture: true, passive: false });
  window.addEventListener('mousemove', mm);
  canvas.addEventListener('touchmove', mm, { passive: false });
  window.addEventListener('mouseup', mu);
  window.addEventListener('touchend', mu);
  canvas.addEventListener('contextmenu', ctx);
  canvas.addEventListener('mouseleave', () => opts.onHover?.(null));
  return { setMode: v => { on = v; canvas.style.cursor = v ? 'cell' : ''; } };
}
