// Voice activity in a worker: Silero VAD from the sherpa-onnx browser build in models/vad.
// Messages in: start {sampleRate, port}, stop. Out: ready, error, speechStart, speechEnd.
const MODELS = new URL('../../models/vad/', self.location.href).href;
const RATE = 16000;
const WINDOW = 512;

let vad = null;
let pending = new Float32Array(0);
let inputRate = RATE;
let speaking = false;

self.Module = {
    locateFile: (path) => MODELS + path,
    onRuntimeInitialized: () => {
        try {
            vad = createVad(Module, {
                sileroVad: { model: './silero_vad.onnx', threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25,
                    maxSpeechDuration: 20, windowSize: WINDOW },
                tenVad: { model: '', threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: 20, windowSize: 256 },
                sampleRate: RATE, numThreads: 1, provider: 'cpu', debug: 0, bufferSizeInSeconds: 30,
            });
            postMessage({ type: 'ready' });
        } catch (e) {
            postMessage({ type: 'error', message: String(e && e.message || e) });
        }
    },
};

try {
    importScripts(MODELS + 'sherpa-onnx-vad.js', MODELS + 'sherpa-onnx-wasm-main-vad.js');
} catch (e) {
    postMessage({ type: 'error', message: `Voice activity files are missing (${e.message}). Run test/acblock/models/build_engines.sh vad.` });
}

/** Averages input samples down to 16 kHz. */
function toRate(samples) {
    if (inputRate === RATE) return samples;
    const ratio = inputRate / RATE;
    const out = new Float32Array(Math.floor(samples.length / ratio));
    for (let i = 0; i < out.length; i++) {
        const from = Math.floor(i * ratio);
        const to = Math.min(samples.length, Math.floor((i + 1) * ratio));
        let sum = 0;
        for (let j = from; j < to; j++) sum += samples[j];
        out[i] = sum / Math.max(1, to - from);
    }
    return out;
}

function accept(samples) {
    if (!vad) return;
    const resampled = toRate(samples);
    const joined = new Float32Array(pending.length + resampled.length);
    joined.set(pending);
    joined.set(resampled, pending.length);
    let at = 0;
    for (; at + WINDOW <= joined.length; at += WINDOW) {
        vad.acceptWaveform(joined.subarray(at, at + WINDOW));
        // Only the start and end matter here; segments are dropped.
        while (!vad.isEmpty()) vad.pop();
        const now = vad.isDetected();
        if (now !== speaking) {
            speaking = now;
            postMessage({ type: now ? 'speechStart' : 'speechEnd' });
        }
    }
    pending = joined.slice(at);
}

self.onmessage = ({ data }) => {
    if (data.type === 'start') {
        inputRate = data.sampleRate;
        pending = new Float32Array(0);
        if (vad) vad.clear();
        speaking = false;
        data.port.onmessage = ({ data: frame }) => accept(frame.samples);
    } else if (data.type === 'stop') {
        if (vad) vad.clear();
        if (speaking) postMessage({ type: 'speechEnd' });
        speaking = false;
    }
};
