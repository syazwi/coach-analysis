// "Save analyzed video": renders the match with overlays burned in.
// Preferred path: frame-accurate WebCodecs H.264 encode -> MP4 (mp4-muxer), streamed to disk when the
// browser supports the File System Access API. Fallback: real-time canvas recording -> WebM.
import { seekVideo } from './util.js';
import { recordReel } from './highlights.js';

const MUXER_URL = '../vendor/mp4-muxer.mjs'; // mp4-muxer 5.1.3 (MIT), bundled so export works offline

export const canEncodeMp4 = () => typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
export const canPickFile = () => typeof window.showSaveFilePicker === 'function';

const even = n => Math.max(2, Math.round(n / 2) * 2);
export function outputSize(vw, vh, targetH) {
  const h = targetH ? Math.min(targetH, vh) : vh;
  return { width: even((vw * h) / vh), height: even(h) };
}

export const totalDuration = segments => segments.reduce((s, g) => s + Math.max(0, g.end - g.start), 0);

async function pickEncoderConfig(width, height, fps, bitrate) {
  // High 5.1 / High 4.0 / Main 4.0 / Baseline 3.1 — first one the browser accepts
  for (const codec of ['avc1.640033', 'avc1.640028', 'avc1.4d4028', 'avc1.42e01f']) {
    const cfg = { codec, width, height, bitrate, framerate: fps, avc: { format: 'avc' } };
    try {
      const s = await VideoEncoder.isConfigSupported(cfg);
      if (s.supported) return cfg;
    } catch { /* try next */ }
  }
  return null;
}

/** Ask where to save (must run directly inside a click handler). Returns a handle, null if unsupported; throws AbortError if cancelled. */
export async function askSaveLocation(suggestedName, mp4 = true) {
  if (!canPickFile()) return null;
  return window.showSaveFilePicker({
    suggestedName,
    types: [mp4 ? { description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } } : { description: 'WebM video', accept: { 'video/webm': ['.webm'] } }],
  });
}

/**
 * segments: [{ start, end, label? }] in source-video seconds.
 * draw(ctx, w, h, t, segment) paints one output frame.
 * Returns a Blob, or null when written straight to fileHandle.
 */
export async function exportVideo({ video, segments, fps, height, draw, onProgress, isCancelled, fileHandle }) {
  const { width, height: outH } = outputSize(video.videoWidth, video.videoHeight, height);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = outH;
  const ctx = canvas.getContext('2d');
  const wasMuted = video.muted, wasRate = video.playbackRate;
  video.pause();

  const webm = async () => {
    // real-time fallback (WebM via MediaRecorder)
    const blob = await recordReel(video, segments, (c, w, h, seg) => draw(c, w, h, video.currentTime, seg), onProgress, { width, height: outH });
    return { blob, ext: 'webm' };
  };
  if (!canEncodeMp4()) return webm();

  const bitrate = Math.round(width * outH * fps * 0.12); // ~4 Mbps at 720p30, ~9 Mbps at 1080p30
  const cfg = await pickEncoderConfig(width, outH, fps, bitrate);
  if (!cfg) return webm();
  try {
    return await encodeMp4({ video, segments, fps, draw, onProgress, isCancelled, fileHandle, canvas, ctx, width, outH, cfg });
  } catch (e) {
    if (e.message !== 'ENCODER_STALL') throw e;
    console.warn('H.264 encoder stalled — falling back to real-time WebM recording');
    return webm();
  } finally {
    video.muted = wasMuted; video.playbackRate = wasRate;
  }
}

const STALL_MS = 10000;
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('ENCODER_STALL')), ms))]);

async function encodeMp4({ video, segments, fps, draw, onProgress, isCancelled, fileHandle, canvas, ctx, width, outH, cfg }) {
  const { Muxer, ArrayBufferTarget, FileSystemWritableFileStreamTarget } = await import(MUXER_URL);

  let stream = null, target;
  if (fileHandle) { stream = await fileHandle.createWritable(); target = new FileSystemWritableFileStreamTarget(stream); }
  else target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width, height: outH, frameRate: fps },
    fastStart: fileHandle ? false : 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  let encErr = null, outputs = 0;
  const enc = new VideoEncoder({ output: (chunk, meta) => { outputs++; muxer.addVideoChunk(chunk, meta); }, error: e => { encErr = e; } });
  enc.configure(cfg);

  const total = segments.reduce((s, g) => s + Math.max(1, Math.round((g.end - g.start) * fps)), 0);
  let n = 0;
  try {
    outer: for (const seg of segments) {
      const count = Math.max(1, Math.round((seg.end - seg.start) * fps));
      for (let i = 0; i < count; i++) {
        if (isCancelled?.()) break outer;
        if (encErr) throw encErr;
        const t = Math.min(video.duration - 0.001, seg.start + i / fps);
        await seekVideo(video, t);
        draw(ctx, width, outH, t, seg);
        const frame = new VideoFrame(canvas, { timestamp: Math.round((n * 1e6) / fps), duration: Math.round(1e6 / fps) });
        enc.encode(frame, { keyFrame: n % (fps * 2) === 0 });
        frame.close();
        n++;
        const waitStart = performance.now();
        while (enc.encodeQueueSize > 6) {
          if (performance.now() - waitStart > STALL_MS) throw new Error('ENCODER_STALL');
          await new Promise(r => setTimeout(r, 4));
        }
        onProgress?.(n / total);
      }
    }
    await withTimeout(enc.flush(), STALL_MS + n * 50);
    if (encErr) throw encErr;
    if (n && !outputs) throw new Error('ENCODER_STALL');
  } catch (e) {
    if (stream) await stream.abort?.().catch(() => {});
    throw e;
  } finally {
    if (enc.state !== 'closed') try { enc.close(); } catch { /* already closed */ }
  }
  if (!n) { if (stream) await stream.abort?.().catch(() => {}); throw new Error('Export cancelled before any frame was written.'); }
  muxer.finalize();
  if (stream) { await stream.close(); return { blob: null, ext: 'mp4' }; }
  return { blob: new Blob([target.buffer], { type: 'video/mp4' }), ext: 'mp4' };
}
