/**
 * Recognizer (src/voice/engines.js) on the browser's SpeechRecognition: the fallback when the voice engine can't
 * load and the task allows it. Chrome's sends audio to Google, so the learner is told once.
 */
export function createWebSpeechRecognizer() {
    const Impl = window.SpeechRecognition || window.webkitSpeechRecognition;
    let recognition = null;
    let handlers = null;
    let paused = false;
    let running = false;

    return {
        async ready() {
            if (!Impl) throw new Error('This browser has no speech recognition.');
        },
        start(callbacks) {
            handlers = callbacks;
            paused = false;
            running = true;
            recognition = new Impl();
            recognition.continuous = true;
            recognition.interimResults = true;
            recognition.lang = 'en-US';
            recognition.onresult = (e) => {
                if (paused) return;
                for (let i = e.resultIndex; i < e.results.length; i++) {
                    const result = e.results[i];
                    (result.isFinal ? handlers.onFinal : handlers.onPartial)(result[0].transcript);
                }
            };
            // Chrome ends a recognition after a silence; keep listening while the session runs.
            recognition.onend = () => {
                if (running) recognition.start();
            };
            return new Promise((resolve, reject) => {
                recognition.onstart = () => resolve();
                recognition.onerror = (e) => {
                    if (e.error !== 'not-allowed') return;
                    running = false;
                    reject(Object.assign(new Error('microphone refused'), { name: 'NotAllowedError' }));
                };
                recognition.start();
            });
        },
        pause() {
            paused = true;
            handlers?.onPartial('');
        },
        resume() {
            paused = false;
        },
        stop() {
            running = false;
            recognition?.stop();
            recognition = null;
            handlers = null;
        },
        setHotwords() {},
    };
}
