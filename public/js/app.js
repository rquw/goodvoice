import { h, $, toast, prefs, sleep, download, fmtBytes, clamp } from './util.js';
import { audioCtx, mic, listMics } from './audio.js';
import { Studio } from './studio.js';
import { Stage } from './stage.js';
import { refEnvelope, takeEnvelope, scoreTake } from './score.js';
import { encodeTake, decodeTake, opusOk } from './codec.js';
import { renderReel } from './export.js';
import { ReelPlayer, reelControls } from './reel.js';
import { Net } from './net.js';
import { MODELS } from './asr.js';
import { sfx } from './sfx.js';
import { FACES, avatar, judgePanel, revealJudges, gauge, setGauge, subBars, floatEmoji, modal } from './ui.js';

const app = $('#app');
let screen = null;

function show(el, cls = '') {
  if (screen && screen.destroy && !screen.persistent) screen.destroy();
  screen = el;
  app.className = cls;
  app.replaceChildren(el.el || el);
  window.scrollTo(0, 0);
}

const me = {
  get name() { return prefs.get('name', ''); },
  set name(v) { prefs.set('name', v); },
  get face() { return prefs.get('face', Math.floor(Math.random() * FACES.length)); },
  set face(v) { prefs.set('face', v); },
};

async function ensureMic() {
  audioCtx();
  if (mic.ok) return true;
  try { await mic.open(); return true; } catch (e) {
    toast(e.name === 'NotAllowedError' ? 'Microphone blocked. Allow it in the address bar and try again.' : 'No microphone: ' + e.message, 'bad');
    return false;
  }
}

function micMeter() {
  const bar = h('i');
  const el = h('div', { class: 'meter', title: 'Mic level' }, bar);
  const buf = new Float32Array(1024);
  let on = true;
  const loop = () => {
    if (!on || !el.isConnected && el._started) return;
    el._started = true;
    if (mic.analyser) {
      mic.analyser.getFloatTimeDomainData(buf);
      let p = 0;
      for (const v of buf) p = Math.max(p, Math.abs(v));
      bar.style.width = clamp(p * 140, 0, 100) + '%';
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return el;
}

function tapToContinue(fn) {
  return new Promise(resolve => {
    const m = h('div', { class: 'tap-wrap', onclick: async () => { m.remove(); audioCtx(); try { resolve(await fn()); } catch (e) { resolve(null); } } },
      h('div', { class: 'tap' }, '👆 Tap to continue'));
    document.body.append(m);
  });
}

async function safePlay(stage, opts) {
  try { return await stage.play(opts); } catch (e) {
    if (e.name === 'NotAllowedError') return tapToContinue(() => stage.play(opts));
    throw e;
  }
}

function makeVoice(pcm, sr) {
  const ac = audioCtx();
  const b = ac.createBuffer(1, pcm.length, sr);
  b.copyToChannel(pcm, 0);
  return b;
}

// ------------------------------------------------------------------ home

function home() {
  const params = new URLSearchParams(location.search);
  const joinCode = (params.get('join') || '').toUpperCase();
  let face = me.face;
  const faceBtn = h('button', { class: 'face-pick', title: 'Change avatar', onclick: () => { face = (face + 1) % FACES.length; me.face = face; faceBtn.textContent = FACES[face]; sfx.click(); } }, FACES[face]);
  const name = h('input', { class: 'name-in', maxLength: 20, placeholder: 'Your name', value: me.name, oninput: e => { me.name = e.target.value.trim(); } });
  const code = h('input', { class: 'code-in', maxLength: 5, placeholder: 'CODE', value: joinCode, autocapitalize: 'characters', oninput: e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); } });
  const needName = () => {
    if (!me.name) { name.focus(); name.classList.add('shake'); setTimeout(() => name.classList.remove('shake'), 500); toast('Pick a name first'); return false; }
    return true;
  };
  const el = h('section', { class: 'screen home' },
    h('div', { class: 'marquee' },
      h('div', { class: 'logo' }, h('span', { class: 'l1' }, 'CHOICER'), h('span', { class: 'mic' }, '🎙'), h('span', { class: 'l2' }, 'VOICER')),
      h('p', { class: 'tag' }, 'Recreate iconic movie moments with your own voice. Watch a short clip, match the character’s timing and delivery as closely as possible, and see how your performance compares.')),
    h('div', { class: 'home-card card' },
      h('div', { class: 'who' }, faceBtn, name),
      h('div', { class: 'home-btns' },
        h('button', { class: 'btn big primary', onclick: () => { audioCtx(); soloStudio(); } }, h('span', {}, '🎬'), ' Solo'),
        h('button', { class: 'btn big hot', onclick: () => { audioCtx(); if (needName()) party.create(); } }, h('span', {}, '🎉'), ' Host a party')),
      h('form', { class: 'join-row', onsubmit: e => { e.preventDefault(); audioCtx(); if (!needName()) return; if (code.value.length < 5) { code.focus(); return toast('Room codes have 5 characters'); } party.join(code.value); } },
        code, h('button', { class: 'btn big', type: 'submit' }, 'Join'))),
    h('div', { class: 'how' },
      step('1', 'Upload', 'Drop in any movie clip or compilation. It gets split at the cuts automatically.'),
      step('2', 'Dub it', 'Countdown, the voices vanish, you say the line. Lyrics scroll karaoke-style.'),
      step('3', 'Redo or next', 'Not happy? Redo. Otherwise on to the next clip until the movie\u2019s done.'),
      step('4', 'Judged', 'Five judges rate rhythm, duration & coverage. Download the dub.')),
    h('footer', { class: 'foot' },
      h('button', { class: 'btn ghost', onclick: settings }, '⚙ Settings'),
      h('span', { class: 'fine' }, 'Everything runs in your browser. Party videos are deleted when the room closes.')));
  show(el, 'is-home');
  if (joinCode) (me.name ? code : name).focus();
}

function step(n, t, d) { return h('div', { class: 'step' }, h('b', {}, n), h('div', {}, h('h4', {}, t), h('p', {}, d))); }

// ------------------------------------------------------------------ settings

async function settings() {
  const mics = await listMics();
  const sel = (key, def, options, onchange) => h('select', { onchange: e => { prefs.set(key, e.target.value); onchange && onchange(e.target.value); } },
    options.map(([v, l]) => h('option', { value: v, selected: prefs.get(key, def) === v }, l)));
  const chk = (key, def, label, onchange) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: prefs.get(key, def), onchange: e => { prefs.set(key, e.target.checked); onchange && onchange(); } }), h('span', {}, label));
  const lat = h('input', { type: 'range', min: -300, max: 300, step: 10, value: prefs.get('latency', 0), oninput: e => { latOut.textContent = e.target.value + ' ms'; prefs.set('latency', +e.target.value); } });
  const latOut = h('b', {}, prefs.get('latency', 0) + ' ms');
  const reopen = () => { if (mic.ok) { mic.close(); ensureMic(); } };
  const body = h('div', { class: 'settings' },
    h('div', { class: 'opt' }, h('label', {}, 'Microphone'),
      sel('micId', '', [['', 'Default'], ...mics.map(m => [m.deviceId, m.label || 'Microphone'])], reopen)),
    chk('aec', true, 'Echo & noise cancellation (turn off when wearing headphones for cleaner audio)', reopen),
    h('div', { class: 'opt' }, h('label', {}, 'Sync offset ', latOut), lat,
      h('p', { class: 'fine' }, 'If your dub plays back late, drag left. Early, drag right. Bluetooth headphones usually need −100 to −250.')),
    h('div', { class: 'opt' }, h('label', {}, 'Solo: while you record you hear'),
      sel('removal', 'center', [['center', 'The clip with voices removed'], ['mute', 'Nothing (muted)'], ['original', 'The original (voices too)']])),
    h('div', { class: 'opt' }, h('label', {}, 'Subtitle model'),
      sel('asrModel2', 'tiny', Object.entries(MODELS).map(([k, m]) => [k, m.label]))),
    h('div', { class: 'opt' }, h('label', {}, 'Subtitle language'),
      sel('asrLang', '', [['', 'Detect automatically'], ['english', 'English'], ['german', 'German'], ['french', 'French'], ['spanish', 'Spanish'], ['italian', 'Italian'], ['japanese', 'Japanese'], ['korean', 'Korean'], ['portuguese', 'Portuguese'], ['russian', 'Russian'], ['turkish', 'Turkish'], ['dutch', 'Dutch'], ['polish', 'Polish'], ['swedish', 'Swedish']])),
    chk('autoScript', true, 'Automatic subtitles (runs on your device)'),
    chk('asrGpu', false, 'Use the GPU for subtitles (faster, experimental)'),
    h('div', { class: 'opt' }, h('label', {}, 'Cut detection sensitivity'),
      h('input', { type: 'range', min: 0, max: 1, step: 0.1, value: prefs.get('cutSens2', 0.8), onchange: e => prefs.set('cutSens2', +e.target.value) })),
    chk('sfxOff', false, 'Mute game sounds'),
    h('div', { class: 'opt' }, h('button', { class: 'btn', onclick: async () => { if (await ensureMic()) toast('Mic works 🎙'); } }, 'Test microphone'), micMeter()));
  modal('Settings', body);
}

// ------------------------------------------------------------------ solo

function soloStudio() {
  const studio = new Studio({
    mode: 'solo',
    onCancel: () => { studio.destroy(); home(); },
    onDone: (clips, info, auto) => {
      if (auto) { studio.soloUpdate && studio.soloUpdate(clips); return; }
      if (!clips.length) { toast('No clips found in that video.', 'bad'); studio.renderPick(); return; }
      soloPlay(clips, info, studio);
    },
  });
  studio.onAsr = p => studio.asrNote && studio.asrNote(p);
  studio.persistent = true;
  show(studio, 'is-studio');
}

// One pass through every clip: record, then redo or move on.
function soloPlay(clips, info, studio) {
  const stage = new Stage();
  const takes = clips.map(() => null);
  // only clips with someone talking get dubbed; the rest come back in the final cut
  const order = clips.map((c, k) => k).filter(k => clips[k].dialogue !== false);
  let i = 0;
  const cur = () => order[i];
  let busy = false;
  const removal = prefs.get('removal', 'center');

  const title = h('div', { class: 'play-title' });
  const bar = h('div', { class: 'bar thin progress' }, h('i'));
  const note = h('div', { class: 'fine asr-note' });
  const resultBox = h('div', { class: 'result card hidden' });
  const g = gauge();
  const bars = h('div');
  const jp = judgePanel();
  resultBox.append(h('div', { class: 'result-top' }, g, bars), jp);

  const btnRec = h('button', { class: 'btn big rec', onclick: () => record() }, '🎙 Record');
  const btnRedo = h('button', { class: 'btn big', onclick: () => record() }, '↻ Redo');
  const btnWatch = h('button', { class: 'btn big ghost', onclick: () => watch() }, '▶ Watch');
  const btnNext = h('button', { class: 'btn big primary', onclick: () => go(i + 1) });
  const controls = h('div', { class: 'controls' });

  const el = h('section', { class: 'screen play' },
    h('div', { class: 'play-head' },
      h('button', { class: 'btn ghost', onclick: () => { if (!takes.some(Boolean) || confirm('Quit? Your takes will be lost.')) { studio.destroy(); home(); } } }, '✕'),
      title,
      h('span', { class: 'fine' }, '')),
    bar,
    h('div', { class: 'play-grid' },
      h('div', { class: 'play-main' }, stage.el, controls, micMeter(), note),
      h('aside', { class: 'play-side' }, resultBox)));

  show({ el, destroy: () => stage.destroy() }, 'is-play');

  studio.asrNote = p => { note.textContent = p.pct >= 1 || p.failed ? p.stage : `${p.stage}${p.pct ? ` ${Math.round(p.pct * 100)}%` : ''}…`; if (p.pct >= 1) setTimeout(() => { note.textContent = ''; }, 3000); };
  studio.soloUpdate = updated => {
    updated.forEach((c, k) => { if (clips[k]) { clips[k].lines = c.lines; clips[k].env = c.env; } });
    if (stage.clip && !busy && order.length) stage.cue(clips[cur()]).catch(() => {});
  };

  function sync() {
    title.replaceChildren(h('b', {}, `Line ${i + 1}`), h('span', {}, ` / ${order.length}`));
    bar.firstChild.style.width = (i / order.length * 100) + '%';
    btnNext.textContent = i === order.length - 1 ? 'Finish →' : 'Next →';
    const t = takes[cur()];
    controls.replaceChildren(...(busy ? [] : t ? [btnRedo, btnWatch, btnNext] : [btnRec]));
  }

  async function go(k) {
    if (k >= order.length) return finish();
    stage.stopAll(); busy = false;
    i = k;
    resultBox.classList.add('hidden');
    sync();
    await stage.load(info.src, clips[cur()]);
  }

  async function record() {
    if (busy) return;
    audioCtx();
    if (!(await ensureMic())) return;
    const ci = cur();
    const clip = clips[ci];
    busy = true; sync();
    resultBox.classList.add('hidden');
    try {
      const res = await safePlay(stage, { removal, record: true, countdown: true });
      if (res && res.pcm) {
        const env = await takeEnvelope(res.pcm, res.sr);
        const score = scoreTake(refEnvelope(clip), env, `solo:${ci}:${Date.now()}`);
        takes[ci] = { env, score, voice: makeVoice(res.pcm, res.sr) };
        stage.showTake(env);
        busy = false; sync();
        await showResult(score);
      }
    } catch (e) { console.error(e); toast(e.message, 'bad'); }
    busy = false; sync();
  }

  async function watch() {
    if (busy || !takes[cur()]) return;
    busy = true; sync();
    try { await safePlay(stage, { removal, voice: takes[cur()].voice }); } catch (e) { toast(e.message, 'bad'); }
    busy = false; sync();
  }

  async function showResult(score) {
    resultBox.classList.remove('hidden');
    bars.replaceChildren(subBars(score));
    await Promise.all([setGauge(g, score), revealJudges(jp, score)]);
    if (score.judgePts === 5) { sfx.fanfare(); confetti(); }
  }

  function finish() {
    stage.stopAll();
    const done = clips.map((c, k) => ({ c, k, t: takes[k] })).filter(x => x.t);
    const avg = done.length ? Math.round(done.reduce((a, x) => a + x.t.score.total, 0) / done.length) : 0;
    const stars = done.reduce((a, x) => a + x.t.score.judgePts, 0);
    const segs = clips.map((c, k) => takes[k]
      ? { clip: c, voice: takes[k].voice, name: me.name || 'You', color: '#ffd23f', removal }
      : { clip: c, voice: null, name: '', removal: c.dialogue !== false ? removal : 'original' });
    const st = new Stage();
    let reel = null;
    const main = h('div', { class: 'play-main' });
    if (segs.length) {
      reel = new ReelPlayer(st, segs, removal);
      main.append(st.el, reelControls(reel, { onPlay: p => reel.play(p).catch(() => {}), onPause: p => reel.pause(p), onSeek: p => (reel.playing ? reel.play(p) : reel.pause(p)) }));
    }
    const el2 = h('section', { class: 'screen summary' },
      h('div', { class: 'play-head' }, h('span'), h('div', { class: 'play-title' }, h('b', {}, 'Your dub')), h('span')),
      h('div', { class: 'play-grid' },
        main,
        h('aside', { class: 'play-side' },
          h('div', { class: 'sum-top card' },
            h('div', { class: 'big-stat' }, h('b', {}, avg + '%'), h('span', {}, 'average')),
            h('div', { class: 'big-stat' }, h('b', {}, `${done.length}/${order.length}`), h('span', {}, 'lines dubbed')),
            h('div', { class: 'big-stat' }, h('b', {}, '★ ' + stars), h('span', {}, 'stars'))),
          h('div', { class: 'final-btns col' },
            segs.length ? h('button', { class: 'btn big primary', onclick: () => { reel.pause(); exportFlow({ src: info.src, segments: segs, name: 'choicer-voicer-dub' }); } }, '⬇ Download') : null,
            h('button', { class: 'btn big', onclick: () => soloPlay(clips, info, studio) }, '↻ Again'),
            h('button', { class: 'btn big ghost', onclick: () => { studio.destroy(); home(); } }, 'Home')))));
    show({ el: el2, destroy: () => { reel && reel.destroy(); st.destroy(); } }, 'is-summary');
    if (reel) st.load(info.src).then(() => reel.play(0)).catch(e => { if (e.name === 'NotAllowedError') tapToContinue(() => reel.play(0)); });
  }

  if (!order.length) { toast('No dialogue found in that video.', 'bad'); finish(); return; }
  go(0);
}

async function exportFlow({ src, segments, name }) {
  const preview = h('div', { class: 'render-prev' });
  const bar = h('i');
  const note = h('p', { class: 'fine' }, 'Rendering in real time on this device. Leave this tab open.');
  const ac = new AbortController();
  const m = modal('Rendering your dub', h('div', {}, preview, h('div', { class: 'bar' }, bar), note), { onClose: () => ac.abort(), wide: true });
  try {
    const blob = await renderReel({
      src, segments, preview, signal: ac.signal,
      onProgress: p => { bar.style.width = (p * 100).toFixed(1) + '%'; },
      onState: st => { note.textContent = st === 'hidden' ? 'Paused because the tab was hidden. It continues where it left off.' : 'Rendering in real time on this device. Leave this tab open.'; },
    });
    const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
    download(blob, `${name}.${ext}`);
    note.textContent = `Done · ${fmtBytes(blob.size)} · saved as ${name}.${ext}`;
    bar.style.width = '100%';
    setTimeout(() => m.close(), 2500);
  } catch (e) {
    if (!ac.signal.aborted) { console.error(e); note.textContent = 'Render failed: ' + e.message; }
  }
}

function confetti() {
  const box = h('div', { class: 'confetti' });
  for (let k = 0; k < 80; k++) {
    box.append(h('i', { style: {
      left: Math.random() * 100 + '%', background: ['#ffd23f', '#ff3e7f', '#3ee0ff', '#3ddc97', '#b388ff'][k % 5],
      animationDelay: Math.random() * 0.6 + 's', animationDuration: 1.8 + Math.random() * 1.6 + 's', transform: `rotate(${Math.random() * 360}deg)`,
    } }));
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 4000);
}

// ------------------------------------------------------------------ party

const party = {
  net: null,
  room: null,
  clips: [],
  local: null,       // host's local file url
  studio: null,
  stage: null,
  key: '',
  takeCache: new Map(),
  myTakes: [],
  uploading: null,

  boot() {
    const net = new Net();
    opusOk().then(ok => { net.opus = ok; });
    this.net = net;
    net.on('welcome', () => { sfx.join(); history.replaceState(null, '', `?join=${net.code}`); });
    net.on('state', m => this.onState(m.room));
    net.on('clips', m => { this.clips = m.clips; this.clipsRev = m.rev; if (this.room) this.render(true); });
    net.on('error', m => { toast(m.msg || 'Error', 'bad'); if (m.code === 'no_room' || m.code === 'full') { this.exit(); } });
    net.on('kicked', () => { toast('You were kicked from the room.', 'bad'); this.exit(); });
    net.on('react', m => { const box = $('.stage-frame'); if (box) floatEmoji(box, m.e); });
    net.on('down', () => { const b = $('.conn'); if (b) b.classList.add('off'); });
    net.on('open', () => { const b = $('.conn'); if (b) b.classList.remove('off'); });
    return net;
  },

  create() { this.reset(); this.boot().create(me.name, me.face); this.waiting(); },
  join(code) { this.reset(); this.boot().join(code, me.name, me.face); this.waiting(); },
  waiting() { show(h('section', { class: 'screen center-screen' }, h('div', { class: 'spinner' }), h('p', {}, 'Connecting…'))); },
  reset() {
    this.dropReel && this.dropReel();
    this.room = null; this.clips = []; this.key = ''; this.local = null; this.takeCache = new Map(); this.myTakes = [];
    if (this.stage) this.stage.destroy();
    this.stage = null;
  },
  exit() {
    if (this.net) this.net.leave();
    if (this.uploading) try { this.uploading.abort(); } catch {}
    if (this.studio) this.studio.destroy();
    this.studio = null;
    this.reset();
    history.replaceState(null, '', location.pathname);
    home();
  },

  get isHost() { return this.room && this.room.hostId === this.net.pid; },
  get meP() { return this.room && this.room.players.find(p => p.id === this.net.pid); },
  player(id) { return this.room && this.room.players.find(p => p.id === id); },
  get clip() { return this.room && this.room.clip != null ? this.clips[this.room.clip] : null; },
  get mediaSrc() {
    if (!this.room || !this.room.media) return null;
    if (this.local && this.local.id === this.room.media.id) return this.local.src;
    return (window.CV_SERVER || '') + this.room.media.url;
  },

  onState(room) {
    const prev = this.room;
    this.room = room;
    const key = `${room.phase}:${room.round}:${room.showIdx}`;
    const phaseChanged = key !== this.key;
    this.key = key;
    if (prev && prev.players.length < room.players.length) sfx.join();
    this.render(phaseChanged);
  },

  ensureStage() {
    if (!this.stage) this.stage = new Stage();
    return this.stage;
  },

  render(phaseChanged) {
    if (this.studio && this.studioOpen) { this.renderTop(); return; }
    const r = this.room;
    if (!r) return;
    if (r.phase === 'lobby') return phaseChanged || !$('.lobby') ? this.lobby() : this.updateLobby();
    if (phaseChanged || !$('.game')) this.game(phaseChanged);
    else this.updateGame();
  },

  // ---------------- lobby
  lobby() {
    const r = this.room;
    if (this.stage) this.stage.stopAll();
    const link = `${location.origin}${location.pathname}?join=${r.code}`;
    const el = h('section', { class: 'screen lobby' },
      h('div', { class: 'lobby-head' },
        h('button', { class: 'btn ghost', onclick: () => this.exit() }, '← Leave'),
        h('div', { class: 'conn', title: 'Connection' })),
      h('div', { class: 'lobby-grid' },
        h('div', { class: 'card code-card' },
          h('span', { class: 'fine' }, 'Room code'),
          h('div', { class: 'room-code', onclick: () => copy(link) }, r.code),
          h('button', { class: 'btn small', onclick: () => copy(link) }, '🔗 Copy invite link'),
          h('div', { class: 'players' }),
          h('div', { class: 'mic-test' }, h('button', { class: 'btn small ghost', onclick: async () => { if (await ensureMic()) toast('Mic ready 🎙'); } }, '🎙 Test mic'), micMeter()),
          h('p', { class: 'fine' }, 'Headphones = better scores. Your mic hears the speakers otherwise.')),
        h('div', { class: 'card host-card' })));
    show({ el }, 'is-lobby');
    this.updateLobby();
  },

  updateLobby() {
    const r = this.room;
    const pl = $('.lobby .players');
    if (!pl) return;
    pl.replaceChildren(...r.players.map(p => h('div', { class: 'player' + (p.connected ? '' : ' away') },
      avatar(p), h('span', { class: 'pname' }, p.name, p.id === this.net.pid ? h('small', {}, ' (you)') : null),
      p.id === r.hostId ? h('span', { class: 'crown', title: 'Host' }, '👑') : null,
      this.isHost && p.id !== this.net.pid ? h('button', { class: 'btn tiny ghost', title: 'Kick', onclick: () => this.net.send({ t: 'kick', pid: p.id }) }, '✕') : null)));
    const box = $('.lobby .host-card');
    if (this.isHost) box.replaceChildren(...this.hostPanel());
    else box.replaceChildren(...this.guestPanel());
  },

  hostPanel() {
    const r = this.room;
    const s = r.settings;
    const set = patch => this.net.send({ t: 'settings', settings: { ...s, ...patch } });
    const up = this.uploadState;
    const clips = this.clips;
    const ready = r.media && clips.length && !up;
    return [
      h('h3', {}, 'You’re the host'),
      h('div', { class: 'host-media' },
        clips.length ? h('div', { class: 'thumbs' }, clips.slice(0, 12).map(c => h('img', { src: c.thumb || '' }))) : null,
        h('div', { class: 'grow' },
          h('b', {}, clips.length ? `${clips.length} clip${clips.length > 1 ? 's' : ''} ready` : r.media ? 'Video uploaded, no clips picked' : 'No video yet'),
          up ? h('div', {}, h('div', { class: 'fine' }, up.text), h('div', { class: 'bar' }, h('i', { style: { width: (up.p * 100).toFixed(1) + '%' } }))) : null,
          r.prep && !clips.length ? h('div', { class: 'fine' }, `${r.prep.stage} ${r.prep.pct}%`) : null),
        h('button', { class: 'btn primary', onclick: () => this.openStudio() }, clips.length || r.media ? 'Other video' : '🎬 Choose video')),
      h('div', { class: 'opts' },
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.listen, onchange: e => set({ listen: e.target.checked }) }), h('span', {}, 'Play the original before recording')),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.voting, onchange: e => set({ voting: e.target.checked }) }), h('span', {}, 'Audience vote after every round')),
        h('div', { class: 'opt' }, h('label', {}, 'While recording'),
          h('div', { class: 'seg' }, [['center', 'Voices removed'], ['mute', 'Muted'], ['original', 'Original']].map(([k, l]) =>
            h('button', { class: 'seg-b' + (s.removal === k ? ' on' : ''), onclick: () => set({ removal: k }) }, l))))),
      h('button', { class: 'btn big hot wide', disabled: !ready, onclick: () => this.net.send({ t: 'start' }) },
        ready ? `Start game · ${r.players.length} player${r.players.length > 1 ? 's' : ''}` : up ? 'Uploading…' : 'Choose a video first'),
    ];
  },

  guestPanel() {
    const r = this.room;
    const host = this.player(r.hostId);
    return [
      h('h3', {}, 'Waiting for ', host ? host.name : 'the host'),
      this.clips.length ? h('div', { class: 'thumbs' }, this.clips.slice(0, 12).map(c => h('img', { src: c.thumb || '' }))) : h('div', { class: 'spinner small' }),
      h('p', {}, this.clips.length ? `${this.clips.length} clips loaded. Game starts when the host hits start.` : r.prep ? `Host is ${r.prep.stage.toLowerCase()} (${r.prep.pct}%)` : 'The host is picking a movie clip…'),
      h('p', { class: 'fine' }, `${this.clips.length || '?'} clips · ${r.settings.voting ? 'audience vote on' : 'judges only'}`),
    ];
  },

  openStudio() {
    if (this.studio) { this.studio.destroy(); this.studio = null; }
    const studio = new Studio({
      mode: 'host',
      onCancel: () => { this.studioOpen = false; this.studio = null; studio.destroy(); this.net.send({ t: 'prep', prep: null }); this.lobby(); },
      onProgress: p => { if (!this._prepT || Date.now() - this._prepT > 700 || p.pct >= 100) { this._prepT = Date.now(); this.net.send({ t: 'prep', prep: p }); } },
      onDone: (clips, info, auto) => {
        studio.finishedClips = clips;
        this.net.send({ t: 'clips', clips });
        this.net.send({ t: 'prep', prep: null });
        if (auto) return;
        studio.hosted = true;
        this.studioOpen = false;
        this.lobby();
      },
    });
    studio.onFile = file => this.uploadVideo(file, studio);
    this.studio = studio;
    this.studioOpen = true;
    show({ el: studio.el }, 'is-studio');
  },

  renderTop() {},

  async uploadVideo(file, studio) {
    if (this.uploading) try { this.uploading.abort(); } catch {}
    this.uploadState = { p: 0, text: `Uploading ${fmtBytes(file.size)}…` };
    const t0 = Date.now();
    try {
      const res = await this.net.upload(`/api/upload/${this.net.code}`, file, { 'x-name': encodeURIComponent(file.name), 'content-type': file.type || 'video/mp4' }, p => {
        const sec = (Date.now() - t0) / 1000;
        const eta = p > 0.02 ? Math.round(sec / p - sec) : null;
        this.uploadState = { p, text: `Uploading ${fmtBytes(file.size)} · ${Math.round(p * 100)}%${eta != null ? ` · ~${eta}s left` : ''}` };
        if (!this.studioOpen && this.room && this.room.phase === 'lobby') this.updateLobby();
      });
      this.uploading = null;
      this.local = { id: res.id, src: studio.src };
      this.uploadState = null;
      if (studio.finishedClips) this.net.send({ t: 'clips', clips: studio.finishedClips || [] });
      toast('Video uploaded ✓');
    } catch (e) {
      this.uploadState = null;
      toast(e.message, 'bad');
    }
    if (!this.studioOpen) this.updateLobby();
  },

  // ---------------- game
  game(phaseChanged) {
    const r = this.room;
    const stage = this.ensureStage();
    if (!$('.game')) {
      this.side = h('div', { class: 'game-side' });
      this.panel = h('div', { class: 'game-panel' });
      this.topbar = h('div', { class: 'game-top' });
      const reacts = h('div', { class: 'reacts' }, ['😂', '🔥', '👏', '💀', '😭', '🤌'].map(e => h('button', { class: 'react', onclick: () => this.net.send({ t: 'react', e }) }, e)));
      const el = h('section', { class: 'screen game' }, this.topbar,
        h('div', { class: 'game-grid' }, h('div', { class: 'game-main' }, stage.el, reacts), h('div', { class: 'game-col' }, this.panel, this.side)));
      show({ el }, 'is-game');
      clearInterval(this.clock);
      this.clock = setInterval(() => this.tickClock(), 250);
    }
    this.updateGame();
    if (phaseChanged) this.enterPhase(r.phase).catch(e => { console.error(e); toast(e.message, 'bad'); });
  },

  tickClock() {
    const t = $('.game-top .timer');
    if (!t || !this.room) return;
    const left = this.room.deadline ? Math.max(0, Math.ceil((this.room.deadline - this.net.now()) / 1000)) : null;
    t.textContent = left == null ? '' : left + 's';
  },

  updateGame() {
    const r = this.room;
    if (!this.topbar) return;
    const label = { loading: 'Get ready', preview: 'Listen', record: 'Record!', showcase: 'Showtime', vote: 'Vote', reveal: 'Results', final: 'Final' }[r.phase] || r.phase;
    this.topbar.replaceChildren(
      h('button', { class: 'btn ghost small', onclick: () => { if (confirm('Leave the game?')) this.exit(); } }, '✕'),
      h('div', { class: 'round' }, r.phase === 'final' ? 'Game over' : `Clip ${r.round + 1}/${r.rounds}`),
      h('div', { class: 'phase ph-' + r.phase }, label),
      h('div', { class: 'timer' }),
      this.isHost && r.phase !== 'final' ? h('button', { class: 'btn ghost small', onclick: () => this.net.send({ t: 'skip' }) }, 'Skip ⏭') : h('span'),
      h('div', { class: 'conn' }));
    this.tickClock();
    const takes = new Map(r.takes.map(t => [t.pid, t]));
    const rows = [...r.players].sort((a, b) => b.points - a.points);
    this.side.replaceChildren(h('h4', {}, 'Scoreboard'), ...rows.map(p => {
      let st = '';
      if (r.phase === 'loading') st = r.loaded.includes(p.id) ? '✓' : '…';
      if (r.phase === 'record') st = takes.has(p.id) ? '✓' : p.joinedRound > r.round ? 'next' : '🎙';
      if (r.phase === 'vote') st = r.voted.includes(p.id) ? '✓' : '…';
      return h('div', { class: 'srow' + (p.connected ? '' : ' away') + (p.id === this.net.pid ? ' me' : '') },
        avatar(p, 'sm'), h('span', { class: 'pname' }, p.name), h('span', { class: 'st' }, st), h('b', {}, p.points));
    }));
    if (r.phase === 'vote') this.updateVote();
    if (r.phase === 'final') this.syncWatch();
  },

  async enterPhase(phase) {
    const r = this.room;
    const stage = this.stage;
    const key = this.key;
    const still = () => this.key === key;
    const clip = this.clip;
    this.dropReel();
    stage.setBadge('');
    if (phase === 'final') return this.final();
    if (!clip) { this.panel.replaceChildren(h('p', {}, 'Waiting for clips…')); return; }
    const removal = r.settings.removal;
    const me = this.meP;
    const playing = me && me.joinedRound <= r.round;

    if (phase === 'loading') {
      if (r.round === 0) { this.myTakes = []; this.takeCache = new Map(); }
      this.panel.replaceChildren(h('div', { class: 'phase-card' }, h('h2', {}, `Clip ${r.round + 1} of ${r.rounds}`), h('p', {}, 'Loading the clip…'), h('div', { class: 'spinner small' })));
      try { await stage.load(this.mediaSrc, clip); } catch (e) { console.warn(e); }
      if (still()) this.net.send({ t: 'loaded', round: r.round });
      if (playing && !mic.ok) ensureMic();
      return;
    }

    if (phase === 'preview') {
      this.panel.replaceChildren(h('div', { class: 'phase-card' }, h('h2', {}, '👂 Listen closely'), h('p', {}, 'This is the original. You’re up next.')));
      await stage.load(this.mediaSrc, clip);
      if (!still()) return;
      await safePlay(stage, { removal: 'original' });
      return;
    }

    if (phase === 'record') {
      if (!playing) {
        this.panel.replaceChildren(h('div', { class: 'phase-card' }, h('h2', {}, 'You’re in next round'), h('p', {}, 'Everyone else is recording right now.')));
        return;
      }
      this.panel.replaceChildren(h('div', { class: 'phase-card' }, h('h2', {}, '🎙 Your turn'), h('p', {}, 'Everyone records at the same time. Match the timing!'), micMeter()));
      if (!(await ensureMic())) { this.panel.replaceChildren(h('div', { class: 'phase-card' }, h('h2', {}, 'No mic 😶'), h('p', {}, 'Allow the microphone to play.'))); return; }
      await stage.load(this.mediaSrc, clip);
      if (!still()) return;
      const res = await safePlay(stage, { removal, record: true, countdown: true });
      if (!still() || !res || !res.pcm) return;
      const env = await takeEnvelope(res.pcm, res.sr);
      const score = scoreTake(refEnvelope(clip), env, `${r.code}:${r.round}:${this.net.pid}`);
      stage.showTake(env);
      this.panel.replaceChildren(h('div', { class: 'phase-card' }, h('h2', {}, 'Sending your take…'), h('div', { class: 'spinner small' })));
      const enc = await encodeTake(res.pcm, res.sr, r.players.every(p => p.opus !== false));
      this.takeCache.set(`${r.round}:${this.net.pid}`, makeVoice(res.pcm, res.sr));
      this.myTakes.push({ round: r.round, clip: r.clip, voice: makeVoice(res.pcm, res.sr), score });
      const meta = { total: score.total, rhythm: score.rhythm, duration: score.duration, coverage: score.coverage, judgePts: score.judgePts, judges: score.judges };
      try {
        await this.net.upload(`/api/take/${r.code}/${r.round}`, enc.blob, { 'x-meta': encodeURIComponent(JSON.stringify(meta)), 'x-fmt': enc.fmt });
        if (still()) this.panel.replaceChildren(h('div', { class: 'phase-card' }, h('h2', {}, 'Take sent ✓'), h('p', {}, 'Waiting for the others…')));
      } catch (e) {
        toast(e.message, 'bad');
      }
      return;
    }

    if (phase === 'showcase') {
      const pid = r.showOrder[r.showIdx];
      const take = r.takes.find(t => t.pid === pid);
      const p = this.player(pid) || { name: '?', color: '#fff', face: 0 };
      const g = gauge(), jp = judgePanel();
      const res = h('div', { class: 'result card hidden' }, h('div', { class: 'result-top' }, g, take ? subBars(take.score) : null), jp);
      this.panel.replaceChildren(h('div', { class: 'now-up' }, avatar(p), h('div', {}, h('small', {}, `Take ${r.showIdx + 1} of ${r.showOrder.length}`), h('b', {}, p.name))), res);
      stage.setBadge('🎙 ' + p.name, p.color);
      this.prefetchTakes();
      const voice = take ? await Promise.race([this.getTake(r.round, take).catch(() => null), sleep(6000).then(() => null)]) : null;
      if (!still()) return;
      await stage.load(this.mediaSrc, clip);
      if (!still()) return;
      if (voice) takeEnvelope(voice.getChannelData(0), voice.sampleRate).then(env => { if (still()) stage.showTake(env); });
      await safePlay(stage, { removal, voice });
      if (!still() || !take) return;
      res.classList.remove('hidden');
      const sc = { ...take.score, grade: gradeOf(take.score.total) };
      await Promise.all([setGauge(g, sc), revealJudges(jp, sc)]);
      if (sc.judgePts === 5) { sfx.fanfare(); confetti(); }
      return;
    }

    if (phase === 'vote') {
      this.myVote = null;
      this.voteBox = h('div', { class: 'vote-grid' });
      this.panel.replaceChildren(h('div', { class: 'phase-card' }, h('h2', {}, '🗳 Vote for the best dub'), h('p', {}, 'Not your own. Tap ▶ to rewatch a take.')), this.voteBox);
      this.updateVote();
      return;
    }

    if (phase === 'reveal') {
      stage.stopAll();
      const last = r.history[r.history.length - 1];
      const board = [...r.players].sort((a, b) => b.points - a.points);
      sfx.fanfare();
      this.panel.replaceChildren(
        h('div', { class: 'phase-card' }, h('h2', {}, last && last.takes[0] ? `🏆 ${last.takes[0].name} takes the round` : 'Round over')),
        h('div', { class: 'reveal-list' }, (last ? last.takes : []).map((t, k) => {
          const p = this.player(t.pid) || { name: t.name, color: '#fff', face: 0 };
          return h('div', { class: 'reveal-row card', style: { animationDelay: k * 0.12 + 's' } },
            h('span', { class: 'rank' }, '#' + (k + 1)), avatar(p, 'sm'), h('b', { class: 'grow' }, p.name),
            h('span', { class: 'fine' }, `${t.total}% · ★${t.judges}${r.settings.voting ? ` · 🗳${t.votes}` : ''}`),
            h('span', { class: 'plus' }, '+' + t.points));
        })),
        h('p', { class: 'fine center' }, `Leader: ${board[0] ? board[0].name : '-'} with ${board[0] ? board[0].points : 0} pts`));
    }
  },

  updateVote() {
    const r = this.room;
    if (!this.voteBox) return;
    const mine = r.voted.includes(this.net.pid);
    const myVote = this.myVote;
    this.voteBox.replaceChildren(...r.takes.map(t => {
      const p = this.player(t.pid) || { name: '?', color: '#fff', face: 0 };
      const self = t.pid === this.net.pid;
      return h('div', { class: 'vote-card card' + (myVote === t.pid ? ' picked' : '') },
        avatar(p), h('b', {}, p.name), h('span', { class: 'fine' }, `${t.score.total}% · ★${t.score.judgePts}`),
        h('div', { class: 'row' },
          h('button', { class: 'btn small ghost', onclick: () => this.replay(t) }, '▶'),
          h('button', { class: 'btn small primary', disabled: self || mine, onclick: () => { this.myVote = t.pid; this.net.send({ t: 'vote', target: t.pid }); sfx.click(); } }, self ? 'you' : myVote === t.pid ? 'voted ✓' : 'Vote')));
    }));
  },

  async replay(t) {
    const voice = await this.getTake(this.room.round, t);
    const p = this.player(t.pid);
    this.stage.setBadge('🎙 ' + (p ? p.name : ''), p && p.color);
    await this.stage.load(this.mediaSrc, this.clip);
    await safePlay(this.stage, { removal: this.room.settings.removal, voice });
  },

  prefetchTakes() {
    for (const t of this.room.takes) this.getTake(this.room.round, t).catch(() => {});
  },

  getTake(round, t) {
    const k = `${round}:${t.pid}`;
    if (!this.takeCache.has(k)) {
      this.takeCache.set(k, (async () => {
        const res = await fetch((window.CV_SERVER || '') + t.url);
        if (!res.ok) throw new Error('take missing');
        return decodeTake(await res.arrayBuffer(), audioCtx());
      })().catch(e => { this.takeCache.delete(k); throw e; }));
    }
    return Promise.resolve(this.takeCache.get(k));
  },

  final() {
    const r = this.room;
    this.stage.stopAll();
    this.voteBox = null;
    const board = [...r.players].filter(p => p.rounds > 0 || p.points > 0).sort((a, b) => b.points - a.points || b.accSum - a.accSum);
    const podium = h('div', { class: 'podium' }, [1, 0, 2].map(k => board[k] ? h('div', { class: `pod p${k + 1}` },
      avatar(board[k], 'lg'), h('b', {}, board[k].name), h('span', {}, board[k].points + ' pts'), h('div', { class: 'block' }, k + 1)) : null));
    sfx.fanfare(); confetti();
    this.panel.replaceChildren(
      h('div', { class: 'phase-card' }, h('h2', {}, board[0] ? `👑 ${board[0].name} wins!` : 'Game over'), h('p', {}, 'The full dub is playing for everyone. Pause and seek are shared.')),
      podium,
      h('div', { class: 'final-list' }, board.map((p, k) => h('div', { class: 'srow card' },
        h('span', { class: 'rank' }, '#' + (k + 1)), avatar(p, 'sm'), h('b', { class: 'grow' }, p.name),
        h('span', { class: 'fine' }, `avg ${p.rounds ? Math.round(p.accSum / p.rounds) : 0}% · ★${p.judgePts} · 🗳${p.votesGot}`), h('b', {}, p.points)))),
      h('div', { class: 'final-btns' },
        h('button', { class: 'btn big primary', onclick: () => this.exportBest() }, '⬇ Download'),
        this.myTakes.length ? h('button', { class: 'btn big', onclick: () => this.exportMine() }, '⬇ Only my takes') : null,
        this.isHost ? h('button', { class: 'btn big hot', onclick: () => this.net.send({ t: 'start' }) }, '↻ Play again') : null,
        this.isHost ? h('button', { class: 'btn big ghost', onclick: () => this.net.send({ t: 'lobby' }) }, 'Lobby') : null));
    this.buildReel();
  },

  // the movie with every clip's winning take, same on every screen
  async reelSegments() {
    const r = this.room;
    const byClip = new Map(r.history.map((e, k) => [e.clip, { e, k }]));
    const segs = [];
    for (let ci = 0; ci < this.clips.length; ci++) {
      const clip = this.clips[ci];
      const hit = byClip.get(ci);
      const top = hit && hit.e.takes[0];
      let voice = null;
      if (top) try { voice = await this.getTake(hit.k, { pid: top.pid, url: top.url }); } catch {}
      const p = top && this.player(top.pid);
      segs.push({ clip, voice, name: top ? top.name : '', color: p ? p.color : '#ffd23f', removal: hit || clip.dialogue ? r.settings.removal : 'original' });
    }
    return segs;
  },

  async buildReel() {
    const key = this.key;
    this.dropReel();
    const holder = h('div', { class: 'reel-holder' }, h('div', { class: 'fine center' }, 'Loading the full dub…'));
    this.stage.el.after(holder);
    this.reelHolder = holder;
    const segs = await this.reelSegments();
    if (key !== this.key || !segs.length) { holder.textContent = segs.length ? '' : 'Nothing to play.'; return; }
    const reel = new ReelPlayer(this.stage, segs, this.room.settings.removal);
    this.reel = reel;
    const send = (action, pos) => this.net.send({ t: 'watch', action, pos });
    holder.replaceChildren(reelControls(reel, {
      onPlay: p => { if (p >= reel.total - 0.05) p = 0; reel.play(p).catch(() => {}); send('play', p); },
      onPause: p => { reel.pause(p); send('pause', p); },
      onSeek: p => { reel.playing ? reel.play(p).catch(() => {}) : reel.pause(p); send('seek', p); },
    }));
    await reel.pause(0);
    clearInterval(this.watchTimer);
    this.watchTimer = setInterval(() => this.syncWatch(), 500);
    this.syncWatch();
  },

  dropReel() {
    clearInterval(this.watchTimer);
    if (this.reel) { this.reel.destroy(); this.reel = null; }
    if (this.reelHolder) { this.reelHolder.remove(); this.reelHolder = null; }
    if (this.stage) this.stage.setBadge('');
  },

  syncWatch() {
    const w = this.room && this.room.watch;
    const reel = this.reel;
    if (!w || !reel || reel.busy) return;
    if (w.playing) {
      const target = w.pos + (this.net.now() - w.at) / 1000;
      if (target < 0) { if (reel.playing) reel.pause(w.pos); return; }
      if (target >= reel.total) { if (reel.playing) reel.pause(reel.total); return; }
      if (!reel.playing || Math.abs(reel.pos - target) > 0.2) {
        reel.play(target + 0.1).catch(e => { if (e.name === 'NotAllowedError') tapToContinue(() => this.syncWatch()); });
      }
    } else if (reel.playing || Math.abs(reel.pos - w.pos) > 0.05) {
      reel.pause(w.pos);
    }
  },

  async exportMine() {
    const segs = this.myTakes.map(t => ({ clip: this.clips[t.clip], voice: t.voice, name: me.name, color: this.meP ? this.meP.color : '#ffd23f', score: t.score.total, grade: t.score.grade, removal: this.room.settings.removal, caption: `Round ${t.round + 1}` })).filter(s => s.clip);
    await exportFlow({ src: this.mediaSrc, segments: segs, name: 'choicer-voicer-my-takes' });
  },

  async exportBest() {
    const segs = await this.reelSegments();
    if (!segs.length) return toast('Nothing to render.', 'bad');
    if (this.reel && this.reel.playing) { const p = this.reel.pos; this.reel.pause(p); this.net.send({ t: 'watch', action: 'pause', pos: p }); }
    await exportFlow({ src: this.mediaSrc, segments: segs, name: 'choicer-voicer-dub' });
  },
};

function gradeOf(total) {
  if (total >= 92) return 'LEGENDARY';
  if (total >= 82) return 'OSCAR BAIT';
  if (total >= 70) return 'BOX OFFICE HIT';
  if (total >= 55) return 'DIRECT-TO-DVD';
  if (total >= 38) return 'STRAIGHT TO TIKTOK';
  if (total > 0) return 'BLOOPER REEL';
  return 'DEAD AIR';
}

function copy(text) {
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('Invite link copied'), () => prompt('Copy this link', text));
}

window.addEventListener('pointerdown', () => audioCtx(), { once: true });
window.addEventListener('beforeunload', e => { if (party.room && party.room.phase !== 'lobby') { e.preventDefault(); } });

// resume an interrupted party seat after a refresh
try {
  const seat = JSON.parse(sessionStorage.getItem('cv.seat') || 'null');
  const q = new URLSearchParams(location.search).get('join');
  if (seat && q && seat.code === q.toUpperCase() && me.name) party.join(q);
  else home();
} catch { home(); }
