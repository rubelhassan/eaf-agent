// @ts-check
// Voices over the browser's speechSynthesis: the system voice and the AI voice. Only voices on the device are used,
// so spoken text never leaves it. page_voice.js is the AI voice the page plays itself.

/**
 * @typedef {Object} Voice
 * @property {function(): !Promise<void>} ready
 * @property {function(): boolean=} available  Whether a voice can speak on this device now.
 * @property {function(string, {rate?: number}=): void=} prepare  Start synthesizing the next sentence early (engines that can).
 * @property {function(string, {rate?: number, signal?: AbortSignal}=): !Promise<void>} speak  Resolves when done or aborted.
 * @property {function(): void} cancel
 * @property {function(): boolean=} playsInPage  The page plays it, so the browser's echo canceller removes it from the microphone.
 */

/** Resolves once the OS voices are listed (Chrome fills them in later). */
function voicesLoaded(synth) {
  if (!synth || synth.getVoices().length) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      synth.removeEventListener?.('voiceschanged', done);
      resolve();
    };
    synth.addEventListener?.('voiceschanged', done);
    setTimeout(done, 1000);
  });
}

/**
 * @param {{synth?: ?SpeechSynthesis, voice?: function(): ?string, pitch?: number, rate?: number}} options
 *     voice: the chosen voice name, read at each sentence
 * @returns {!Voice}
 */
/** English voices that run on the device; network voices (e.g. Google's in desktop Chrome) send the text away. */
export function localVoices(synth = browserSynth()) {
  return (synth?.getVoices() || []).filter((v) => v.localService === true && /^en/i.test(v.lang));
}

function synthVoice({synth, voice = () => null, pitch = 1, rate = 1}) {
  const pick = () => {
    const voices = localVoices(synth);
    return voices.find((v) => v.name === voice()) || voices.find((v) => v.default) || voices[0] || null;
  };
  return {
    ready: () => voicesLoaded(synth),
    available: () => !!pick(),
    speak(text, {rate: speed = 1, signal} = {}) {
      if (!synth || signal?.aborted || !text) return Promise.resolve();
      const selected = pick();
      // A null voice lets the browser choose a default, which may send the text away.
      if (!selected) return Promise.resolve();
      return new Promise((resolve) => {
        const utterance = new SpeechSynthesisUtterance(text);
        const stop = () => {
          synth.cancel();
          resolve();
        };
        const done = () => {
          signal?.removeEventListener('abort', stop);
          resolve();
        };
        utterance.voice = selected;
        utterance.pitch = pitch;
        utterance.rate = rate * speed;
        utterance.onend = done;
        utterance.onerror = done;
        signal?.addEventListener('abort', stop, {once: true});
        synth.speak(utterance);
      });
    },
    cancel: () => synth?.cancel(),
  };
}

const browserSynth = () => (typeof speechSynthesis === 'undefined' ? null : speechSynthesis);

/**
 * The learner's OS voice, for navigation and system speech in system voice mode.
 * @param {{synth?: ?SpeechSynthesis, voice?: function(): ?string}=} options
 */
export function systemVoice({synth = browserSynth(), voice} = {}) {
  return synthVoice({synth, voice});
}

// Clear, standard voices, best first. Systems also ship novelty voices (Bubbles, Zarvox...) that are hard to follow.
const CLEAR_VOICES = ['Samantha', 'Alex', 'Microsoft Aria', 'Microsoft Jenny', 'Microsoft Guy', 'Microsoft Zira',
  'Microsoft David', 'Chrome OS US English', 'Karen', 'Daniel', 'Moira', 'Tessa'];

/**
 * The AI voice: a clear standard voice on the device at normal pitch and speed, other than the system voice when possible.
 * @param {{synth?: ?SpeechSynthesis, voice?: function(): ?string, systemVoiceName?: function(): ?string}=} options
 */
export function nativeAiVoice({synth = browserSynth(), voice = () => null, systemVoiceName = () => null} = {}) {
  const choose = () => {
    if (voice()) return voice();
    const voices = localVoices(synth);
    const system = systemVoiceName() || voices.find((v) => v.default)?.name;
    const clear = CLEAR_VOICES.map((name) => voices.find((v) => v.name.startsWith(name))).filter(Boolean);
    return (clear.find((v) => v.name !== system) || clear[0])?.name || null;
  };
  return synthVoice({synth, voice: choose});
}

/**
 * The AI voice: the page's own voice once it has loaded, unless the learner picked a system voice; until then (or if
 * it fails to load) the native one.
 * @param {{page: ?Voice, native: !Voice, systemPicked: function(): boolean}} options
 * @returns {!Voice}
 */
export function preferPageVoice({page, native, systemPicked}) {
  let loaded = false;
  const current = () => (loaded && !systemPicked() ? page : native);
  return {
    async ready() {
      await native.ready();
      if (!page) return;
      try {
        await page.ready();
        loaded = true;
      } catch (e) {
        console.warn('[voice] The built-in AI voice did not load; using a system voice.', e);
      }
    },
    prepare: (text, options) => current().prepare?.(text, options),
    available: () => current().available?.() !== false,
    speak: (text, options) => current().speak(text, options),
    cancel() {
      page?.cancel();
      native.cancel();
    },
    playsInPage: () => current() === page,
  };
}
