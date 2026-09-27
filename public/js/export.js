import { audioCtx, VideoRoute, heardCtxTime, frameClock } from './audio.js';
import { once, seekTo, clamp, fixDuration } from './util.js';

export function pickMime() {
  const opts = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs="avc1,opus"', 'video/mp4',
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
  ];
  if (!window.MediaRecorder) return null;
  return opts.find(m => MediaRecorder.isTypeSupported(m)) || '';
}

// Background tabs throttle setInterval to 1/s. Worker timers keep ticking.
function workerTicker(ms, fn) {
  const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms});`], { type: 'text/javascript' }));
  const w = new Worker(url);
  w.onmessage = fn;
  return () => { w.terminate(); URL.revokeObjectURL(url); };
}

const visible = () => document.visibilityState === 'visible';
const waitVisible = () => new Promise(r => {
  if (visible()) return r();
  const f = () => { if (visible()) { document.removeEventListener('visibilitychange', f); r(); } };
  document.addEventListener('visibilitychange', f);
});

// Renders the dub in real time on this device: every clip back to back, no
// cards in between. If the tab gets hidden the render pauses and picks up
// exactly where it was, so nothing ends up frozen or silent.
export async function renderReel({ src, segments, onProgress, onState, signal, preview }) {
  const mime = pickMime();
  if (mime == null) throw new Error('This browser cannot record video. Try Chrome, Edge or Safari.');
  const ac = audioCtx();
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.playsInline = true;
  video.preload = 'auto';
  video.src = src;
  video.className = 'render-video';
  // the video has to be on screen, browsers stop decoding hidden ones
  (preview || document.body).append(video);
  await fixDuration(video);

  const dest = ac.createMediaStreamDestination();
  const route = new VideoRoute(video, dest);
  const ar = (video.videoWidth / video.videoHeight) || 16 / 9;
  const W = 1280, H = Math.round(W / ar / 2) * 2;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');

  let seg = segments[0];
  const fontSmall = Math.round(H * 0.04);

  const paint = () => {
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    g.drawImage(video, 0, 0, W, H);
    if (seg.name) {
      const tag = `🎙 ${seg.name}`;
      g.font = `700 ${fontSmall}px "Bricolage Grotesque", system-ui, sans-serif`;
      g.textAlign = 'left';
      const tw = g.measureText(tag).width;
      g.fillStyle = 'rgba(11,10,18,0.7)';
      g.beginPath(); g.roundRect(H * 0.03, H * 0.03, tw + fontSmall, fontSmall * 1.7, fontSmall * 0.85); g.fill();
      g.fillStyle = seg.color || '#ffd23f';
      g.fillText(tag, H * 0.03 + fontSmall / 2, H * 0.03 + fontSmall * 1.2);
    }
  };

  const stream = canvas.captureStream(30);
  dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
  const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 160_000 });
  const parts = [];
  rec.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
  const stopped = new Promise(r => { rec.onstop = r; });
  const stopTicker = workerTicker(1000 / 30, paint);

  const total = segments.reduce((a, s) => a + (s.clip.end - s.clip.start), 0);
  const startsAt = [];
  { let t = 0; for (const s of segments) { startsAt.push(t); t += s.clip.end - s.clip.start; } }
  let voiceNode = null;
  const stopVoice = () => { if (voiceNode) { try { voiceNode.stop(); } catch {} voiceNode = null; } };

  // plays [from, clip.end) of a segment; returns where it actually got to
  const playSpan = (s, idx, from) => new Promise((resolve, reject) => {
    let done = false, started = false, reached = from;
    const cleanup = () => { done = true; stop(); clearTimeout(guard); document.removeEventListener('visibilitychange', onVis); video.removeEventListener('ended', onEnded); };
    const finish = at => {
      if (done) return;
      cleanup();
      video.pause(); stopVoice();
      resolve(at);
    };
    const onVis = () => { if (!visible()) finish(Math.max(from, video.currentTime - 0.1)); };
    const onEnded = () => finish(s.clip.end);
    document.addEventListener('visibilitychange', onVis);
    video.addEventListener('ended', onEnded);
    const stop = frameClock(video, (P, M) => {
      if (done) return;
      if (s.voice && !started) {
        started = true;
        const node = ac.createBufferSource();
        node.buffer = s.voice;
        const gain = ac.createGain(); gain.gain.value = 1.4;
        node.connect(gain).connect(route.out);
        const when = heardCtxTime(P) - (M - s.clip.start);
        const now = ac.currentTime + 0.03;
        if (when >= now) node.start(when);
        else if (now - when < s.voice.duration) node.start(now, now - when);
        voiceNode = node;
      }
      if (M > reached) { reached = M; onProgress && onProgress(clamp((startsAt[idx] + M - s.clip.start) / total)); }
      if (M >= s.clip.end - 0.02) finish(s.clip.end);
    });
    const guard = setTimeout(() => finish(Math.max(reached, video.currentTime)), (s.clip.end - from + 4) * 1000);
    video.play().catch(e => { cleanup(); reject(e); });
  });

  try {
    await document.fonts.ready;
    await seekTo(video, seg.clip.start);
    if (video.readyState < 2) await once(video, 'loadeddata', 8000).catch(() => {});
    paint();
    rec.start(1000);
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      seg = s;
      route.remover.set(s.removal || 'center', s.clip.stereo !== false);
      let from = s.clip.start;
      while (from < s.clip.end - 0.05) {
        if (signal && signal.aborted) throw new Error('cancelled');
        if (!visible()) {
          if (rec.state === 'recording') rec.pause();
          onState && onState('hidden');
          await waitVisible();
          onState && onState('rendering');
        }
        // hold the recorder while seeking so cuts are clean
        if (rec.state === 'recording') rec.pause();
        await seekTo(video, from);
        paint();
        if (rec.state === 'paused') rec.resume();
        from = await playSpan(s, i, from);
      }
    }
    rec.stop();
    await stopped;
  } finally {
    stopTicker();
    stopVoice();
    try { if (rec.state !== 'inactive') rec.stop(); } catch {}
    try { route.out.disconnect(); } catch {}
    video.pause(); video.removeAttribute('src'); video.load(); video.remove();
  }
  const type = (mime || 'video/webm').split(';')[0];
  return new Blob(parts, { type });
}
