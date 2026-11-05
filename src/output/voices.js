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

const isUs = (v) => /^en[-_]US$/i.test(v.lang);
const byName = (a, b) => a.name.localeCompare(b.name);

/**
 * English voices that run on the device, US English first; network voices (e.g. Google's in desktop Chrome) send
 * the text away.
 */
export function localVoices(synth = browserSynth()) {
  const english = (synth?.getVoices() || []).filter((v) => v.localService === true && /^en/i.test(v.lang));
  return [...english.filter(isUs), ...english.filter((v) => !isUs(v))];
}

/**
 * The one system voice the app uses, the same on every visit: the device default if it is US English, else the first
 * US English voice by name, else the default English voice, else the first English voice by name.
 * @returns {?SpeechSynthesisVoice}
 */
export function lockedVoice(synth = browserSynth()) {
  const voices = localVoices(synth);
  const us = voices.filter(isUs).sort(byName);
  return us.find((v) => v.default) || us[0] || voices.find((v) => v.default) || [...voices].sort(byName)[0] || null;
}

let logged = null;
function logPick(voice) {
  if (!voice || logged === voice.name) return;
  logged = voice.name;
  console.info(`[voice] system voice: ${voice.name} (${voice.lang})`);
}

/** @param {{synth?: ?SpeechSynthesis, pitch?: number, rate?: number}} options */
function synthVoice({synth, pitch = 1, rate = 1}) {
  const pick = () => lockedVoice(synth);
  return {
    ready: () => voicesLoaded(synth).then(() => logPick(pick())),
    available: () => !!pick(),
    speak(text, {rate: speed = 1, signal} = {}) {
      if (!synth || signal?.aborted || !text) return Promise.resolve();
      const selected = pick();
      // A null voice lets the browser choose a default, which may send the text away.
      if (!selected) return Promise.resolve();
      logPick(selected);
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
        utterance.lang = selected.lang;
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
 * The system voice for navigation and system speech in system voice mode: the locked voice, no choice.
 * @param {{synth?: ?SpeechSynthesis}=} options
 */
export function systemVoice({synth = browserSynth()} = {}) {
  return synthVoice({synth});
}

/**
 * The AI voice when Kristin isn't there (not set up, or failed): the same locked system voice, so replies are never silent.
 * @param {{synth?: ?SpeechSynthesis}=} options
 */
export function nativeAiVoice({synth = browserSynth()} = {}) {
  return synthVoice({synth});
}

/**
 * The AI voice is Kristin (the page voice); while she loads it waits, and if she fails the native voice speaks.
 * @param {{page: ?Voice, native: !Voice, onPageFailed?: function(): void}} options
 *     onPageFailed: the page voice can't load (no tts engine on this device)
 * @returns {!Voice}
 */
export function preferPageVoice({page, native, onPageFailed = () => {}}) {
  let loaded = false;
  let failed = false;
  let loading = null;
  const current = () => (loaded ? page : native);

  function loadPage() {
    if (!page) return Promise.resolve();
    if (!loading) {
      loading = (async () => {
        try {
          await page.ready();
          loaded = true;
        } catch (e) {
          console.warn('[voice] The built-in AI voice did not load; using a system voice.', e);
          failed = true;
          onPageFailed();
        }
      })();
    }
    return loading;
  }

  async function waitForPage(signal) {
    if (!signal) return loadPage();
    if (signal.aborted) return;
    let stop;
    const stopped = new Promise((resolve) => {
      stop = () => resolve();
      signal.addEventListener('abort', stop, {once: true});
    });
    try {
      await Promise.race([loadPage(), stopped]);
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }

  return {
    async ready() {
      await native.ready();
      await loadPage();
    },
    prepare(text, options) {
      if (!text) return;
      if (!page) {
        native.prepare?.(text, options);
        return;
      }
      loadPage().then(() => current().prepare?.(text, options))
          .catch((error) => console.warn('[voice] Could not prepare the assistant voice.', error));
    },
    available: () => current().available?.() !== false,
    async speak(text, options = {}) {
      if (!text || options.signal?.aborted) return;
      if (page) await waitForPage(options.signal);
      if (!options.signal?.aborted) return current().speak(text, options);
    },
    cancel() {
      page?.cancel();
      native.cancel();
    },
    // Kristin will play in the page while she loads or once loaded; after a failed load the system voice speaks.
    playsInPage: () => !!page && !failed,
  };
}
