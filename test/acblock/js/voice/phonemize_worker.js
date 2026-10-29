// Text to phonemes for the AI voice: piper-phonemize (espeak-ng) from models/tts/piper-phonemize.
// Messages in: phonemize {id, text}. Out: ready, error, phonemes {id, sentences}.
const DIR = new URL('../../models/tts/piper-phonemize/', self.location.href).href;

self.Module = {
    locateFile: (path) => DIR + path,
    onRuntimeInitialized: () => {
        if (piperPhonemizeInitialize() < 0) postMessage({ type: 'error', message: 'The voice could not start its phonemizer.' });
        else postMessage({ type: 'ready' });
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
    const sentences = (piperPhonemize(data.text, 'en-us') || []).filter((s) => s.length);
    postMessage({ type: 'phonemes', id: data.id, sentences });
};
