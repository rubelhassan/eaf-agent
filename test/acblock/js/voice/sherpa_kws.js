/** KeywordSpotter (src/voice/engines.js) on sherpa-onnx, in kws_worker.js, fed by the shared capture. */
import { loadWorker } from './sherpa_worker.js';

export function createSherpaKeywordSpotter(capture) {
    let handlers = null;
    const engine = loadWorker('./kws_worker.js', (data) => {
        if (data.type === 'wake') handlers?.onWake(data.phrase);
    });
    return {
        ready: engine.ready,
        async start(callbacks) {
            const worker = await engine.ready();
            handlers = callbacks;
            await capture.attach('kws', worker);
        },
        stop() {
            engine.post({ type: 'stop' });
            capture.detach('kws');
            handlers = null;
        },
    };
}
