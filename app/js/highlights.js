// Highlight reel: picks the best rallies and can record them (video + overlays) to a .webm file.
import { seekVideo } from './util.js';

export function pickHighlights(A, myTeam, max = 8) {
  const scored = A.rallies.map(r => {
    let s = r.shots.length;
    if (r.outcome?.winner === myTeam) s += 4;
    if (r.outcome?.how === 'winner') s += 3;
    return { r, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, max).map(({ r }) => ({ start: r.start, end: r.end, label: `Rally ${r.index + 1} · ${r.shots.length} shots` })).sort((a, b) => a.start - b.start);
}

/**
 * Plays clips and records a composited canvas. drawFrame(ctx, w, h) must draw video + overlays.
 * Returns a Blob (video/webm). Audio is not included.
 */
export async function recordReel(video, clips, drawFrame, onProgress, size = null) {
  const w = video.videoWidth, h = video.videoHeight;
  const scale = Math.min(1, 1280 / w);
  const canvas = document.createElement('canvas');
  canvas.width = size?.width ?? Math.round(w * scale); canvas.height = size?.height ?? Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(30);
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5e6 });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const stopped = new Promise(r => { rec.onstop = r; });
  const wasMuted = video.muted, wasRate = video.playbackRate;
  video.muted = true; video.playbackRate = 1;
  rec.start(500);
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    await seekVideo(video, c.start);
    await video.play();
    await new Promise(resolve => {
      const tick = () => {
        drawFrame(ctx, canvas.width, canvas.height, c, i);
        onProgress?.((i + (video.currentTime - c.start) / (c.end - c.start)) / clips.length);
        if (video.currentTime >= c.end || video.ended) { video.pause(); resolve(); } else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }
  rec.stop();
  await stopped;
  video.muted = wasMuted; video.playbackRate = wasRate;
  return new Blob(chunks, { type: 'video/webm' });
}
