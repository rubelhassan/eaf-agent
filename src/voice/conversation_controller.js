// @ts-check
// The voice conversation: a session that listens, spoken words into the draft, sending it, interruptions, idle
// and the wake phrase. The assistant never hears itself: the browser's echo canceller removes the AI voice the page
// plays, system speech waits before the microphone opens, and words that sound like what it or navigation speech just
// said are dropped (so "Say yes to do it" is never a yes).

import {appendToDraft, cleanTranscript, shownTranscript, isStraySound, createDraftSegments, reviseSegments} from './draft.js';
import {playedShare, spokenWords} from './echo.js';
import {applyModes} from './modes.js';

export const SessionState = Object.freeze({INACTIVE: 'inactive', STARTING: 'starting', ACTIVE: 'active'});

// The voice conversation is part of the assistant panel, so its lines are heard where AI replies are.
const SAY = {
  listening: "I'm listening.",
  notSetUp: 'Voice is not set up yet. You can still type.',
  noMicrophone: "I can't use the microphone. Allow it in the browser, or type instead.",
  limit: 'That was a long one; I stopped at 60 seconds.',
  fallback: "I'm using the browser's speech recognition, which may send your voice to the browser's company.",
  idleStop: 'Listening stopped. Press Control Shift I to talk.',
  idleStopWake: (name) => `Listening stopped. Press Control Shift I or say Hey ${name} to talk.`,
  ended: "Okay, I'll stop listening.",
  endedWaiting: "Okay, I'll stop listening. I'm still waiting for your answer when you come back.",
  noWake: (name) => `Hey ${name} isn't set up yet. Press Control Shift V to talk.`,
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
const ECHO_AFTER_MS = 1500;
// Screen readers don't say when they finish, so navigation speech is given time by its length.
const ANNOUNCE_MS_PER_WORD = 400;
// Nothing said this long: listening stops (the draft and a waiting question stay).
const IDLE_MS = 30000;
// While listening and nothing is heard, a soft cue this often says the microphone is still on.
const REMINDER_MS = 5000;
const BASIC_FINAL_MS = 1500;
const START_WAIT_TIMEOUT_MS = 8000;
const START_WAIT_BASE_MS = 2500;
const START_WAIT_PER_WORD_MS = 60;
const words = spokenWords;

/**
 * @param {{output: !Object, recognizer: ?import('./engines.js').Recognizer,
 *     fallback?: ?import('./engines.js').Recognizer, vad?: ?import('./engines.js').VoiceActivity,
 *     bargeIn?: ?import('./engines.js').Recognizer, browserFallback?: ?import('./engines.js').Recognizer,
 *     vocabulary?: function(): !Array<string>, onEngineState?: function(!Object): void,
 *     spotter?: ?import('./engines.js').KeywordSpotter,
 *     draft: {value: function(): string, set: function(string, {replay?: boolean}=): void, setPartial: function(string): void},
 *     submit: function(string, string, {segments: !Array<!Object>}=): void, hotwords?: function(): !Array<string>,
 *     onReplay?: function(!Array<{utterance: number, text: string}>): void, onReplayDrop?: function(!Array<number>): void,
 *     settings?: function(): {bargeIn: boolean, wakePhrase: boolean, fallbackAllowed: boolean},
 *     isBusy?: function(): boolean, isWaiting?: function(): boolean, echoCancelled?: function(): boolean,
 *     onState?: function(string): void, onMicrophoneState?: function(string): void,
 *     onEvent?: function(string, !Object): void, mark?: function(string, !Object=): void, benchWords?: boolean,
 *     now?: function(): number, name?: string, onWakePaused?: function(): void}} options
 *     fallback: used only when the recognizer can't load and the task allows it; isBusy: a task is working;
 *     isWaiting: an answer is awaited; echoCancelled: the AI voice is played by the page, so the echo canceller removes
 *     it (barge-in needs that); mark: timing marks for the browser bench; name: the assistant's name, in the wake phrase;
 *     onWakePaused: the wake phrase was heard while listening was paused (the host brings focus back)
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
  const name = options.name || 'Neon';

  let state = SessionState.INACTIVE;
  /** The recognizer producing words now. */
  let recognizer = options.recognizer || null;
  let usingFallback = false;
  let engineVersion = 0;
  let switching = false;
  let previousEngine = null;
  let previousEngineState = '';
  let serverConnection = {connection: 'connected', reason: 'session-start'};
  let recoveryPending = false;
  let fallbackPrewarmed = false;
  const replayBuffer = options.recognizer?.replayBuffer || null;
  const replayContexts = new Map();
  const segments = createDraftSegments({onDrop: (id) => dropReplayGroup(id)});
  let basicActiveId = null;
  let replayingId = null;
  let replayTimer = null;
  let listenerVersion = 0;
  let listenerStarting = null;
  let listenerOn = false;
  let partial = '';
  let greeted = false;
  let spoke = false;
  let bargeIn = false;
  let paused = false;
  /** Focus is outside the assistant panel: listening waits (the host says so with setAway). */
  let away = false;
  let aiSpeaking = false;
  let aiEndedAt = -Infinity;
  let resumeTimer = null;
  const recentAi = [];
  /** Navigation and system lines just announced, with when their sound is over. */
  const recentNav = [];
  /** The utterance being heard: when it began and whether that was while (or right after) the assistant spoke. */
  let utterance = null;
  let speechSince = null;
  const utteranceContexts = new Map();
  const awaitingDecision = new Map();
  let falseTimer = null;
  let heardSinceInterrupt = false;
  let lastActivity = now();
  let lastReminder = -Infinity;
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
    if (state === SessionState.ACTIVE) return away ? 'paused' : 'listening';
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
    const id = utterance?.id;
    if (id !== undefined) forgetUtterance(id);
    setPartial('');
    utterance = null;
    if (state === SessionState.ACTIVE && !paused && !away) {
      if (recognizer.cancel) { if (id !== undefined || replayingId === null) recognizer.cancel(id); }
      else { recognizer.pause(); recognizer.resume(); }
    }
  }

  // ---- The assistant's own voice ----------------------------------------------------

  const unSpeak = output.onSpeak?.((sentence) => {
    recentAi.push({words: words(sentence), at: now()});
    if (aiSpeaking && !canBargeIn() && !paused) {
      paused = true;
      recognizer?.pause();
    }
  }) || (() => {});
  const unAnnounce = output.onAnnounce?.((text) => {
    const said = words(text);
    recentNav.push({words: said, until: now() + said.length * ANNOUNCE_MS_PER_WORD + ECHO_AFTER_MS});
  }) || (() => {});

  /** Barge-in only works when the echo canceller removes the AI voice; otherwise the microphone waits while it speaks. */
  const canBargeIn = () => bargeIn && echoCancelled();

  const speechLength = (context = utterance) => context?.speechStartAt == null ? 0 :
    (context.speechEndAt ?? now()) - context.speechStartAt;

  function forgetUtterance(id) {
    awaitingDecision.delete(id);
    utteranceContexts.delete(id);
    if (utterance?.id === id) utterance = null;
  }

  function cancelPending() {
    const liveIds = [...utteranceContexts.keys()];
    awaitingDecision.clear(); utteranceContexts.clear();
    if (replayingId === null) recognizer?.cancel?.();
    else liveIds.forEach((id) => recognizer?.cancel?.(id));
    utterance = null;
    if (recoveryPending) void restoreServer();
  }

  function finalWords(text, metadata) {
    const id = metadata?.utterance;
    if (id === undefined) { heardWords(text, true); return; }
    const context = utteranceContexts.get(id);
    if (!context) return;
    const active = utterance;
    forgetUtterance(id);
    utterance = context;
    try { heardWords(text, true); }
    finally { if (utterance === null || utterance === context) utterance = active?.id !== id ? active : null; }
  }

  function recognizerError(error, metadata) {
    if (metadata?.replay) {
      if (error.code !== 'too-long') dropReplayGroup(metadata.utterance);
      return true;
    }
    if (metadata?.utterance === undefined) return false;
    // The limit notice is nonterminal: its final still belongs to this id.
    if (error.code !== 'too-long' && error.message !== 'too-long') forgetUtterance(metadata.utterance);
    return true;
  }

  /** Words the assistant said in the last few seconds, in order. */
  function aiWords() {
    const since = now() - ECHO_WINDOW_MS;
    while (recentAi.length && recentAi[0].at < since && !aiSpeaking) recentAi.shift();
    return recentAi.flatMap((s) => s.words);
  }

  /** Whether heard words are speech the app played coming back through the microphone. */
  function isEcho(text, context = utterance, original = null) {
    const heard = words(text);
    if (!heard.length || !context) return false;
    // A fresh VAD utterance with page echo cancellation can start answering when listening resumes.
    // Unknown capture times and speech overlapping the assistant keep the longer echo guard.
    const afterAiMs = (original?.endpointing || recognizer.endpointing) === 'vad' && echoCancelled() && context.beganWhileSpeaking === false ?
      TAIL_MS : ECHO_AFTER_MS;
    if ((context.duringAi || context.at - (original?.aiEndedAt ?? aiEndedAt) <= afterAiMs) &&
        playedShare(heard, original?.ai || aiWords()) >= 0.5) return true;
    if (!original) while (recentNav.length && recentNav[0].until < context.at) recentNav.shift();
    return playedShare(heard, (original?.nav || recentNav).flatMap((n) => n.words)) >= 0.5;
  }

  const unwatch = output.onState((s) => {
    const speaking = s === 'speaking';
    if (speaking === aiSpeaking) return;
    aiSpeaking = speaking;
    if (!speaking) aiEndedAt = now();
    noteActivity();
    void syncListener();
    if (state !== SessionState.ACTIVE || (speaking && canBargeIn())) return;
    // Without barge-in the microphone is ignored while it speaks, and for a moment after.
    clearTimeout(resumeTimer);
    if (speaking && !paused) {
      paused = true;
      if (!away) recognizer.pause();
      awaitingDecision.clear(); utteranceContexts.clear();
      setPartial('');
      utterance = null;
    } else if (!speaking) {
      const wasPaused = paused;
      resumeTimer = setTimeout(() => {
        if (state !== SessionState.ACTIVE || aiSpeaking) return;
        paused = false;
        if (wasPaused && !away) recognizer.resume();
        void syncListener();
      }, TAIL_MS);
    }
  });

  /** Stops the assistant because the learner is talking over it. */
  function bargeInNow(context = utterance, source = 'listener') {
    if (context?.interrupted) return;
    if (context) context.interrupted = true;
    const detail = {utterance: context?.id, source};
    mark('voice:barge-in', detail);
    output.interrupt();
    mark('voice:ai-stopped', detail);
    emit('speech.interrupted', {by: 'voice'});
  }

  function heardWords(text, final, provisional = null) {
    if (state !== SessionState.ACTIVE || micOff || disposed || away) return;
    const shown = shownTranscript(text, {cased: recognizer.cased});
    const plain = cleanTranscript(text);
    if (!plain) {
      if (!final) setPartial('');
      else utterance = null;
      return;
    }
    if (!utterance) {
      const at = now();
      utterance = {at, duringAi: aiSpeaking || at - aiEndedAt < TAIL_MS};
      if (!final) mark('voice:first-partial');
    }
    if (isEcho(plain)) {
      dropUtterance();
      return;
    }
    // Stray filler words and lone letters the recognizer makes from the end of a sound.
    if (isStraySound(words(plain))) {
      setPartial('');
      if (final) utterance = null;
      return;
    }
    if (aiSpeaking) {
      // Talking over the assistant: only with barge-in, after enough speech, and with words that aren't its own.
      const speechMs = speechLength();
      if (!canBargeIn() || speechMs < BARGE_IN_MS) return;
      bargeInNow(utterance, recognizer.endpointing === 'vad' ? 'whisper' : 'listener');
    }
    heardSinceInterrupt = true;
    noteActivity();
    if (!final) {
      setPartial(shown);
      return;
    }
    const detail = {utterance: utterance?.id};
    mark('voice:final', detail);
    spoke = true;
    setPartial('');
    utterance = null;
    segments.set(draft.value());
    const result = applyModes(shown);
    draft.set(segments.append(result.text, {segments: result.segments,
      ...(provisional ? {utterance: provisional.id, provisional: true, covers: [...provisional.covers]} : {})}));
    mark('voice:final-shown', detail);
  }

  // ---- Session -------------------------------------------------------------------------

  function echoSnapshot() {
    return {ai: [...aiWords()], nav: recentNav.map((line) => ({...line})), aiEndedAt, endpointing: recognizer.endpointing || 'own'};
  }

  function eligibleWindows() {
    const at = now();
    return [...replayContexts.values()].filter((context) => !context.closed && context.at <= at &&
      (context.speechEndAt == null || at <= context.speechEndAt + BASIC_FINAL_MS));
  }

  function beginBasic() {
    if (!replayBuffer || recognizer === options.recognizer) return null;
    segments.set(draft.value());
    const id = replayBuffer.begin();
    if (id === null) return null;
    const earlier = eligibleWindows()[0];
    const owner = earlier ? replayContexts.get(earlier.owner) : null;
    const context = {id, owner: owner?.id ?? id, covers: [id], at: now(), speechStartAt: now(), speechEndAt: null,
      duringAi: aiSpeaking || now() - aiEndedAt < TAIL_MS, beganWhileSpeaking: aiSpeaking, interrupted: false,
      closed: false, echo: echoSnapshot(), vocabulary: [...(options.vocabulary?.() || [])]};
    replayContexts.set(id, context); basicActiveId = id;
    segments.reserve(id);
    if (owner) { owner.covers.push(id); segments.cover(owner.covers); }
    return context;
  }

  function endBasic() {
    const context = replayContexts.get(basicActiveId);
    basicActiveId = null;
    if (!context) return;
    replayBuffer.end(context.id);
    context.speechEndAt = now(); context.echo = echoSnapshot();
    context.timer = setTimeout(() => {
      context.closed = true;
      if (utterance?.id === context.id) utterance = null;
      if (recoveryPending) void restoreServer();
      pumpReplay();
    }, BASIC_FINAL_MS);
  }

  function dropReplayGroup(id) {
    const context = replayContexts.get(id);
    if (!context) return;
    const owner = replayContexts.get(context.owner) || context;
    const ids = [...owner.covers];
    for (const key of ids) {
      const entry = replayContexts.get(key);
      clearTimeout(entry?.timer); replayContexts.delete(key); segments.release(key);
      if (basicActiveId === key) basicActiveId = null;
    }
    for (const key of ids) {
      replayBuffer?.drop(key);
      if (replayingId === key) { options.recognizer?.cancel?.(key); replayingId = null; }
    }
    options.onReplayDrop?.(ids);
  }

  function pumpReplay() {
    if (!replayBuffer || replayingId !== null || switching || state !== SessionState.ACTIVE ||
        recognizer !== options.recognizer || serverConnection.connection !== 'connected' || speechSince !== null || utterance) return;
    const available = new Set(replayBuffer.ids());
    const context = [...replayContexts.values()].find((entry) => entry.closed && entry.final === undefined && (entry.frames || available.has(entry.id)));
    if (!context) return;
    context.frames ||= replayBuffer.take(context.id);
    if (!context.frames?.length) { dropReplayGroup(context.id); pumpReplay(); return; }
    recognizer.setVocabulary?.(context.vocabulary);
    replayingId = context.id;
    if (!recognizer.replay?.(context.id, context.frames)) {
      replayingId = null;
      clearTimeout(replayTimer); replayTimer = setTimeout(pumpReplay, 50);
    } else context.frames = null;
  }

  function replayFinal(text, metadata) {
    const context = replayContexts.get(metadata.utterance);
    if (!context) return;
    replayingId = null;
    const shown = shownTranscript(text, {cased: true});
    if (!shown || isStraySound(words(cleanTranscript(shown))) || isEcho(shown, context, context.echo)) {
      dropReplayGroup(context.id); pumpReplay(); return;
    }
    context.final = applyModes(shown);
    const owner = replayContexts.get(context.owner);
    const group = owner?.covers.map((id) => replayContexts.get(id));
    if (group?.every((entry) => entry && entry.final !== undefined)) {
      const updates = group.map((entry) => ({utterance: entry.id, ...entry.final}));
      segments.set(draft.value());
      if (!group.every((entry) => replayContexts.has(entry.id))) { pumpReplay(); return; }
      if (segments.replaceGroup(updates)) draft.set(segments.value(), {replay: true});
      else options.onReplay?.(updates);
      for (const entry of group) { clearTimeout(entry.timer); replayContexts.delete(entry.id); }
    }
    pumpReplay();
  }

  function draftEdited() {
    segments.set(draft.value());
  }

  /** System speech gets a loading timeout, then a separate cap from when it starts. */
  function quiet({capMs}) {
    return new Promise((resolve) => {
      let seen = false;
      let timer;
      const done = (ended) => {
        off();
        clearTimeout(timer);
        if (cancelQuiet === done) cancelQuiet = null;
        if (ended) mark('voice:start-wait', {ended});
        resolve();
      };
      // System speech starts the cap; startup still pauses recognition during an unfinished welcome.
      const speechStarted = () => {
        if (echoCancelled()) { done('skipped'); return; }
        if (seen) return;
        seen = true;
        clearTimeout(timer);
        timer = setTimeout(() => done('cap'), capMs);
      };
      const off = output.onState((s) => {
        if (s === 'speaking') speechStarted();
        else if (seen) done('speech');
      });
      timer = setTimeout(() => done('timeout'), START_WAIT_TIMEOUT_MS);
      cancelQuiet = done;
      if (output.state() === 'speaking') speechStarted();
    });
  }

  function engineNotice() {
    const engine = recognizer === options.recognizer ? 'server' : recognizer === options.browserFallback ? 'browser' : 'basic';
    // Existing hosts with one on-device recognizer do not report a server transition.
    if (options.recognizer?.endpointing !== 'vad') return;
    const {connection, reason, ...details} = serverConnection;
    const key = `${engine}:${connection}:${reason}`;
    if (key === previousEngineState) return;
    const since = now();
    console.warn('[voice] engine', {from: previousEngine, to: engine, connection, reason,
      closeCode: null, closeReason: '', attempt: 0, sinceLastMessageMs: 0, ...details});
    options.onEngineState?.({engine, connection, reason, since});
    emit('voice.engine', {engine, connection, reason});
    if (engine !== previousEngine) {
      if (engine === 'basic') output.cue('engineBasic');
      else if (engine === 'browser') output.say({source: 'assistant', text: SAY.fallback});
    }
    previousEngine = engine; previousEngineState = key;
  }

  function prewarmFallback() {
    if (fallbackPrewarmed || options.recognizer?.endpointing !== 'vad' || !options.fallback?.ready) return;
    fallbackPrewarmed = true;
    try {
      void Promise.resolve(options.fallback.ready()).catch((error) => console.warn('[voice] fallback engine', error));
    } catch (error) { console.warn('[voice] fallback engine', error); }
  }

  function connectionChanged(detail, version) {
    if (version !== sessionVersion || disposed || micOff || state === SessionState.INACTIVE) return;
    serverConnection = detail;
    if (detail.connection === 'reconnecting') prewarmFallback();
    // Taken audio must not sit outside the buffer's cap after a connection loss.
    if (detail.connection !== 'connected') for (const context of [...replayContexts.values()]) {
      if (context.frames) dropReplayGroup(context.id);
    }
    engineNotice();
    recoveryPending = detail.connection === 'connected' && detail.reason === 'recovered';
    if (recoveryPending) void restoreServer();
  }

  async function restoreServer() {
    if (!recoveryPending || !usingFallback || switching || speechSince !== null || utterance || state !== SessionState.ACTIVE || disposed || micOff) return;
    if (eligibleWindows().length) return;
    recoveryPending = false; switching = true;
    const version = sessionVersion;
    const previous = recognizer;
    cancelPending(); previous.stop();
    recognizer = options.recognizer; usingFallback = false;
    try {
      await startRecognizer(version);
      if (version !== sessionVersion || disposed || micOff) { recognizer.stop(); return; }
      bargeIn = !!settings().bargeIn && !!options.vad;
      paused = aiSpeaking && !canBargeIn();
      if (paused || away) recognizer.pause();
      engineNotice();
    } catch (error) {
      if (version !== sessionVersion) return;
      recognizer = previous; usingFallback = true;
      try {
        await startRecognizer(version);
        if (version !== sessionVersion) return;
        if (paused || away) recognizer.pause();
        engineNotice();
      } catch {
        if (version !== sessionVersion) return;
        end('ended');
        output.say({source: 'assistant', kind: 'error', text: SAY.notSetUp});
      }
    } finally { switching = false; void syncListener(); pumpReplay(); }
  }

  async function loadRecognizer() {
    const version = sessionVersion;
    recognizer = options.recognizer || null;
    usingFallback = false;
    try {
      if (!recognizer) throw new Error('no recognizer');
      await recognizer.ready({onConnection: (detail) => connectionChanged(detail, version),
        onReplayDrop: (id) => dropReplayGroup(id),
        onError: (error) => { if (version === sessionVersion) void failedRecognizer(error, version); }});
    } catch (error) {
      if (version !== sessionVersion) return false;
      prewarmFallback();
      if (!error.retrying) { recognizer?.stop(); recognizer?.disconnect?.(); }
      serverConnection = {...serverConnection, connection: 'fallback', reason: error.reason || 'voice-unavailable'};
      await loadFallback(error);
    }
    if (version !== sessionVersion) return false;
    engineNotice();
    return !usingFallback;
  }

  async function loadFallback(error) {
    const basicAllowed = options.recognizer?.endpointing === 'vad';
    const candidates = [options.fallback, ...(basicAllowed && settings().fallbackAllowed ? [options.browserFallback] : [])];
    if (!basicAllowed && !settings().fallbackAllowed) throw error;
    const from = candidates.indexOf(recognizer);
    for (const candidate of candidates.slice(from + 1)) {
      if (!candidate) continue;
      try {
        await candidate.ready(); recognizer = candidate; usingFallback = true; return;
      } catch (failure) { error = failure; }
    }
    throw error;
  }

  async function startRecognizer(version) {
    const generation = ++engineVersion;
    await recognizer.start({
      onPartial: (text) => { if (version === sessionVersion && generation === engineVersion) heardWords(text, false); },
      onFinal: (text, metadata) => {
        if (version !== sessionVersion || generation !== engineVersion) return;
        if (metadata?.replay) { replayFinal(text, metadata); return; }
        const span = recognizer !== options.recognizer ? eligibleWindows()[0] : null;
        if (span) {
          const owner = replayContexts.get(span.owner);
          const active = utterance;
          utterance = span; heardWords(text, true, owner);
          if (active?.id !== span.id) utterance = active;
        } else finalWords(text, metadata);
        if (recoveryPending) void restoreServer();
        pumpReplay();
      },
      onError: (error, metadata) => {
        if (version !== sessionVersion || generation !== engineVersion) return;
        if (!recognizerError(error, metadata)) void failedRecognizer(error, version);
      },
      onLimit: () => {
        if (version === sessionVersion && generation === engineVersion) output.say({source: 'assistant', text: SAY.limit});
      },
      onConnection: (detail) => connectionChanged(detail, version),
      onReplayDrop: (id) => dropReplayGroup(id),
    });
  }

  async function failedRecognizer(error, version) {
    if (switching || state !== SessionState.ACTIVE) return;
    switching = true;
    cancelPending();
    stopListener();
    await listenerStarting;
    if (!error.retrying) { recognizer.stop(); recognizer.disconnect?.(); }
    ++engineVersion;
    serverConnection = {...serverConnection, connection: 'fallback', reason: error.reason || 'voice-unavailable'};
    try {
      await loadFallback(error);
      if (version !== sessionVersion || disposed || micOff) return;
      recognizer.setHotwords(hotwords());
      await startRecognizer(version);
      if (version !== sessionVersion || disposed || micOff) { recognizer.stop(); return; }
      if (recognizer === options.browserFallback) bargeIn = false;
      engineNotice();
      paused = aiSpeaking && !canBargeIn();
      if (paused || away) recognizer.pause();
    } catch (failure) {
      if (version !== sessionVersion) return;
      end('ended');
      output.say({source: 'assistant', kind: 'error', text: SAY.notSetUp});
    } finally { switching = false; if (recoveryPending) void restoreServer(); }
  }

  function stopListener() {
    ++listenerVersion;
    if (listenerOn) options.bargeIn?.stop();
    listenerOn = false;
  }

  async function syncListener() {
    const want = state === SessionState.ACTIVE && !away && !micOff && canBargeIn() &&
      recognizer.endpointing === 'vad' && options.bargeIn && recognizer !== options.bargeIn &&
      (aiSpeaking || now() - aiEndedAt < TAIL_MS);
    if (!want) { stopListener(); return; }
    if (listenerOn || listenerStarting) return;
    const generation = ++listenerVersion;
    const pending = (async () => {
      try {
        await options.bargeIn.ready();
        if (generation !== listenerVersion) return;
        options.bargeIn.setHotwords(hotwords());
        listenerOn = true;
        await options.bargeIn.start({onPartial: bargeInHeard, onFinal: bargeInHeard});
        if (generation !== listenerVersion) options.bargeIn.stop();
      } catch {
        cancelPending();
        options.bargeIn.stop(); listenerOn = false;
        // Without word checks, VAD alone must never interrupt the assistant.
        bargeIn = false;
        if (aiSpeaking) { paused = true; recognizer.pause(); }
      }
    })();
    listenerStarting = pending;
    try { await pending; } finally { if (listenerStarting === pending) listenerStarting = null; }
  }

  function bargeInHeard(text) {
    const plain = cleanTranscript(text);
    const detail = {utterance: utterance?.id, speechStartAt: utterance?.speechStartAt};
    const diagnose = (name, extra = {}) => {
      if (options.benchWords) mark(name, {...detail, ...extra, words: plain});
    };
    diagnose('voice:barge-in-raw');
    if (!listenerOn || state !== SessionState.ACTIVE || away || micOff || disposed || !canBargeIn()) {
      diagnose('voice:barge-in-rejected', {reason: 'not-listening'}); return;
    }
    if (!aiSpeaking || utterance?.interrupted) {
      diagnose('voice:barge-in-rejected', {reason: 'not-speaking'}); return;
    }
    if (!utterance) utterance = {at: now(), duringAi: true};
    if (isEcho(plain)) { diagnose('voice:barge-in-rejected', {reason: 'echo'}); return; }
    if (!plain || isStraySound(words(plain))) { diagnose('voice:barge-in-rejected', {reason: 'stray'}); return; }
    if (speechLength() < BARGE_IN_MS) { diagnose('voice:barge-in-rejected', {reason: 'short'}); return; }
    mark('voice:barge-in-words', detail);
    bargeInNow(utterance, 'listener');
  }

  async function start() {
    if (disposed || state !== SessionState.INACTIVE) return;
    micOff = false;
    recoveryPending = false;
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
    const version = sessionVersion;
    try {
      await listenerStarting;
      const main = await loadRecognizer();
      if (!current()) return;
      recognizer.setHotwords(hotwords());
      if (!main && !greeted && options.recognizer?.endpointing !== 'vad') output.say({source: 'assistant', text: SAY.fallback});
      if (!greeted) {
        greeted = true;
        output.say({source: 'assistant', text: SAY.listening});
        if (echoCancelled()) mark('voice:start-wait', {ended: 'skipped'});
        else {
          const wordCount = SAY.listening.split(/\s+/).length;
          const rate = output.settings?.().speechRate || output.settings?.().aiRate || 1;
          await quiet({capMs: START_WAIT_BASE_MS + START_WAIT_PER_WORD_MS * wordCount / rate});
        }
      }
      if (!current()) return;
      speechSince = null;
      await startRecognizer(version);
    } catch (e) {
      recognizer?.stop();
      if (!current()) return;
      console.warn('[voice]', e);
      setState(SessionState.INACTIVE);
      output.say({source: 'assistant', kind: 'error', text: e?.name === 'NotAllowedError' ? SAY.noMicrophone : SAY.notSetUp});
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
    if (options.vad && (recognizer.endpointing === 'vad' || (replayBuffer && usingFallback) || (settings().bargeIn && (!usingFallback || (recognizer === options.fallback && options.recognizer?.endpointing === 'vad'))))) {
      try {
        await options.vad.start({
          onSpeechStart: () => {
            if (version !== sessionVersion || state !== SessionState.ACTIVE || micOff || disposed) return;
            speechSince = now();
            if (away || paused || (aiSpeaking && !canBargeIn())) return;
            recognizer.setVocabulary?.(options.vocabulary?.() || []);
            const id = recognizer.speechStart?.();
            const basic = beginBasic();
            const previous = id == null ? null : utteranceContexts.get(id);
            utterance = basic || previous || {at: speechSince, duringAi: aiSpeaking || speechSince - aiEndedAt < TAIL_MS,
              beganWhileSpeaking: aiSpeaking, speechStartAt: speechSince, id: id ?? undefined, interrupted: false};
            utterance.speechEndAt = null;
            if (id != null) { utteranceContexts.set(id, utterance); awaitingDecision.delete(id); }
            mark('voice:speech-start', {utterance: id ?? undefined, duringAi: utterance.beganWhileSpeaking});
            if (recognizer.endpointing === 'vad') options.bargeIn?.speechStart?.();
          },
          onSpeechEnd: () => {
            if (version !== sessionVersion || state !== SessionState.ACTIVE || micOff || disposed) return;
            speechSince = null;
            endBasic();
            if (utterance) utterance.speechEndAt = now();
            mark('voice:speech-end', {utterance: utterance?.id});
            const overAi = utterance?.beganWhileSpeaking && canBargeIn() && !utterance.interrupted && recognizer.endpointing === 'vad';
            if (overAi && (speechLength() < BARGE_IN_MS || utterance.id === undefined)) {
              recognizer.cancel?.(utterance.id); forgetUtterance(utterance.id);
              utterance = null;
              return;
            }
            const id = recognizer.speechEnd?.();
            if (overAi && id != null) awaitingDecision.set(id, utterance);
            if (recoveryPending) void restoreServer();
          },
        });
        if (!current()) {
          recognizer.stop();
          options.vad.stop();
          return;
        }
        bargeIn = !!settings().bargeIn;
      } catch (e) {
        options.vad.stop();
        if (!current()) {
          recognizer.stop();
          return;
        }
        console.warn('[voice] no voice activity, so no barge-in:', e);
        if (recognizer.endpointing === 'vad') {
          stopEngines(); setState(SessionState.INACTIVE);
          output.say({source: 'assistant', kind: 'error', text: SAY.notSetUp});
          return;
        }
      }
    }
    if (!current()) return;
    setState(SessionState.ACTIVE);
    if (aiSpeaking && !canBargeIn()) {
      paused = true;
      recognizer.pause();
    }
    if (recoveryPending) void restoreServer();
    void syncListener();
    // Started while focus was outside the panel: the session is on, listening waits for focus to come back.
    if (away) {
      recognizer.pause();
      void refreshWake();
    } else {
      output.cue('listeningOn');
    }
    mark('voice:listening');
    emit('session.started', {bargeIn, fallback: usingFallback});
    noteActivity();
    clearInterval(idleTimer);
    idleTimer = setInterval(checkIdle, 1000);
  }

  function stopEngines() {
    recoveryPending = false;
    cancelPending();
    clearInterval(idleTimer);
    clearTimeout(resumeTimer);
    clearTimeout(falseTimer);
    cancelQuiet?.();
    ++engineVersion;
    stopListener();
    recognizer?.stop();
    if (options.recognizer !== recognizer) options.recognizer?.stop();
    options.vad?.stop();
    bargeIn = false;
    paused = false;
    speechSince = null;
    setPartial('');
    utterance = null;
    replayBuffer?.clear();
    clearTimeout(replayTimer); replayTimer = null;
    for (const id of [...replayContexts.keys()]) dropReplayGroup(id);
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

  function disconnectRecognizers() {
    new Set([recognizer, options.recognizer, options.fallback, options.browserFallback, options.bargeIn])
        .forEach((engine) => engine?.disconnect?.());
  }

  function turnMicrophoneOff() {
    micOff = true;
    stopWake();
    if (state === SessionState.INACTIVE) stopEngines();
    else end();
    disconnectRecognizers();
    showMicrophone();
    output.say({source: 'assistant', text: SAY.micOff});
  }

  /**
   * Focus left the assistant panel (true) or came back (false). While away the session stays on and the AI voice may
   * speak, but the microphone isn't heard: the recognizer is paused and nothing reaches the draft. Only the listening
   * off and on cues mark it. The wake phrase is not affected (it listens only while no session is on).
   */
  function setAway(next) {
    next = !!next;
    if (next === away) return;
    away = next;
    if (away) cancelPending();
    void syncListener();
    showMicrophone();
    void refreshWake();
    if (state !== SessionState.ACTIVE) return;
    if (away) {
      if (!paused) recognizer.pause();
      setPartial('');
      utterance = null;
      output.cue('listeningOff');
      emit('session.away', {});
    } else {
      if (!paused) recognizer.resume();
      noteActivity();
      output.cue('listeningOn');
      emit('session.back', {});
    }
  }

  /** Nobody spoke or typed for a while (counted only while the output is silent and no task works). */
  function checkIdle() {
    if (state !== SessionState.ACTIVE) return;
    // Away from the panel the learner is working elsewhere; the conversation waits for them.
    if (output.state() !== 'silent' || isBusy() || away) {
      noteActivity();
      return;
    }
    if (speechSince !== null || paused) {
      // Someone is talking (or the microphone is held while the assistant speaks): not idle.
      if (speechSince !== null) noteActivity();
      lastReminder = now();
    } else if (now() - Math.max(lastActivity, lastReminder) >= REMINDER_MS) {
      lastReminder = now();
      output.cue('listeningReminder');
    }
    if (now() - lastActivity < IDLE_MS) return;
    output.say({source: 'assistant', text: wakeOn || settings().wakePhrase ? SAY.idleStopWake(name) : SAY.idleStop});
    end('idle');
  }

  // ---- Wake phrase -----------------------------------------------------------------------

  function otherSpeechAudible() {
    return recentNav.some((n) => n.until > now()) || (aiSpeaking && !echoCancelled());
  }

  function stopWake() {
    wakeVersion += 1;
    if (!wakeOn) return;
    wakeOn = false;
    wakeReady = false;
    options.spotter.stop();
    showMicrophone();
  }

  /** Listens for the wake phrase ("Hey Neon") when the setting is on and no session is active, or listening is paused. */
  async function refreshWake() {
    const idle = state === SessionState.INACTIVE || (state === SessionState.ACTIVE && away);
    const want = !micOff && !disposed && settings().wakePhrase && idle && !!options.spotter;
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
          if (state === SessionState.ACTIVE) {
            // Paused: navigation speech or a voice the echo canceller can't remove may say the name.
            if (otherSpeechAudible()) return;
            emit('session.wake', {paused: true});
            options.onWakePaused?.();
            return;
          }
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
      output.say({source: 'assistant', kind: 'error', text: SAY.noWake(name)});
    }
  }

  showMicrophone();

  return {
    start,
    cancelPending,
    draftEdited,
    reviseSegments,
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
        output.say({source: 'assistant', text: isWaiting() ? SAY.endedWaiting : SAY.ended});
        end('ended');
        return;
      }
      const medium = spoke ? 'voice' : 'text';
      segments.set(draft.value());
      const span = eligibleWindows()[0];
      const owner = span && replayContexts.get(span.owner);
      if (partial) segments.append(partial, owner ? {utterance: owner.id, provisional: true, covers: [...owner.covers]} : {});
      for (const context of replayContexts.values()) {
        clearTimeout(context.timer); context.closed = true; replayBuffer?.end(context.id);
      }
      basicActiveId = null;
      const sentSegments = segments.take();
      draft.set('');
      cancelPending();
      dropUtterance();
      spoke = false;
      noteActivity();
      output.cue('sent');
      mark('voice:sent');
      emit('message.submitted', {input: medium, text});
      submit(text, medium, {segments: sentSegments});
      pumpReplay();
    },
    /** Empties the draft. */
    discard() {
      segments.clear();
      draft.set('');
      cancelPending();
      dropUtterance();
      spoke = false;
    },
    /** I while the assistant speaks: stop it and listen; if nothing is said, the cut sentence plays again. */
    async talk() {
      cancelPending();
      output.interrupt();
      emit('speech.interrupted', {by: 'key'});
      heardSinceInterrupt = false;
      clearTimeout(falseTimer);
      if (state === SessionState.INACTIVE) await start();
      falseTimer = setTimeout(() => {
        if (!heardSinceInterrupt && speechSince === null && !utterance && !draft.value().trim()) output.replayInterrupted?.();
      }, FALSE_INTERRUPTION_MS);
    },
    /** Typing in the draft counts as activity for the idle timer. */
    noteActivity,
    setAway,
    isAway: () => away,
    /** The wake phrase setting changed. */
    refreshWake,
    state: () => state,
    dispose() {
      disposed = true;
      disconnectRecognizers();
      unwatch();
      unSpeak();
      unAnnounce();
      end('ended');
      stopEngines();
      stopWake();
    },
  };
}
