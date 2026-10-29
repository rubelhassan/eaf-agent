// Phonemes to audio for the AI voice: Piper Kristin on sherpa-onnx from models/tts.
// Messages in: generate {id, sentences, speed}. Out: ready, error, audio {id, samples, sampleRate}.
const MODELS = new URL('../../models/tts/', self.location.href).href;
let tts = null;

self.Module = {
    locateFile: (path) => MODELS + path,
    onRuntimeInitialized: () => {
        try {
            tts = createOfflineTts(self.Module);
            postMessage({ type: 'ready' });
        } catch (e) {
            postMessage({ type: 'error', message: String(e && e.message || e) });
        }
    },
};

try {
    importScripts(MODELS + 'sherpa-onnx-tts.js', MODELS + 'sherpa-onnx-wasm-main-tts.js');
} catch (e) {
    postMessage({ type: 'error', message: `Voice files are missing (${e.message}). Run test/acblock/models/build_engines.sh tts.` });
}

self.onmessage = ({ data }) => {
    if (data.type !== 'generate') return;
    try {
        const { samples, sampleRate } = data.sentences.length ?
            tts.generateWithConfig('', { phonemeCodepoints: data.sentences, sid: 0, speed: data.speed }) :
            { samples: new Float32Array(0), sampleRate: 22050 };
        postMessage({ type: 'audio', id: data.id, samples, sampleRate }, [samples.buffer]);
    } catch (e) {
        postMessage({ type: 'audio', id: data.id, error: String(e && e.message || e) });
    }
};
