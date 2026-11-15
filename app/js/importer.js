// Import a match video from a link (YouTube, Vimeo, direct .mp4, ...).
// The local server (serve.ps1) downloads it with yt-dlp; the browser then loads it as a normal file,
// so pose analysis can read the pixels (a cross-origin YouTube player can't be analyzed directly).

const sleep = ms => new Promise(r => setTimeout(r, ms));
const safeName = s => (s || 'video').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video';

async function viaServer(url, onStatus) {
  const r = await fetch(`/api/import?url=${encodeURIComponent(url)}`);
  if (r.status === 404) return null; // static hosting without the import API
  let j = await r.json();
  if (j.status === 'running') onStatus?.({ stage: 'download', progress: 0, title: j.title });
  while (j.status === 'running') {
    await sleep(1000);
    j = await (await fetch(`/api/import/status?id=${j.id}`)).json();
    onStatus?.({ stage: 'download', progress: j.progress ?? 0, title: j.title });
  }
  if (j.status !== 'done') throw new Error(j.error || 'Download failed');
  onStatus?.({ stage: 'load', progress: 0, title: j.title });
  const blob = await fetchWithProgress(`/downloads/${encodeURIComponent(j.file)}`, p => onStatus?.({ stage: 'load', progress: p, title: j.title }));
  const ext = j.file.split('.').pop();
  return new File([blob], `${safeName(j.title || j.id)}.${ext}`, { type: blob.type || `video/${ext === 'webm' ? 'webm' : 'mp4'}` });
}

async function direct(url, onStatus) {
  onStatus?.({ stage: 'load', progress: 0 });
  const blob = await fetchWithProgress(url, p => onStatus?.({ stage: 'load', progress: p }));
  if (!blob.type.startsWith('video') && !/\.(mp4|webm|mov|m4v)(\?|$)/i.test(url)) throw new Error('That link is not a video file.');
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'video.mp4');
  return new File([blob], safeName(name), { type: blob.type || 'video/mp4' });
}

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !total) return res.blob();
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress?.((got / total) * 100);
  }
  return new Blob(chunks, { type: res.headers.get('content-type') || '' });
}

export async function importFromLink(url, onStatus) {
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('Paste a full link starting with http(s)://');
  let file = null;
  try {
    file = await viaServer(url, onStatus);
  } catch (e) {
    if (e instanceof TypeError) file = null; // server unreachable -> try direct
    else throw e;
  }
  if (file) return file;
  try {
    return await direct(url, onStatus);
  } catch {
    throw new Error('This link needs the local server for importing. Start the app with start.bat (it downloads videos with yt-dlp).');
  }
}
