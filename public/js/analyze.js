import { once, seekTo, sleep, u8ToB64, isMobile, fixDuration } from './util.js';

export const FPS = 50; // envelope frames per second
export const SR = 16000;

// ---- audio ----

export async function decodeAudio(blob, onProgress) {
  onProgress && onProgress(0.05);
  const buf = await blob.arrayBuffer();
  onProgress && onProgress(0.3);
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const oac = new OAC(2, SR, SR);
  const audio = await oac.decodeAudioData(buf);
  onProgress && onProgress(1);
  const L = audio.getChannelData(0);
  const R = audio.numberOfChannels > 1 ? audio.getChannelData(1) : L;
  return { L, R, duration: audio.duration, stereo: isStereo(L, R) };
}

function isStereo(L, R) {
  if (L === R) return false;
  let dl = 0, dr = 0, n = 0;
  for (let i = 0; i < L.length; i += 7) { const d = L[i] - R[i]; dl += d * d; dr += L[i] * L[i] + R[i] * R[i]; n++; }
  return dr > 0 && dl / dr > 0.004;
}

class Biquad {
  constructor(type, f, q, sr) {
    const w = 2 * Math.PI * f / sr, cs = Math.cos(w), a = Math.sin(w) / (2 * q);
    let b0, b1, b2;
    if (type === 'hp') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; } else { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; }
    const a0 = 1 + a;
    this.b = [b0 / a0, b1 / a0, b2 / a0];
    this.a = [-2 * cs / a0, (1 - a) / a0];
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
  run(x) {
    const y = this.b[0] * x + this.b[1] * this.x1 + this.b[2] * this.x2 - this.a[0] * this.y1 - this.a[1] * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

// dB energy per frame in the speech band
export function bandDb(sig, sr, from = 0, to = sig.length) {
  const hop = Math.round(sr / FPS);
  const hp = new Biquad('hp', 250, 0.7, sr), hp2 = new Biquad('hp', 250, 0.7, sr);
  const lp = new Biquad('lp', 3600, 0.7, sr), lp2 = new Biquad('lp', 3600, 0.7, sr);
  const n = Math.floor((to - from) / hop);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let e = 0;
    const s = from + f * hop;
    for (let i = 0; i < hop; i++) { const y = lp2.run(lp.run(hp2.run(hp.run(sig[s + i] || 0)))); e += y * y; }
    out[f] = 10 * Math.log10(e / hop + 1e-10);
  }
  return out;
}

// Center-weighted voice energy for the whole track, in dB.
export function voiceDb(a) {
  if (!a.stereo) return bandDb(a.L, SR);
  const n = a.L.length;
  const mid = new Float32Array(n), side = new Float32Array(n);
  for (let i = 0; i < n; i++) { mid[i] = (a.L[i] + a.R[i]) * 0.5; side[i] = (a.L[i] - a.R[i]) * 0.5; }
  const m = bandDb(mid, SR), s = bandDb(side, SR);
  const out = new Float32Array(m.length);
  for (let i = 0; i < m.length; i++) {
    const pm = 10 ** (m[i] / 10), ps = 10 ** (s[i] / 10);
    out[i] = 10 * Math.log10(Math.max(pm - 1.5 * ps, pm * 0.02) + 1e-10);
  }
  return out;
}

export function pct(arr, p) {
  const s = Float32Array.from(arr).sort();
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
}

// dB -> 0..1 envelope, relative to its own floor/peak
export function normEnv(db) {
  if (!db.length) return new Float32Array(0);
  const top = pct(db, 0.97);
  const floor = Math.min(pct(db, 0.2), top - 30);
  const span = Math.max(12, top - floor);
  const out = new Float32Array(db.length);
  for (let i = 0; i < db.length; i++) out[i] = Math.max(0, Math.min(1, (db[i] - floor - 4) / span));
  return out;
}

export function smooth(env, r = 2) {
  const out = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) {
    let s = 0, n = 0;
    for (let k = -r; k <= r; k++) { const j = i + k; if (j >= 0 && j < env.length) { s += env[j]; n++; } }
    out[i] = s / n;
  }
  return out;
}

// Reference shape for a clip: voice energy, but only where the voice detector
// heard speech. Music, effects and noise stay flat.
export function clipEnvelope(vdb, start, end, spans) {
  const a = Math.max(0, Math.floor(start * FPS)), b = Math.min(vdb.length, Math.ceil(end * FPS));
  const env = gateEnv(normEnv(vdb.subarray(a, b)), spans, start);
  const u8 = new Uint8Array(env.length);
  for (let i = 0; i < env.length; i++) u8[i] = Math.round(env[i] * 255);
  return u8ToB64(u8);
}

export function gateEnv(env, spans, offset = 0) {
  const out = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) {
    const t = offset + i / FPS;
    const inside = spans.some(([x, y]) => t >= x && t <= y);
    out[i] = inside ? Math.max(env[i], 0.18) : 0;
  }
  return out;
}

// ---- cut detection ----

const SW = 64, SH = 36;

function signature(ctx2d, video) {
  ctx2d.drawImage(video, 0, 0, SW, SH);
  const d = ctx2d.getImageData(0, 0, SW, SH).data;
  const hist = new Float32Array(48);
  const luma = new Float32Array(SW * SH);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    hist[d[i] >> 4]++; hist[16 + (d[i + 1] >> 4)]++; hist[32 + (d[i + 2] >> 4)]++;
    luma[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }
  let mean = 0;
  for (const v of luma) mean += v;
  mean /= luma.length;
  return { hist, luma, mean };
}

function sigDiff(a, b) {
  let hd = 0;
  for (let i = 0; i < 48; i++) hd += Math.abs(a.hist[i] - b.hist[i]);
  hd /= (SW * SH * 3 * 2);
  let pd = 0;
  for (let i = 0; i < a.luma.length; i++) pd += Math.abs(a.luma[i] - b.luma[i]);
  pd /= a.luma.length * 255;
  return 0.55 * hd + 0.45 * Math.min(1, pd * 2.2);
}

export function makeProbe(src) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.crossOrigin = 'anonymous';
  v.src = src;
  Object.assign(v.style, { position: 'fixed', left: '-10px', top: '-10px', width: '4px', height: '4px', opacity: '0.01', pointerEvents: 'none' });
  document.body.append(v);
  return v;
}

// Plays the video fast and muted, fingerprints frames, flags hard cuts, then
// bisects around each one with seeks to land on the right frame.
export async function detectCuts(src, { onProgress, sensitivity = 0.5, signal } = {}) {
  const v = makeProbe(src);
  try {
    const dur = await fixDuration(v);
    if (!isFinite(dur)) throw new Error('Could not read the video length.');
    const c = document.createElement('canvas');
    c.width = SW; c.height = SH;
    const g = c.getContext('2d', { willReadFrequently: true });
    const samples = [];
    let prev = null;
    const hist = [];
    const thr = 0.3 - sensitivity * 0.18;

    await seekTo(v, 0);
    v.playbackRate = isMobile ? 4 : 8;
    const done = new Promise(resolve => {
      const onFrame = (t) => {
        if (signal && signal.aborted) return resolve();
        const sig = signature(g, v);
        if (prev) {
          const d = sigDiff(prev.sig, sig);
          const avg = hist.length ? hist.reduce((a, b) => a + b, 0) / hist.length : 0;
          const jump = d > thr && d > avg * 1.7 + 0.025;
          const fade = prev.sig.mean > 18 && sig.mean < 6;
          if (jump || fade) samples.push({ a: prev.t, b: t, sigA: prev.sig, sigB: sig, d });
          hist.push(d); if (hist.length > 12) hist.shift();
        }
        prev = { t, sig };
        onProgress && onProgress(Math.min(0.97, t / dur) * 0.85);
      };
      if (v.requestVideoFrameCallback) {
        const loop = (_, meta) => { onFrame(meta.mediaTime); if (!v.ended) v.requestVideoFrameCallback(loop); };
        v.requestVideoFrameCallback(loop);
      } else {
        const iv = setInterval(() => { if (v.ended) clearInterval(iv); else onFrame(v.currentTime); }, 40);
      }
      v.addEventListener('ended', () => resolve(), { once: true });
      v.play().catch(() => resolve());
    });
    // watchdog: stalled playback shouldn't hang the whole studio
    let last = -1;
    const wd = setInterval(() => { if (v.currentTime === last && !v.paused) v.play().catch(() => {}); last = v.currentTime; }, 4000);
    await done;
    clearInterval(wd);
    v.pause();
    v.playbackRate = 1;

    const cuts = [];
    for (let i = 0; i < samples.length; i++) {
      if (signal && signal.aborted) break;
      const s = samples[i];
      let a = s.a, b = s.b;
      for (let k = 0; k < 4 && b - a > 0.045; k++) {
        const m = (a + b) / 2;
        await seekTo(v, m);
        await sleep(0);
        const sg = signature(g, v);
        if (sigDiff(sg, s.sigA) < sigDiff(sg, s.sigB)) a = m; else b = m;
      }
      const t = b;
      if (!cuts.length || t - cuts[cuts.length - 1].t > 0.25) cuts.push({ t, d: s.d });
      onProgress && onProgress(0.85 + 0.15 * (i + 1) / samples.length);
    }
    return { cuts, duration: dur, width: v.videoWidth, height: v.videoHeight };
  } finally {
    v.removeAttribute('src');
    v.load();
    v.remove();
  }
}

// ---- clips ----

// Every cut is its own clip. Only flash frames (<0.4 s) get folded into
// the shot before them. Clips cover the whole video, back to back.
export function clipsFromCuts(cuts, duration, spans) {
  const pts = [...cuts.map(c => c.t).filter(t => t > 0.05 && t < duration - 0.05), duration];
  const clips = [];
  let start = 0;
  for (const end of pts) {
    if (end - start < 0.4) { if (clips.length) { clips[clips.length - 1].end = end; start = end; } continue; }
    clips.push({ start, end });
    start = end;
  }
  if (!clips.length) clips.push({ start: 0, end: duration });
  for (const c of clips) {
    c.talk = 0;
    for (const [x, y] of spans) c.talk += Math.max(0, Math.min(y, c.end) - Math.max(x, c.start));
    c.dialogue = c.talk >= 0.3;
  }
  return clips;
}

export async function thumbnails(src, times, onEach) {
  const v = makeProbe(src);
  try {
    await fixDuration(v);
    const c = document.createElement('canvas');
    const ar = (v.videoWidth / v.videoHeight) || 16 / 9;
    c.height = 90; c.width = Math.round(90 * ar);
    const g = c.getContext('2d');
    for (let i = 0; i < times.length; i++) {
      await seekTo(v, Math.min(v.duration - 0.05, times[i]));
      if (v.readyState < 2) await once(v, 'loadeddata', 5000).catch(() => {});
      g.drawImage(v, 0, 0, c.width, c.height);
      onEach(i, c.toDataURL('image/jpeg', 0.6));
    }
  } finally {
    v.removeAttribute('src'); v.load(); v.remove();
  }
}
