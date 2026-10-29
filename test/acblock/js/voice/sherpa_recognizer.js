/**
 * Recognizer (src/voice/engines.js) on sherpa-onnx: the model runs in asr_worker.js; microphone frames come from
 * the shared audio capture.
 */
import { loadWorker } from './sherpa_worker.js';

export function createSherpaRecognizer(capture) {
    let handlers = null;
    const engine = loadWorker('./asr_worker.js', (data) => {
        if (data.type === 'partial') handlers?.onPartial(data.text);
        else if (data.type === 'final') handlers?.onFinal(data.text);
    });

    return {
        ready: engine.ready,
        async start(callbacks) {
            const worker = await engine.ready();
            handlers = callbacks;
            await capture.attach('asr', worker);
        },
        pause: () => engine.post({ type: 'pause' }),
        resume: () => engine.post({ type: 'resume' }),
        stop() {
            engine.post({ type: 'stop' });
            capture.detach('asr');
            handlers = null;
        },
        setHotwords: (words) => engine.post({ type: 'hotwords', words }),
    };
}
