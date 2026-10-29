// @ts-check
// What the conversation controller needs from speech engines. The host app gives them (sherpa-onnx in a worker
// now); tests give fakes. The AI voice is the output manager's Voice (src/output/voices.js).

/**
 * @typedef {Object} Recognizer
 * @property {function(): !Promise<void>} ready  Rejects when the engine can't load.
 * @property {function({onPartial: function(string): void, onFinal: function(string): void}): !Promise<void>} start
 *     Opens the microphone (asking the first time) and starts recognizing. Rejects when the microphone is refused.
 * @property {function(): void} pause  Ignores the microphone and drops the words of the current utterance.
 * @property {function(): void} resume
 * @property {function(): void} stop  Stops recognizing and closes the microphone.
 * @property {function(!Array<string>): void} setHotwords  Words to favour; no-op if the engine can't.
 */

/**
 * Voice activity: when someone starts and stops speaking (at least 250 ms of speech counts).
 * @typedef {Object} VoiceActivity
 * @property {function(): !Promise<void>} ready
 * @property {function({onSpeechStart: function(): void, onSpeechEnd: function(): void}): !Promise<void>} start
 * @property {function(): void} stop
 */

/**
 * The wake phrase ("Hey Neon").
 * @typedef {Object} KeywordSpotter
 * @property {function(): !Promise<void>} ready
 * @property {function({onWake: function(string): void}): !Promise<void>} start
 * @property {function(): void} stop
 */

export {};
