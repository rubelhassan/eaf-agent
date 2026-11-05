/** VoiceActivity (src/voice/engines.js) on sherpa-onnx Silero VAD, in vad_worker.js, fed by the shared capture. */
import { loadWorker } from './sherpa_worker.js';

export function createSherpaVad(capture) {
    let handlers = null;
    const engine = loadWorker('./vad_worker.js', (data) => {
        if (data.type === 'speechStart') handlers?.onSpeechStart();
        else if (data.type === 'speechEnd') handlers?.onSpeechEnd();
    });
    return {
        ready: engine.ready,
        async start(callbacks) {
            const worker = await engine.ready();
            handlers = callbacks;
            await capture.attach('vad', worker);
        },
        stop() {
            engine.post({ type: 'stop' });
            capture.detach('vad');
            handlers = null;
        },
    };
}
