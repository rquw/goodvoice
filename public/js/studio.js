import { h, fmtBytes, toast, prefs } from './util.js';
import { decodeAudio, voiceDb, detectCuts, clipsFromCuts, clipEnvelope, thumbnails } from './analyze.js';
import { vadProbs, speechSpans } from './vad.js';
import { transcribe, linesFor } from './asr.js';
import { FPS, normEnv, smooth } from './analyze.js';

// fallback when the neural detector can't run: loud stretches in the voice band
function loudSpans(vdb) {
  const env = smooth(normEnv(vdb), 3);
  const out = [];
  let on = -1;
  for (let i = 0; i <= env.length; i++) {
    const act = i < env.length && env[i] > 0.45;
    if (act && on < 0) on = i;
    if (!act && on >= 0) { if (i - on > 8) out.push([on / FPS, i / FPS]); on = -1; }
  }
  return out;
}

// Pick a video, it gets chopped into clips, done. The script keeps writing
// itself in the background and gets pushed out through onDone(..., true).
export class Studio {
  constructor({ mode = 'solo', onDone, onProgress, onCancel }) {
    this.mode = mode;
    this.onDone = onDone;
    this.onProgress = onProgress || (() => {});
    this.onCancel = onCancel;
    this.clips = [];
    this.abort = new AbortController();
    this.el = h('section', { class: 'screen studio' });
    this.renderPick();
  }

  destroy() { this.abort.abort(); if (this.src && this.mode !== 'host') URL.revokeObjectURL(this.src); }

  renderPick() {
    const input = h('input', { type: 'file', accept: 'video/*,.mkv,.mov,.m4v', hidden: true, onchange: () => input.files[0] && this.useFile(input.files[0]) });
    const drop = h('label', { class: 'drop' },
      input,
      h('div', { class: 'drop-icon' }, '🎬'),
      h('div', { class: 'drop-title' }, 'Drop a movie clip here'),
      h('div', { class: 'drop-sub' }, 'MP4, MOV, WEBM, MKV. One scene or a whole compilation, it gets split at the cuts automatically.'),
      h('span', { class: 'btn big primary' }, 'Choose video'));
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) this.useFile(f); });
    this.el.replaceChildren(
      h('div', { class: 'studio-head' },
        h('button', { class: 'btn ghost', onclick: () => this.onCancel && this.onCancel() }, '← Back'),
        h('h2', {}, this.mode === 'host' ? 'Pick the movie for your party' : 'Pick a movie')),
      drop,
      h('p', { class: 'fine' }, this.mode === 'host'
        ? 'The video gets uploaded to the room server temporarily so your friends can stream it, and is deleted when the room closes.'
        : 'Solo never uploads anything. The video stays on this device.'));
  }

  async useFile(file) {
    if (!/^video\//.test(file.type) && !/\.(mp4|mov|m4v|webm|mkv|ogv|avi)$/i.test(file.name)) return toast('That doesn’t look like a video.', 'bad');
    this.abort.abort();
    this.abort = new AbortController();
    this.file = file;
    this.words = null;
    this.src = URL.createObjectURL(file);
    this.renderWork();
    this.onFile && this.onFile(file);
    try { await this.analyse(); } catch (e) {
      console.error(e);
      if (!this.abort.signal.aborted) { toast('Couldn’t read that video: ' + e.message, 'bad'); this.renderPick(); }
    }
  }

  setProgress(stage, p) {
    if (this.progEl) {
      this.progEl.querySelector('.prog-stage').textContent = stage;
      this.progEl.querySelector('.bar i').style.width = (p * 100).toFixed(1) + '%';
    }
    this.onProgress({ stage, pct: Math.round(p * 100) });
  }

  renderWork() {
    this.progEl = h('div', { class: 'prog card' },
      h('div', { class: 'prog-stage' }, 'Warming up…'),
      h('div', { class: 'bar' }, h('i')),
      h('div', { class: 'fine' }, `${this.file.name} · ${fmtBytes(this.file.size)}`));
    this.el.replaceChildren(
      h('div', { class: 'studio-head' },
        h('button', { class: 'btn ghost', onclick: () => { this.abort.abort(); this.renderPick(); } }, '← Other video')),
      this.progEl);
  }

  async analyse() {
    const sig = this.abort.signal;
    this.setProgress('Reading the soundtrack', 0.02);
    try {
      this.audio = await decodeAudio(this.file, p => this.setProgress('Reading the soundtrack', p * 0.08));
      this.vdb = voiceDb(this.audio);
    } catch (e) {
      console.warn('audio decode failed', e);
      toast('Couldn’t read this file’s audio, so no scoring or subtitles. MP4 (H.264 + AAC) is the safest bet.', 'bad');
      this.audio = null; this.vdb = new Float32Array(0);
    }
    if (sig.aborted) return;
    this.spans = [];
    if (this.audio) {
      // dialogue sits in the center of the mix, so that's what gets listened to
      const { L, R } = this.audio;
      const mid = new Float32Array(L.length);
      for (let i = 0; i < mid.length; i++) mid[i] = (L[i] + R[i]) * 0.5;
      try {
        this.spans = speechSpans(await vadProbs(mid, p => this.setProgress('Finding the dialogue', 0.08 + p * 0.14)));
      } catch (e) {
        console.error(e);
        toast('Voice detector failed (' + e.message + '), using a rougher loudness check instead.', 'bad');
        this.spans = loudSpans(this.vdb);
      }
    }
    if (sig.aborted) return;
    const res = await detectCuts(this.src, { sensitivity: prefs.get('cutSens2', 0.8), signal: sig, onProgress: p => this.setProgress('Finding every cut', 0.22 + p * 0.6) });
    if (sig.aborted) return;
    this.clips = clipsFromCuts(res.cuts, res.duration, this.spans).map(c => ({ ...c, lines: [], thumb: '', stereo: this.audio ? this.audio.stereo : true }));

    this.setProgress('Grabbing thumbnails', 0.82);
    try {
      await thumbnails(this.src, this.clips.map(c => Math.min(c.end - 0.05, c.start + Math.min(1, (c.end - c.start) / 3))), (i, url) => {
        this.clips[i].thumb = url;
        this.setProgress('Grabbing thumbnails', 0.82 + 0.06 * (i + 1) / this.clips.length);
      });
    } catch (e) { console.warn(e); }
    if (sig.aborted) return;

    // subtitles before playing, unless someone doesn't want to wait
    if (prefs.get('autoScript', true) && this.audio && this.spans.length) {
      let skip;
      const skipped = new Promise(r => { skip = r; });
      this.progEl.append(h('button', { class: 'btn small ghost', onclick: e => { e.target.remove(); skip(); } }, 'Start now, subtitles later'));
      let asr = this.runAsr(p => this.setProgress(p.stage, 0.88 + 0.12 * (p.pct || 0)));
      let first = await Promise.race([asr.then(ok => (ok ? 'done' : 'fail')), skipped.then(() => 'skip')]);
      // a failure gets shown and waits for a decision, it doesn't just vanish
      while (first === 'fail' && !sig.aborted) {
        this.progEl.querySelector('button')?.remove();
        const pick = await new Promise(r => this.progEl.append(h('div', { class: 'asr-fail' },
          h('b', {}, 'Subtitles failed'),
          h('p', { class: 'fine' }, this.asrFailed || 'unknown error'),
          h('div', { class: 'row' },
            h('button', { class: 'btn small primary', onclick: e => { e.target.closest('.asr-fail').remove(); r('retry'); } }, 'Retry'),
            h('button', { class: 'btn small ghost', onclick: e => { e.target.closest('.asr-fail').remove(); r('go'); } }, 'Play without subtitles')))));
        if (pick === 'go') { first = 'done'; break; }
        asr = this.runAsr(p => this.setProgress(p.stage, 0.88 + 0.12 * (p.pct || 0)));
        first = (await asr) ? 'done' : 'fail';
      }
      if (sig.aborted) return;
      this.setProgress('Ready', 1);
      this.finish(false);
      if (first === 'skip') asr.then(ok => { if (ok && !sig.aborted) this.finish(true); });
    } else {
      this.setProgress('Ready', 1);
      this.finish(false);
    }
  }

  async runAsr(onProgress) {
    const sig = this.abort.signal;
    try {
      this.words = await transcribe(this.audio, this.spans, { signal: sig, onProgress: p => { onProgress && onProgress(p); this.onAsr && this.onAsr(p); } });
      if (sig.aborted) return false;
      for (const c of this.clips) c.lines = linesFor(this.words, c.start, c.end);
      this.onAsr && this.onAsr({ stage: 'Subtitles ready', pct: 1 });
      return true;
    } catch (e) {
      console.error(e);
      if (!sig.aborted) {
        this.asrFailed = 'No subtitles: ' + (e.message || String(e)).slice(0, 140);
        this.onAsr && this.onAsr({ stage: this.asrFailed, pct: 0, failed: true });
      }
      return false;
    }
  }

  finish(auto) {
    const clips = this.clips.map(c => ({
      start: c.start, end: c.end, lines: c.lines, thumb: c.thumb, stereo: c.stereo, dialogue: !!c.dialogue,
      env: this.vdb.length ? clipEnvelope(this.vdb, c.start, c.end, this.spans) : '',
    }));
    this.finishedClips = clips;
    this.onDone(clips, { file: this.file, src: this.src }, !!auto);
  }
}
