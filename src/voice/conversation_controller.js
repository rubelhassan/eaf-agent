// @ts-check
// The voice conversation: a session that listens, spoken words into the draft, sending it, interruptions, idle
// and the wake phrase. The assistant never hears itself: the browser's echo canceller removes the AI voice the page
// plays, the microphone opens after "I'm listening.", and words that sound like what it or navigation speech just
// said are dropped (so "Say yes to do it" is never a yes).

import {appendToDraft, cleanTranscript} from './draft.js';
import {playedShare, spokenWords} from './echo.js';

export const SessionState = Object.freeze({INACTIVE: 'inactive', STARTING: 'starting', ACTIVE: 'active'});

const SAY = {
  listening: "I'm listening.",
  notSetUp: 'Voice is not set up yet. You can still type.',
  noMicrophone: "I can't use the microphone. Allow it in the browser, or type instead.",
  fallback: "I'm using the browser's speech recognition, which may send your voice to the browser's company.",
  suspend: "I'll stop listening now. Press Control Shift V when you need me.",
  suspendWake: "I'll stop listening now. Press Control Shift V or say Hey Neon when you need me.",
  ended: "Okay, I'll stop listening.",
  endedWaiting: "Okay, I'll stop listening. I'm still waiting for your answer when you come back.",
  noWake: "Hey Neon isn't set up yet. Press Control Shift V to talk.",
  micOff: 'Microphone off.',
};
const END_WORDS = /^(end (the )?conversation|goodbye|bye|stop listening)$/;

/** After the AI voice stops, its sound can still reach the microphone for a moment. */
export const TAIL_MS = 500;
/** Speech this long, with words that aren't the assistant's own, interrupts it. */
export const BARGE_IN_MS = 250;
/** With no words this long after I interrupted, the cut sentence plays again. */
export const FALSE_INTERRUPTION_MS = 2000;
const ECHO_WINDOW_MS = 10000;
const FILLERS = new Set(['a', 'an', 'and', 'the', 'uh', 'um', 'hmm', 'mm', 'oh', 'ah']);
const ECHO_AFTER_MS = 1500;
// Screen readers don't say when they finish, so navigation speech is given time by its length.
const ANNOUNCE_MS_PER_WORD = 400;
const IDLE_MS = {plain: 60000, waiting: 120000, draft: 300000};
const words = spokenWords;

/**
 * @param {{output: !Object, recognizer: ?import('./engines.js').Recognizer,
 *     fallback?: ?import('./engines.js').Recognizer, vad?: ?import('./engines.js').VoiceActivity,
 *     spotter?: ?import('./engines.js').KeywordSpotter,
 *     draft: {value: function(): string, set: function(string): void, setPartial: function(string): void},
 *     submit: function(string, string): void, hotwords?: function(): !Array<string>,
 *     settings?: function(): {bargeIn: boolean, wakePhrase: boolean, fallbackAllowed: boolean},
 *     isBusy?: function(): boolean, isWaiting?: function(): boolean, echoCancelled?: function(): boolean,
 *     onState?: function(string): void, onMicrophoneState?: function(string): void,
 *     onEvent?: function(string, !Object): void, mark?: function(string): void,
 *     now?: function(): number}} options
 *     fallback: used only when the recognizer can't load and the task allows it; isBusy: a task is working;
 *     isWaiting: an answer is awaited; echoCancelled: the AI voice is played by the page, so the echo canceller removes
 *     it (barge-in needs that); mark: timing marks for the browser bench
 */
export function createConversationController(options) {
  const {output, draft, submit} = options;
  const hotwords = options.hotwords || (() => []);
  const settings = options.settings || (() => ({bargeIn: true, wakePhrase: false, fallbackAllowed: false}));
  const isBusy = options.isBusy || (() => false);
  const isWaiting = options.isWaiting || (() => false);
  const echoCancelled = options.echoCancelled || (() => false);
  const onState = options.onState || (() => {});
  const emit = options.onEvent || (() => {});
  const mark = options.mark || (() => {});
  const now = options.now || (() => Date.now());

  let state = SessionState.INACTIVE;
  /** The recognizer in use: the main one, or the fallback after a one-time notice. */
  let recognizer = options.recognizer || null;
  let usingFallback = false;
  let partial = '';
  let greeted = false;
  let spoke = false;
  let bargeIn = false;
  let paused = false;
  let aiSpeaking = false;
  let aiEndedAt = -Infinity;
  let resumeTimer = null;
  const recentAi = [];
  /** Navigation and system lines just announced, with when their sound is over. */
  const recentNav = [];
  /** The utterance being heard: when it began and whether that was while (or right after) the assistant spoke. */
  let utterance = null;
  let speechSince = null;
  let falseTimer = null;
  let heardSinceInterrupt = false;
  let lastActivity = now();
  let idleTimer = null;
  let wakeOn = false;
  let wakeReady = false;
  let micOff = false;
  let disposed = false;
  let sessionVersion = 0;
  let wakeVersion = 0;
  let starting = null;
  let startingWake = null;
  let cancelQuiet = null;

  const microphoneState = () => {
    if (micOff || disposed) return 'off';
    if (state === SessionState.STARTING) return 'starting';
    if (state === SessionState.ACTIVE) return 'listening';
    return wakeOn ? (wakeReady ? 'wake' : 'starting') : 'off';
  };
  const showMicrophone = () => options.onMicrophoneState?.(microphoneState());

  const setState = (next) => {
    state = next;
    onState(next);
    showMicrophone();
  };
  const setPartial = (text) => {
    partial = text;
    draft.setPartial(text);
  };
  const noteActivity = () => {
    lastActivity = now();
  };

  /** Forgets the words of the utterance being heard. */
  function dropUtterance() {
    setPartial('');
    utterance = null;
    if (state === SessionState.ACTIVE && !paused) {
      recognizer.pause();
      recognizer.resume();
    }
  }

  // ---- The assistant's own voice ----------------------------------------------------

  const unSpeak = output.onSpeak?.((sentence) => {
    recentAi.push({words: words(sentence), at: now()});
  }) || (() => {});
  const unAnnounce = output.onAnnounce?.((text) => {
    const said = words(text);
    recentNav.push({words: said, until: now() + said.length * ANNOUNCE_MS_PER_WORD + ECHO_AFTER_MS});
  }) || (() => {});

  /** Barge-in only works when the echo canceller removes the AI voice; otherwise the microphone waits while it speaks. */
  const canBargeIn = () => bargeIn && echoCancelled();

  /** Words the assistant said in the last few seconds, in order. */
  function aiWords() {
    const since = now() - ECHO_WINDOW_MS;
    while (recentAi.length && recentAi[0].at < since && !aiSpeaking) recentAi.shift();
    return recentAi.flatMap((s) => s.words);
  }

  /** Whether heard words are speech the app played coming back through the microphone. */
  function isEcho(text) {
    const heard = words(text);
    if (!heard.length || !utterance) return false;
    // While something speaks or just after (its sound still arriving), mostly its words (by sound) is its own voice.
    // A learner's yes this close to the assistant's "say yes" is dropped too; never a false consent.
    if ((utterance.duringAi || utterance.at - aiEndedAt <= ECHO_AFTER_MS) && playedShare(heard, aiWords()) >= 0.5) return true;
    while (recentNav.length && recentNav[0].until < utterance.at) recentNav.shift();
    return playedShare(heard, recentNav.flatMap((n) => n.words)) >= 0.5;
  }

  const unwatch = output.onState((s) => {
    const speaking = s === 'speaking';
    if (speaking === aiSpeaking) return;
    aiSpeaking = speaking;
    if (!speaking) aiEndedAt = now();
    noteActivity();
    if (state !== SessionState.ACTIVE || (speaking && canBargeIn())) return;
    // Without barge-in the microphone is ignored while it speaks, and for a moment after.
    clearTimeout(resumeTimer);
    if (speaking && !paused) {
      paused = true;
      recognizer.pause();
      setPartial('');
      utterance = null;
    } else if (!speaking && paused) {
      resumeTimer = setTimeout(() => {
        if (state !== SessionState.ACTIVE || aiSpeaking) return;
        paused = false;
        recognizer.resume();
      }, TAIL_MS);
    }
  });

  /** Stops the assistant because the learner is talking over it. */
  function bargeInNow() {
    mark('voice:barge-in');
    output.interrupt();
    emit('speech.interrupted', {by: 'voice'});
  }

  function heardWords(text, final) {
    if (state !== SessionState.ACTIVE || micOff || disposed) return;
    const cleaned = cleanTranscript(text);
    if (!cleaned) {
      if (!final) setPartial('');
      return;
    }
    if (!utterance) {
      const at = now();
      utterance = {at, duringAi: aiSpeaking || at - aiEndedAt < TAIL_MS};
      if (!final) mark('voice:first-partial');
    }
    if (isEcho(cleaned)) {
      dropUtterance();
      return;
    }
    // Stray filler words and lone letters the recognizer makes from the end of a sound.
    if (words(cleaned).every((w) => FILLERS.has(w) || w.length === 1)) {
      setPartial('');
      if (final) utterance = null;
      return;
    }
    if (aiSpeaking) {
      // Talking over the assistant: only with barge-in, after enough speech, and with words that aren't its own.
      const speechMs = speechSince === null ? 0 : now() - speechSince;
      if (!canBargeIn() || speechMs < BARGE_IN_MS) return;
      bargeInNow();
    }
    heardSinceInterrupt = true;
    noteActivity();
    if (!final) {
      setPartial(cleaned);
      return;
    }
    mark('voice:final');
    spoke = true;
    setPartial('');
    utterance = null;
    draft.set(appendToDraft(draft.value(), cleaned));
  }

  // ---- Session -------------------------------------------------------------------------

  /** Resolves when the output has spoken what is queued (or after a few seconds). */
  function quiet() {
    return new Promise((resolve) => {
      let seen = output.state() === 'speaking';
      const done = () => {
        off();
        clearTimeout(timer);
        if (cancelQuiet === done) cancelQuiet = null;
        resolve();
      };
      const off = output.onState((s) => {
        if (s === 'speaking') seen = true;
        else if (seen) done();
      });
      const timer = setTimeout(done, 8000);
      cancelQuiet = done;
    });
  }

  async function loadRecognizer() {
    try {
      if (!recognizer) throw new Error('no recognizer');
      await recognizer.ready();
      return !usingFallback;
    } catch (e) {
      const fallback = options.fallback;
      if (!fallback || !settings().fallbackAllowed || recognizer === fallback) throw e;
      console.warn('[voice] using the fallback recognizer:', e);
      recognizer = fallback;
      usingFallback = true;
      await recognizer.ready();
      return false;
    }
  }

  async function start() {
    if (disposed || state !== SessionState.INACTIVE) return;
    micOff = false;
    const version = ++sessionVersion;
    const current = () => !disposed && !micOff && version === sessionVersion && state === SessionState.STARTING;
    setState(SessionState.STARTING);
    stopWake();
    // A cancelled engine start must settle before another start uses the same engine.
    const previous = starting;
    const pending = (async () => {
      await previous;
      if (current()) await startEngines(current);
    })();
    starting = pending;
    try {
      await pending;
    } finally {
      if (starting === pending) starting = null;
    }
  }

  async function startEngines(current) {
    try {
      const main = await loadRecognizer();
      if (!current()) return;
      recognizer.setHotwords(hotwords());
      if (!main && !greeted) output.say({source: 'system', text: SAY.fallback});
      // The microphone opens after "I'm listening.", so the assistant doesn't hear itself say it.
      if (!greeted) {
        greeted = true;
        output.say({source: 'ai', kind: 'answer', text: SAY.listening});
        await quiet();
      }
      if (!current()) return;
      speechSince = null;
      await recognizer.start({onPartial: (t) => heardWords(t, false), onFinal: (t) => heardWords(t, true)});
    } catch (e) {
      recognizer?.stop();
      if (!current()) return;
      console.warn('[voice]', e);
      setState(SessionState.INACTIVE);
      output.say({source: 'system', text: e?.name === 'NotAllowedError' ? SAY.noMicrophone : SAY.notSetUp});
      refreshWake();
      return;
    }
    // Ended while the engine was loading.
    if (!current()) {
      recognizer.stop();
      return;
    }
    paused = false;
    utterance = null;
    bargeIn = false;
    if (settings().bargeIn && options.vad && !usingFallback) {
      try {
        await options.vad.start({
          onSpeechStart: () => {
            if (state !== SessionState.ACTIVE || micOff || disposed) return;
            speechSince = now();
            mark('voice:speech-start');
          },
          onSpeechEnd: () => {
            if (state !== SessionState.ACTIVE || micOff || disposed) return;
            speechSince = null;
            mark('voice:speech-end');
          },
        });
        if (!current()) {
          recognizer.stop();
          options.vad.stop();
          return;
        }
        bargeIn = true;
      } catch (e) {
        options.vad.stop();
        if (!current()) {
          recognizer.stop();
          return;
        }
        console.warn('[voice] no voice activity, so no barge-in:', e);
      }
    }
    if (!current()) return;
    setState(SessionState.ACTIVE);
    output.cue('listeningOn');
    mark('voice:listening');
    emit('session.started', {bargeIn, fallback: usingFallback});
    noteActivity();
    clearInterval(idleTimer);
    idleTimer = setInterval(checkIdle, 1000);
  }

  function stopEngines() {
    clearInterval(idleTimer);
    clearTimeout(resumeTimer);
    clearTimeout(falseTimer);
    cancelQuiet?.();
    recognizer?.stop();
    options.vad?.stop();
    bargeIn = false;
    paused = false;
    speechSince = null;
    setPartial('');
    utterance = null;
  }

  function end(reason = 'ended') {
    if (state === SessionState.INACTIVE) return;
    const active = state === SessionState.ACTIVE;
    sessionVersion += 1;
    stopEngines();
    setState(SessionState.INACTIVE);
    if (active) {
      output.cue('listeningOff');
      emit(`session.${reason}`, {});
    }
    refreshWake();
  }

  function turnMicrophoneOff() {
    micOff = true;
    stopWake();
    if (state === SessionState.INACTIVE) stopEngines();
    else end();
    showMicrophone();
    output.say({source: 'system', text: SAY.micOff});
  }

  /** Nobody spoke or typed for a while (counted only while the output is silent and no task works). */
  function checkIdle() {
    if (state !== SessionState.ACTIVE) return;
    if (output.state() !== 'silent' || isBusy()) {
      noteActivity();
      return;
    }
    const limit = draft.value().trim() ? IDLE_MS.draft : isWaiting() ? IDLE_MS.waiting : IDLE_MS.plain;
    if (now() - lastActivity < limit) return;
    output.say({source: 'ai', kind: 'answer', text: wakeOn || settings().wakePhrase ? SAY.suspendWake : SAY.suspend});
    end('suspended');
  }

  // ---- Wake phrase -----------------------------------------------------------------------

  function stopWake() {
    wakeVersion += 1;
    if (!wakeOn) return;
    wakeOn = false;
    wakeReady = false;
    options.spotter.stop();
    showMicrophone();
  }

  /** Listens for "Hey Neon" only when the setting is on and no session is active. */
  async function refreshWake() {
    const want = !micOff && !disposed && settings().wakePhrase && state === SessionState.INACTIVE && !!options.spotter;
    if (!want) {
      stopWake();
      return;
    }
    if (wakeOn) return;
    wakeOn = true;
    const version = ++wakeVersion;
    const current = () => wakeOn && version === wakeVersion && !micOff && !disposed;
    showMicrophone();
    const previous = startingWake;
    const pending = (async () => {
      await previous;
      if (current()) await startWake(current);
    })();
    startingWake = pending;
    try {
      await pending;
    } finally {
      if (startingWake === pending) startingWake = null;
    }
  }

  async function startWake(current) {
    try {
      await options.spotter.start({
        onWake: () => {
          if (!current()) return;
          emit('session.wake', {});
          start();
        },
      });
      if (!current()) {
        options.spotter.stop();
        return;
      }
      wakeReady = true;
      showMicrophone();
    } catch (e) {
      options.spotter.stop();
      if (!current()) return;
      console.warn('[voice] no wake phrase:', e);
      wakeOn = false;
      wakeReady = false;
      showMicrophone();
      output.say({source: 'system', text: SAY.noWake});
    }
  }

  showMicrophone();

  return {
    start,
    end: () => end('ended'),
    toggle: () => (state === SessionState.INACTIVE ? start() : end('ended')),
    /** Mic off also stops wake listening until the learner explicitly starts listening again. */
    micOff: turnMicrophoneOff,
    toggleMicrophone: () => (microphoneState() === 'off' ? start() : turnMicrophoneOff()),
    microphoneState,
    /** Sends the draft, with any words still being recognized. "End conversation" ends the session instead. */
    send() {
      const text = appendToDraft(draft.value(), partial).trim();
      if (!text) return;
      if (state === SessionState.ACTIVE && END_WORDS.test(text.toLowerCase().replace(/[^a-z ]/g, '').trim())) {
        draft.set('');
        setPartial('');
        output.say({source: 'ai', kind: 'answer', text: isWaiting() ? SAY.endedWaiting : SAY.ended});
        end('ended');
        return;
      }
      const medium = spoke ? 'voice' : 'text';
      draft.set('');
      dropUtterance();
      spoke = false;
      noteActivity();
      output.cue('sent');
      mark('voice:sent');
      emit('message.submitted', {input: medium, text});
      submit(text, medium);
    },
    /** Empties the draft. */
    discard() {
      draft.set('');
      dropUtterance();
      spoke = false;
    },
    /** I while the assistant speaks: stop it and listen; if nothing is said, the cut sentence plays again. */
    async talk() {
      output.interrupt();
      emit('speech.interrupted', {by: 'key'});
      heardSinceInterrupt = false;
      clearTimeout(falseTimer);
      if (state === SessionState.INACTIVE) await start();
      falseTimer = setTimeout(() => {
        if (!heardSinceInterrupt && !draft.value().trim()) output.replayInterrupted?.();
      }, FALSE_INTERRUPTION_MS);
    },
    /** Typing in the draft counts as activity for the idle timer. */
    noteActivity,
    /** The wake phrase setting changed. */
    refreshWake,
    state: () => state,
    dispose() {
      disposed = true;
      unwatch();
      unSpeak();
      unAnnounce();
      end('ended');
      stopEngines();
      stopWake();
    },
  };
}
