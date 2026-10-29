// Speech recognition in a worker: the sherpa-onnx browser build in models/asr (streaming English Zipformer).
// Messages in: start {sampleRate, port}, pause, resume, stop, hotwords {words}. Out: ready, error, partial, final.
const MODELS = new URL('../../models/asr/', self.location.href).href;

let recognizer = null;
let stream = null;
let sampleRate = 16000;
let hotwords = [];
let listening = false;
let last = '';

self.Module = {
    locateFile: (path) => MODELS + path,
    onRuntimeInitialized: () => {
        try {
            create();
            postMessage({ type: 'ready' });
        } catch (e) {
            postMessage({ type: 'error', message: String(e && e.message || e) });
        }
    },
};

try {
    importScripts(MODELS + 'sherpa-onnx-asr.js', MODELS + 'sherpa-onnx-wasm-main-asr.js');
} catch (e) {
    postMessage({ type: 'error', message: `Voice engine files are missing (${e.message}). Run test/acblock/models/build_engines.sh asr.` });
}

function create() {
    if (stream) stream.free();
    if (recognizer) recognizer.free();
    // The model's vocabulary is upper case; hotwords favour these words in modified beam search.
    const text = hotwords.map((w) => w.toUpperCase()).join('\n');
    recognizer = createOnlineRecognizer(Module, {
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
            transducer: { encoder: './encoder.onnx', decoder: './decoder.onnx', joiner: './joiner.onnx' },
            tokens: './tokens.txt',
            numThreads: 1,
            provider: 'cpu',
            debug: 0,
            modelType: '',
            modelingUnit: 'bpe',
            bpeVocab: './bpe.vocab',
        },
        decodingMethod: text ? 'modified_beam_search' : 'greedy_search',
        maxActivePaths: 4,
        enableEndpoint: 1,
        rule1MinTrailingSilence: 2.4,
        rule2MinTrailingSilence: 1.0,
        rule3MinUtteranceLength: 20,
        hotwordsFile: '',
        hotwordsScore: 1.5,
        hotwordsBuf: text,
        hotwordsBufSize: Module.lengthBytesUTF8(text),
        ruleFsts: '',
        ruleFars: '',
    });
    stream = recognizer.createStream();
    last = '';
}

/** Forgets the utterance being heard. */
function drop() {
    if (recognizer) {
        recognizer.reset(stream);
    }
    if (last) postMessage({ type: 'partial', text: '' });
    last = '';
}

function accept(samples) {
    if (!listening || !recognizer) return;
    stream.acceptWaveform(sampleRate, samples);
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    const text = recognizer.getResult(stream).text.trim();
    if (recognizer.isEndpoint(stream)) {
        if (text) postMessage({ type: 'final', text });
        recognizer.reset(stream);
        last = '';
    } else if (text !== last) {
        last = text;
        postMessage({ type: 'partial', text });
    }
}

self.onmessage = ({ data }) => {
    switch (data.type) {
        case 'start':
            sampleRate = data.sampleRate;
            data.port.onmessage = ({ data: frame }) => accept(frame.samples);
            drop();
            listening = true;
            break;
        case 'pause':
            listening = false;
            drop();
            break;
        case 'resume':
            listening = true;
            break;
        case 'stop':
            listening = false;
            drop();
            break;
        case 'hotwords':
            if (data.words.join('\n') !== hotwords.join('\n')) {
                hotwords = data.words;
                if (recognizer) create();
            }
            break;
    }
};
