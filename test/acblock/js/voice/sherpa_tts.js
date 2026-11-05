/** Text to audio on the device: piper-phonemize then Piper Kristin, each in its own worker (both are Emscripten modules). */
import { loadWorker } from './sherpa_worker.js';

export function createSherpaSynth() {
    const waiting = new Map();
    let next = 0;
    const answer = (data) => {
        waiting.get(data.id)?.(data);
        waiting.delete(data.id);
    };
    const phonemizer = loadWorker('./phonemize_worker.js', answer);
    const voice = loadWorker('./tts_worker.js', answer);
    const ask = (engine, message) => new Promise((resolve) => {
        const id = ++next;
        waiting.set(id, resolve);
        engine.post({ ...message, id });
    });
    return {
        ready: () => Promise.all([phonemizer.ready(), voice.ready()]).then(() => {}),
        /** @returns {!Promise<{samples: !Float32Array, sampleRate: number}>} */
        async synthesize(text, { speed = 1 } = {}) {
            await this.ready();
            const { sentences } = await ask(phonemizer, { type: 'phonemize', text });
            const { samples, sampleRate, error } = await ask(voice, { type: 'generate', sentences, speed });
            if (error) throw new Error(error);
            return { samples, sampleRate };
        },
    };
}
