// IndexedDB persistence: full matches + light summaries for the dashboard.
const DB_NAME = 'courtsense', VERSION = 2;
let dbp = null;

function open() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('matches')) db.createObjectStore('matches', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('summaries')) db.createObjectStore('summaries', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('videos')) db.createObjectStore('videos', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const r = fn(s);
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  }));
}

export const saveMatch = (match, summary) => Promise.all([
  tx('matches', 'readwrite', s => s.put(match)),
  tx('summaries', 'readwrite', s => s.put(summary)),
]);
export const getMatch = id => tx('matches', 'readonly', s => s.get(id));
export const listSummaries = async () => ((await tx('summaries', 'readonly', s => s.getAll())) || []).sort((a, b) => b.createdAt - a.createdAt);
export const deleteMatch = id => Promise.all([
  tx('matches', 'readwrite', s => s.delete(id)),
  tx('summaries', 'readwrite', s => s.delete(id)),
  tx('videos', 'readwrite', s => s.delete(id)),
]);

// Original match video kept in the app so a saved analysis reopens without re-attaching the file.
export async function saveVideo(id, file) {
  if (navigator.storage?.estimate) {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    if (quota && quota - usage < file.size * 1.1) throw new Error(`Not enough browser storage (${((quota - usage) / 1e9).toFixed(1)} GB free, need ${(file.size / 1e9).toFixed(1)} GB).`);
  }
  navigator.storage?.persist?.().catch(() => {});
  return tx('videos', 'readwrite', s => s.put({ id, blob: file, name: file.name, size: file.size, type: file.type, savedAt: Date.now() }));
}
export async function getVideo(id) {
  const r = await tx('videos', 'readonly', s => s.get(id));
  return r ? new File([r.blob], r.name, { type: r.type || 'video/mp4' }) : null;
}
export const hasVideo = async id => (await tx('videos', 'readonly', s => s.getKey(id))) !== undefined;
export const deleteVideo = id => tx('videos', 'readwrite', s => s.delete(id));

// JSON (typed arrays -> plain arrays)
export function matchToJSON(match) {
  return JSON.stringify(match, (k, v) => (v instanceof Float32Array ? { __f32: Array.from(v, x => +x.toFixed(4)) } : v));
}
export function matchFromJSON(text) {
  return JSON.parse(text, (k, v) => (v && v.__f32 ? Float32Array.from(v.__f32) : v));
}
