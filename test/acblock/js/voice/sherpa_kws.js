/** KeywordSpotter (src/voice/engines.js) on sherpa-onnx, in kws_worker.js, fed by the shared capture. The worker
 * listens for the given assistant name's phrases ("Hey Nova", "Hi Nova") in models/kws/keywords.txt. */
import { loadWorker } from './sherpa_worker.js';

export function createSherpaKeywordSpotter(capture, name = 'Neon') {
    let handlers = null;
    const engine = loadWorker(`./kws_worker.js?name=${encodeURIComponent(name)}`, (data) => {
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
