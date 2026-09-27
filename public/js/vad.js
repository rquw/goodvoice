import { resample } from './util.js';

export const VAD_RATE = 16000 / 512; // frames per second

let worker = null, seq = 0;
const pending = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./vad-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = e => {
    const p = pending.get(e.data.id);
    if (!p) return;
    if (e.data.type === 'progress') p.onProgress && p.onProgress(e.data.p);
    else { pending.delete(e.data.id); e.data.type === 'error' ? p.reject(new Error(e.data.error)) : p.resolve(e.data.probs); }
  };
  worker.onerror = e => { for (const p of pending.values()) p.reject(new Error(e.message || 'vad crashed')); pending.clear(); worker = null; };
  return worker;
}

export function base() { return window.CV_SERVER || location.origin; }

// speech probability per 32 ms frame
export function vadProbs(pcm16k, onProgress) {
  const id = ++seq;
  const audio = pcm16k.slice();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, base: base(), audio }, [audio.buffer]);
  });
}

export async function vadOn(pcm, sr) {
  return vadProbs(resample(pcm, sr, 16000));
}

// Probabilities -> [start, end] seconds, with hysteresis and a little padding.
export function speechSpans(probs, { on = 0.5, off = 0.35, minSpeech = 0.18, pad = 0.12, gap = 0.3 } = {}) {
  const raw = [];
  let s = -1;
  for (let i = 0; i <= probs.length; i++) {
    const p = i < probs.length ? probs[i] : 0;
    if (s < 0 && p >= on) s = i;
    else if (s >= 0 && p < off) { raw.push([s / VAD_RATE, i / VAD_RATE]); s = -1; }
  }
  const out = [];
  for (const [a, b] of raw) {
    const last = out[out.length - 1];
    if (last && a - last[1] < gap) last[1] = b; else out.push([a, b]);
  }
  return out.filter(([a, b]) => b - a >= minSpeech).map(([a, b]) => [Math.max(0, a - pad), b + pad]);
}

export function speechIn(spans, a, b) {
  let t = 0;
  for (const [x, y] of spans) t += Math.max(0, Math.min(b, y) - Math.max(a, x));
  return t;
}
