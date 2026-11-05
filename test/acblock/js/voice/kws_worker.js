// Wake phrase in a worker: sherpa-onnx keyword spotting (models/kws) with the phrases in models/kws/keywords.txt.
// Only the assistant name's lines are used (?name=Neon: "@hey_neon", "@hi_neon"); another name needs its phrases added.
// Messages in: start {sampleRate, port}, stop. Out: ready, error, wake {phrase}.
const MODELS = new URL('../../models/kws/', self.location.href).href;

// A stream that has heard more than about a second of silence misses the phrase. So four streams run, each reset
// every 2 s, starting half a second apart: whenever the phrase begins, one of them has under a second of silence
// before it and over a second left to hear it.
const PERIOD = 2;
const STREAMS = 4;

let kws = null;
let streams = [];
let ages = [];
let sampleRate = 16000;
let keywords = '';
const NAME = new URL(self.location.href).searchParams.get('name') || 'Neon';

/** The lines whose tag is this name's phrase ("▁HE Y ▁NO VA @hey_nova"). */
function forName(text, name) {
    const tags = new Set(['hey', 'hi'].map((word) => `@${word}_${name.toLowerCase()}`));
    return text.split('\n').filter((line) => tags.has(line.trim().split(' ').pop())).join('\n');
}

self.Module = {
    locateFile: (path) => MODELS + path,
    onRuntimeInitialized: async () => {
        try {
            keywords = forName((await (await fetch(MODELS + 'keywords.txt')).text()), NAME);
            if (!keywords) throw new Error(`No wake phrase for ${NAME} in keywords.txt.`);
            kws = createKws(Module, {
                featConfig: { samplingRate: 16000, featureDim: 80 },
                modelConfig: {
                    transducer: {
                        encoder: './encoder-epoch-12-avg-2-chunk-16-left-64.onnx',
                        decoder: './decoder-epoch-12-avg-2-chunk-16-left-64.onnx',
                        joiner: './joiner-epoch-12-avg-2-chunk-16-left-64.onnx',
                    },
                    tokens: './tokens.txt', provider: 'cpu', modelType: '', numThreads: 1, debug: 0,
                    modelingUnit: 'bpe', bpeVocab: '',
                },
                maxActivePaths: 4,
                numTrailingBlanks: 1,
                keywordsScore: 1.0,
                keywordsThreshold: 0.25,
                keywords,
            });
            streams = Array.from({ length: STREAMS }, () => kws.createStream());
            restart();
            postMessage({ type: 'ready' });
        } catch (e) {
            postMessage({ type: 'error', message: String(e && e.message || e) });
        }
    },
};

try {
    importScripts(MODELS + 'sherpa-onnx-kws.js', MODELS + 'sherpa-onnx-wasm-kws-main.js');
} catch (e) {
    postMessage({ type: 'error', message: `Wake phrase files are missing (${e.message}). Run test/acblock/models/build_engines.sh kws.` });
}

/** Stream i first resets after i * PERIOD / STREAMS seconds. */
function restart() {
    ages = streams.map((_, i) => PERIOD - i * PERIOD / STREAMS);
}

function accept(samples) {
    if (!kws) return;
    const seconds = samples.length / sampleRate;
    for (const [i, stream] of streams.entries()) {
        if (ages[i] >= PERIOD) {
            kws.reset(stream);
            ages[i] = 0;
        }
        ages[i] += seconds;
        stream.acceptWaveform(sampleRate, samples);
        while (kws.isReady(stream)) {
            kws.decode(stream);
            if (kws.getResult(stream).keyword) {
                postMessage({ type: 'wake' });
                // Reset everything right after a detection, or it fires again.
                streams.forEach((s) => kws.reset(s));
                restart();
                return;
            }
        }
    }
}

self.onmessage = ({ data }) => {
    if (data.type === 'start') {
        sampleRate = data.sampleRate;
        if (kws) {
            streams.forEach((s) => kws.reset(s));
            restart();
        }
        data.port.onmessage = ({ data: frame }) => accept(frame.samples);
    } else if (data.type === 'stop' && kws) {
        streams.forEach((s) => kws.reset(s));
        restart();
    }
};
