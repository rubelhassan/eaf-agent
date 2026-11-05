// @ts-check
// What the conversation controller needs from speech engines. The host app gives them (sherpa-onnx in a worker
// now); tests give fakes. The AI voice is the output manager's Voice (src/output/voices.js).

/**
 * @typedef {Object} Recognizer
 * @property {boolean} [cased] Preserves case; absent for upper-case, uncased engines.
 * @property {function({onConnection?: function(!Object): void, onError?: function(!Error): void, onReplayDrop?: function(number, string): void}=): !Promise<void>} ready
 *     Rejects when the engine can't load; optional callbacks stay through automatic background retries.
 * @property {function({onPartial: function(string): void, onFinal: function(string, {utterance?: number, replay?: boolean}=): void, onError?: function(!Error, {utterance?: number, replay?: boolean}=): void, onLimit?: function(): void, onConnection?: function(!Object): void, onReplayDrop?: function(number, string): void}): !Promise<void>} start
 *     Opens the microphone (asking the first time) and starts recognizing. Rejects when the microphone is refused.
 *     onConnection receives connection (connected, reconnecting, fallback), reason, closeCode, closeReason,
 *     attempt and sinceLastMessageMs. A session error with retrying=true keeps the adapter's background retries.
 *     onReplayDrop releases provisional pieces whose audio was dropped (cap, total or cleared).
 * @property {?Object} [replayBuffer] Adapter-owned memory buffer: begin, end, drop, take, clear, ids and setEnabled.
 * @property {function(number, !Array<!Object>): boolean} [replay] Sends buffered audio between live utterances.
 *     Its final carries replay=true and the original public id; it never acts as live speech.
 * @property {'own'|'vad'} [endpointing] Whether local voice activity must delimit utterances.
 * @property {function(): ?number} [speechStart] Opens or resumes a live utterance; no-id engines may return nothing.
 * @property {function(): ?number} [speechEnd] Returns the id whose decode will follow.
 * @property {function(!Array<string>): void} [setVocabulary]
 * @property {function(number=): void} [cancel] Drops that live id, or all live ids when omitted.
 * @property {function(): void} [disconnect] Clears callbacks and retries and closes the transport on mic off, page hide or dispose.
 * @property {function(): void} pause  Ignores the microphone and drops the words of the current utterance.
 * @property {function(): void} resume
 * @property {function(): void} stop  Stops capture, callbacks and retries; an open transport may stay for the next session.
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
