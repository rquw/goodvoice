// Silero VAD (neural speech detector) over a 16 kHz mono buffer.
// One probability per 512-sample frame (32 ms).
let ort = null;
let session = null;

async function init(base) {
  if (session) return;
  ort = await import(base + '/vendor/ort/ort.wasm.min.mjs');
  ort.env.wasm.wasmPaths = base + '/vendor/ort/';
  ort.env.wasm.numThreads = 1;
  session = await ort.InferenceSession.create(base + '/vendor/silero_vad_v5.onnx', { executionProviders: ['wasm'] });
}

self.onmessage = async e => {
  const { id, base, audio } = e.data;
  try {
    await init(base);
    const FRAME = 512, CTX = 64;
    const n = Math.floor(audio.length / FRAME);
    const probs = new Float32Array(n);
    let state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
    const sr = new ort.Tensor('int64', BigInt64Array.from([16000n]));
    const buf = new Float32Array(CTX + FRAME);
    for (let f = 0; f < n; f++) {
      buf.copyWithin(0, FRAME);
      buf.set(audio.subarray(f * FRAME, f * FRAME + FRAME), CTX);
      const out = await session.run({ input: new ort.Tensor('float32', buf.slice(), [1, CTX + FRAME]), state, sr });
      state = out.stateN;
      probs[f] = out.output.data[0];
      if (f % 400 === 0) self.postMessage({ id, type: 'progress', p: f / n });
    }
    self.postMessage({ id, type: 'done', probs }, [probs.buffer]);
  } catch (err) {
    self.postMessage({ id, type: 'error', error: String(err && err.message || err) });
  }
};
