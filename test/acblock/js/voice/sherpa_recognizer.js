/**
 * Recognizer (src/voice/engines.js) on sherpa-onnx: the model runs in asr_worker.js; microphone frames come from
 * the shared audio capture.
 */
import { loadWorker } from './sherpa_worker.js';

export function createSherpaRecognizer(capture, {listenerConfig = null, onStats = null} = {}) {
    if (listenerConfig && !['L0', 'L1'].includes(listenerConfig)) throw new Error('Unknown listener config');
    const id = listenerConfig ? `asr-listener-${listenerConfig}` : 'asr';
    const path = listenerConfig ? `./asr_worker.js?listener=${listenerConfig}${onStats ? '&stats=1' : ''}` : './asr_worker.js';
    let handlers = null;
    const engine = loadWorker(path, (data) => {
        if (data.type === 'partial') handlers?.onPartial(data.text);
        else if (data.type === 'final') handlers?.onFinal(data.text);
        else if (data.type === 'stats') onStats?.(data);
    });

    return {
        ready: engine.ready,
        async start(callbacks) {
            const worker = await engine.ready();
            handlers = callbacks;
            await capture.attach(id, worker);
        },
        pause: () => engine.post({ type: 'pause' }),
        resume: () => engine.post({ type: 'resume' }),
        stop() {
            engine.post({ type: 'stop' });
            capture.detach(id);
            handlers = null;
        },
        setHotwords: (words) => {
            if (!listenerConfig || listenerConfig === 'L0') engine.post({type: 'hotwords', words});
        },
    };
}
