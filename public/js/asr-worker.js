// Whisper in the browser via transformers.js. The runtime and the tiny model
// are served by our own server; bigger models come from Hugging Face.
let lib = null;
let asr = null;
let asrKey = '';

async function load({ base, model, gpu }, onProgress) {
  lib = lib || await import(base + '/vendor/transformers.min.js');
  const key = model + (gpu ? ':gpu' : '');
  if (asr && asrKey === key) return asr;
  const { env } = lib;
  env.backends.onnx.wasm.wasmPaths = base + '/vendor/ort/';
  const local = model === 'Xenova/whisper-tiny';
  env.allowLocalModels = local;
  env.allowRemoteModels = !local;
  env.localModelPath = base + '/models/';
  const progress_callback = p => {
    if (p.status === 'progress' && p.total) onProgress({ file: p.file, loaded: p.loaded, total: p.total });
  };
  let device = 'wasm';
  if (gpu && self.navigator && navigator.gpu) {
    try { if (await navigator.gpu.requestAdapter()) device = 'webgpu'; } catch {}
  }
  try {
    asr = await lib.pipeline('automatic-speech-recognition', model, device === 'webgpu'
      ? { device, dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, progress_callback }
      : { device: 'wasm', dtype: 'q8', progress_callback });
  } catch (e) {
    if (device !== 'webgpu') throw e;
    asr = await lib.pipeline('automatic-speech-recognition', model, { device: 'wasm', dtype: 'q8', progress_callback });
  }
  asrKey = key;
  return asr;
}

self.onmessage = async e => {
  const { id, type } = e.data;
  const progress = p => self.postMessage({ id, type: 'progress', p });
  try {
    if (type === 'load') {
      await load(e.data, progress);
      self.postMessage({ id, type: 'done' });
    } else if (type === 'run') {
      const pipe = await load(e.data, progress);
      const opts = { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 };
      if (e.data.language && !/\.en$/.test(e.data.model)) { opts.language = e.data.language; opts.task = 'transcribe'; }
      let out;
      try { out = await pipe(e.data.audio, opts); }
      catch (err) {
        // word timing needs cross-attention outputs; segment timing is the fallback
        console.warn('word timestamps failed, using segments', err);
        out = await pipe(e.data.audio, { ...opts, return_timestamps: true });
        out.segments = true;
      }
      self.postMessage({ id, type: 'done', out: { text: out.text, chunks: out.chunks || [], segments: !!out.segments } });
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', error: String(err && err.message || err) });
  }
};
