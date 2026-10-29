// @ts-check
// A Voice the page plays itself through Web Audio, from an on-device synthesizer. Because the page plays it, the
// browser's echo canceller removes it from the microphone (the OS plays speechSynthesis, so that can't be removed).

/**
 * @typedef {Object} Synthesizer
 * @property {function(): !Promise<void>} ready
 * @property {function(string, {speed?: number}=): !Promise<{samples: !Float32Array, sampleRate: number}>} synthesize
 */

/**
 * @param {{synth: !Synthesizer, createContext?: function(): ?AudioContext}} options
 * @returns {!import('./voices.js').Voice}
 */
export function pageVoice({synth, createContext = () => (typeof AudioContext === 'function' ? new AudioContext() : null)}) {
  let context = null;
  let playing = null;
  // Audio being made for upcoming sentences, by text and speed.
  const made = new Map();

  const key = (text, speed) => `${speed}|${text}`;
  function make(text, speed) {
    const k = key(text, speed);
    if (!made.has(k)) {
      const audio = synth.synthesize(text, {speed});
      audio.catch(() => made.delete(k));
      made.set(k, audio);
    }
    return made.get(k);
  }

  function stop() {
    playing?.();
  }

  return {
    playsInPage: () => true,
    ready: () => synth.ready(),
    prepare(text, {rate = 1} = {}) {
      make(text, rate);
    },
    async speak(text, {rate = 1, signal} = {}) {
      if (!text || signal?.aborted) return;
      context = context || createContext();
      if (!context) return;
      const audio = await make(text, rate);
      made.delete(key(text, rate));
      if (signal?.aborted || !audio.samples.length) return;
      // Before the learner's first key press or click, the browser may not allow audio yet; don't wait forever.
      if (context.state !== 'running') await Promise.race([context.resume(), new Promise((r) => setTimeout(r, 500))]);
      if (context.state !== 'running') return;
      const buffer = context.createBuffer(1, audio.samples.length, audio.sampleRate);
      buffer.copyToChannel(audio.samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      await new Promise((resolve) => {
        const done = () => {
          signal?.removeEventListener('abort', done);
          source.onended = null;
          try {
            source.stop();
          } catch (e) { /* already ended */ }
          playing = null;
          resolve();
        };
        playing = done;
        source.onended = done;
        signal?.addEventListener('abort', done, {once: true});
        source.start();
      });
    },
    cancel: stop,
  };
}
