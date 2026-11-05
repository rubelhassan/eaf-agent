// Text to phonemes for the AI voice: piper-phonemize (espeak-ng) from models/tts/piper-phonemize.
// Messages in: phonemize {id, text}. Out: ready, error, phonemes {id, sentences}.
const DIR = new URL('../../models/tts/piper-phonemize/', self.location.href).href;
let voice = 'en';

async function modelVoice() {
    try {
        const response = await fetch(new URL('../model.onnx.json', DIR));
        if (!response.ok) return 'en';
        const config = await response.json();
        const name = config?.espeak?.voice;
        return typeof name === 'string' && name.trim() ? name.trim() : 'en';
    } catch {
        // Older engine packages omit the optional model config; Kristin uses en.
        return 'en';
    }
}

self.Module = {
    locateFile: (path) => DIR + path,
    onRuntimeInitialized: async () => {
        if (piperPhonemizeInitialize() < 0) postMessage({ type: 'error', message: 'The voice could not start its phonemizer.' });
        else {
            voice = await modelVoice();
            postMessage({ type: 'ready' });
        }
    },
};

try {
    importScripts(DIR + 'piper-phonemize.js', DIR + 'piper-phonemize-wasm-main.js');
} catch (e) {
    postMessage({ type: 'error', message: `Voice files are missing (${e.message}). Run test/acblock/models/build_engines.sh tts.` });
}

self.onmessage = ({ data }) => {
    if (data.type !== 'phonemize') return;
    // Piper can return empty sentences (after a final period); the voice needs every one non-empty.
    const sentences = (piperPhonemize(data.text, voice) || []).filter((s) => s.length);
    postMessage({ type: 'phonemes', id: data.id, sentences });
};
