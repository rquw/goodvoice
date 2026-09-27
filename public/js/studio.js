import { h, fmtBytes, toast, prefs } from './util.js';
import { decodeAudio, voiceDb, detectCuts, speechSpans, buildBoundaries, clipsFromBoundaries, clipEnvelope, thumbnails } from './analyze.js';
import { transcribe, linesFor } from './asr.js';

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
      this.audio = await decodeAudio(this.file, p => this.setProgress('Reading the soundtrack', p * 0.12));
      this.vdb = voiceDb(this.audio);
      this.spans = speechSpans(this.vdb);
    } catch (e) {
      console.warn('audio decode failed', e);
      toast('Couldn’t read this file’s audio, so no scoring or script. MP4 (H.264 + AAC) is the safest bet.', 'bad');
      this.audio = null; this.vdb = new Float32Array(0); this.spans = [];
    }
    if (sig.aborted) return;
    const res = await detectCuts(this.src, { sensitivity: prefs.get('cutSens', 0.5), signal: sig, onProgress: p => this.setProgress('Finding the cuts', 0.12 + p * 0.78) });
    if (sig.aborted) return;
    const bounds = buildBoundaries(res.cuts, res.duration, this.spans, { minLen: 3, maxLen: 20 });
    const clips = clipsFromBoundaries(bounds, res.duration, this.spans);
    this.clips = clips.map(c => ({ ...c, lines: [], thumb: '', stereo: this.audio ? this.audio.stereo : true }));

    this.setProgress('Grabbing thumbnails', 0.92);
    try {
      await thumbnails(this.src, this.clips.map(c => Math.min(c.end - 0.05, c.start + Math.min(1, (c.end - c.start) / 3))), (i, url) => {
        this.clips[i].thumb = url;
        this.setProgress('Grabbing thumbnails', 0.92 + 0.08 * (i + 1) / this.clips.length);
      });
    } catch (e) { console.warn(e); }
    if (sig.aborted) return;
    this.setProgress('Ready', 1);
    this.finish(false);
    if (prefs.get('autoScript', true) && this.audio) this.runAsr();
  }

  async runAsr() {
    const sig = this.abort.signal;
    try {
      this.words = await transcribe(this.audio, this.vdb, { signal: sig, onProgress: p => this.onAsr && this.onAsr(p) });
      if (sig.aborted) return;
      for (const c of this.clips) c.lines = linesFor(this.words, c.start, c.end);
      this.onAsr && this.onAsr({ stage: 'Script ready', pct: 1 });
      this.finish(true);
    } catch (e) {
      console.error(e);
      if (!sig.aborted) this.onAsr && this.onAsr({ stage: 'No auto script (couldn’t load the speech model)', pct: 0, failed: true });
    }
  }

  finish(auto) {
    const clips = this.clips.map(c => ({
      start: c.start, end: c.end, lines: c.lines, thumb: c.thumb, stereo: c.stereo,
      env: this.vdb.length ? clipEnvelope(this.vdb, c.start, c.end, c.lines) : '',
    }));
    this.finishedClips = clips;
    this.onDone(clips, { file: this.file, src: this.src }, !!auto);
  }
}
