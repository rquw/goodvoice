import { h, seekTo, fmtTime, clamp } from './util.js';
import { audioCtx, heardCtxTime, frameClock } from './audio.js';
import { refEnvelope, takeEnvelope } from './score.js';

// Plays every clip back to back with its dub, as one continuous video.
// Positions are "reel seconds" so several devices can agree on where they are.
export class ReelPlayer {
  constructor(stage, segments, removal) {
    this.stage = stage;
    this.segs = segments;
    this.removal = removal;
    this.starts = [];
    let t = 0;
    for (const s of segments) { this.starts.push(t); t += s.clip.end - s.clip.start; }
    this.total = t;
    this.playing = false;
    this.i = 0;
    this.token = 0;
    this.pausedAt = 0;
    this.listeners = new Set();
    this.envCache = new Map();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(); }

  locate(pos) {
    pos = clamp(pos, 0, this.total);
    let i = this.starts.length - 1;
    while (i > 0 && this.starts[i] > pos) i--;
    return { i, off: pos - this.starts[i] };
  }

  get pos() {
    if (!this.playing) return this.pausedAt;
    const s = this.segs[this.i];
    return this.starts[this.i] + clamp(this.stage.video.currentTime - s.clip.start, 0, s.clip.end - s.clip.start);
  }

  stopVoice() {
    if (this.voice) { try { this.voice.stop(); } catch {} this.voice = null; }
  }

  showSeg(i) {
    const s = this.segs[i];
    const st = this.stage;
    st.subsOff = true;
    st.clip = s.clip;
    st.ref = refEnvelope(s.clip);
    st.lastLine = -1;
    st.showTake([]);
    if (s.voice) {
      if (!this.envCache.has(i)) this.envCache.set(i, takeEnvelope(s.voice.getChannelData(0), s.voice.sampleRate));
      this.envCache.get(i).then(env => { if (this.i === i) st.showTake(env); }).catch(() => {});
    }
    st.setBadge(s.name ? '🎙 ' + s.name : '', s.color);
  }

  async pause(pos = this.pos) {
    this.token++;
    this.playing = false;
    this.pausedAt = clamp(pos, 0, this.total);
    this.stopVoice();
    this.stage.video.pause();
    this.stage.mode = 'idle';
    const { i, off } = this.locate(this.pausedAt);
    this.i = i;
    this.showSeg(i);
    this.emit();
    try { await seekTo(this.stage.video, this.segs[i].clip.start + off); } catch {}
  }

  async play(pos = this.pos) {
    const my = ++this.token;
    if (pos >= this.total - 0.05) pos = 0;
    this.playing = true;
    this.stopVoice();
    const { i, off } = this.locate(pos);
    this.i = i;
    this.emit();
    const s = this.segs[i];
    const st = this.stage;
    const ac = audioCtx();
    const route = st.ensureRoute();
    route.remover.set(this.removal, s.clip.stereo !== false);
    route.backing.gain.value = 1;
    this.showSeg(i);
    this.busy = true;
    try { await seekTo(st.video, s.clip.start + off); } catch {}
    this.busy = false;
    if (my !== this.token) return;
    st.mode = s.voice ? 'dub' : 'watch';
    let started = false;
    let advanced = false;
    const stop = frameClock(st.video, (P, M) => {
      if (my !== this.token) { stop(); return; }
      if (s.voice && !started && M >= s.clip.start - 0.01) {
        started = true;
        const node = ac.createBufferSource();
        node.buffer = s.voice;
        node.connect(route.voice);
        route.voice.gain.value = 1.4;
        const when = heardCtxTime(P) - (M - s.clip.start);
        const now = ac.currentTime + 0.03;
        if (when >= now) node.start(when);
        else if (now - when < s.voice.duration) node.start(now, now - when);
        this.voice = node;
      }
      if (M >= s.clip.end - 0.03 && !advanced) {
        advanced = true;
        stop();
        if (i + 1 < this.segs.length) this.play(this.starts[i + 1]);
        else { this.pause(this.total); this.ended = true; this.emit(); }
      }
    });
    const onEnded = () => { st.video.removeEventListener('ended', onEnded); if (my === this.token && !advanced) { advanced = true; stop(); this.pause(this.total); this.ended = true; this.emit(); } };
    st.video.addEventListener('ended', onEnded);
    try { await st.video.play(); } catch (e) {
      stop();
      if (my === this.token) { this.playing = false; this.pausedAt = pos; this.emit(); }
      throw e;
    }
  }

  destroy() { this.token++; this.stopVoice(); this.stage.video.pause(); this.stage.subsOff = false; this.listeners.clear(); }
}

// Play/pause + scrub bar. Callbacks decide whether that's local or shared.
export function reelControls(reel, { onPlay, onPause, onSeek }) {
  const btn = h('button', { class: 'btn primary reel-btn', onclick: () => (reel.playing ? onPause(reel.pos) : onPlay(reel.pos)) });
  const fill = h('i');
  const marks = h('div', { class: 'reel-marks' }, reel.starts.slice(1).map(t => h('b', { style: { left: (t / reel.total * 100) + '%' } })));
  const track = h('div', { class: 'reel-track' }, fill, marks);
  const time = h('span', { class: 'reel-time' });
  const seekFrom = e => {
    const r = track.getBoundingClientRect();
    onSeek(clamp((e.clientX - r.left) / r.width) * reel.total);
  };
  track.addEventListener('pointerdown', seekFrom);
  const el = h('div', { class: 'reel-ctl' }, btn, track, time);
  let raf;
  const tick = () => {
    if (!el.isConnected && el._on) return;
    el._on = true;
    const p = reel.pos;
    fill.style.width = (p / (reel.total || 1) * 100) + '%';
    time.textContent = `${fmtTime(p).replace(/\.\d$/, '')} / ${fmtTime(reel.total).replace(/\.\d$/, '')}`;
    btn.textContent = reel.playing ? '❚❚' : '▶';
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return el;
}
