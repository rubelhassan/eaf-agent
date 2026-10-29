// @ts-check
// Everything the learner hears goes through here, on one timeline: AI turns in the AI voice, navigation and
// system speech on the screen reader or the system voice, and earcons. Nothing plays over anything else.

import {createEarconPlayer} from './earcons.js';
import {splitSentences} from './sentences.js';

const PRIORITY = {stop: 1, freeze: 1, blocked: 1, question: 2, offer: 3, outcome: 3, answer: 3, error: 3,
  navigation: 4, system: 4, cue: 4, progress: 5};
const CUE_REPEAT_MS = 100;

// Blockly 11 fires change events on the next frame, then a timeout. Waiting the same way lets a connected cue
// arrive before its message plays (Speech already waited a frame before writing the live region).
const afterBlocklyEvents = (fn) => (typeof requestAnimationFrame === 'function' ?
  requestAnimationFrame(() => setTimeout(fn, 0)) : setTimeout(fn, 0));

export const DEFAULT_OUTPUT_SETTINGS = Object.freeze({
  systemOutput: 'screenReader',  // or 'systemVoice'
  systemVoice: null,             // OS voice name; null for the default
  systemRate: 1,
  aiVoice: null,
  aiRate: 1,
  cues: true,
  cueVolume: 'medium',
});

/**
 * @typedef {Object} OutputItem
 * @property {string} text
 * @property {'ai'|'navigation'|'system'} source
 * @property {string=} kind  AI: question, offer, outcome, answer, error, progress. Others: navigation, system, and the
 *     cues of the navigation lock (blocked, freeze, stop), which pause the AI voice instead of cutting it.
 * @property {?string=} taskId
 * @property {?string=} cue  An earcon played before the words.
 */

/**
 * @param {{aiVoice: !import('./voices.js').Voice, systemVoice: !import('./voices.js').Voice,
 *     liveRegion: ?Element|function(): ?Element, settings?: !Object, cues?: !Object, now?: function(): number,
 *     defer?: function(function()): void}} options
 *     cues: an earcon player (tests pass a fake); defer: when the waiting messages play
 */
export function createOutputManager({aiVoice, systemVoice, liveRegion, settings = {}, cues = createEarconPlayer(),
  now = () => Date.now(), defer = afterBlocklyEvents}) {
  let config = {...DEFAULT_OUTPUT_SETTINGS, ...settings};
  cues.setVolume(config.cueVolume);
  let epoch = 0;
  let seq = 0;
  const queue = [];
  /** @type {?{entry: !Object, abort: !AbortController, pause: boolean}} */
  let current = null;
  let lastAi = null;
  let running = false;
  let disposed = false;
  let state = 'silent';
  const listeners = new Set();
  const speakListeners = new Set();
  const announceListeners = new Set();
  /** The AI turn an interruption cut, and where, so a false interruption can play it again. */
  let lastCut = null;
  let toggle = false;
  let lastCue = {name: null, at: -Infinity};
  let lastAsked = {name: null, at: -Infinity};

  const isAi = (entry) => entry?.item.source === 'ai';
  const drop = (test) => {
    for (let i = queue.length - 1; i >= 0; i--) if (test(queue[i])) queue.splice(i, 1);
  };

  function setState(next) {
    if (next === state) return;
    state = next;
    listeners.forEach((fn) => fn(state));
  }

  function writeLive(text) {
    const el = typeof liveRegion === 'function' ? liveRegion() : liveRegion;
    if (!el) return;
    // A different invisible ending each time, so the same text is announced again.
    el.textContent = '';
    el.textContent = `${text}${toggle ? ' ' : '​'}`;
    toggle = !toggle;
  }

  async function playCue(name, signal) {
    if (!config.cues || signal.aborted) return;
    const at = now();
    // The AI turn earcon belongs to each turn; other cues repeated quickly play once.
    if (name !== 'aiTurn' && lastCue.name === name && at - lastCue.at < CUE_REPEAT_MS) return;
    lastCue = {name, at};
    await cues.play(name, {signal});
  }

  async function playAi(run) {
    const {entry, abort: {signal}} = run;
    setState('speaking');
    let cued = !!entry.resumed;
    if (!cued) {
      await playCue('aiTurn', signal);
      cued = !signal.aborted;
    }
    const sentences = splitSentences(entry.item.text);
    for (let i = entry.from; i < sentences.length; i++) {
      run.index = i;
      if (!signal.aborted) {
        if (sentences[i + 1]) aiVoice.prepare?.(sentences[i + 1], {rate: config.aiRate});
        speakListeners.forEach((fn) => fn(sentences[i]));
        await aiVoice.speak(sentences[i], {rate: config.aiRate, signal});
      }
      if (signal.aborted) {
        // Paused for a freeze cue: the interrupted sentence starts again afterwards.
        if (run.pause) queue.push({...entry, from: i, resumed: cued});
        return;
      }
    }
  }

  async function playOther(run) {
    const {entry: {item}, abort: {signal}} = run;
    const voice = config.systemOutput === 'systemVoice';
    if (item.cue) await playCue(item.cue, signal);
    if (signal.aborted || !item.text) return;
    announceListeners.forEach((fn) => fn(item.text));
    if (voice) {
      setState('announcing');
      await systemVoice.speak(item.text, {rate: config.systemRate, signal});
    } else {
      setState('silent');
      writeLive(item.text);
    }
  }

  async function run() {
    if (running) return;
    running = true;
    // Calls made meanwhile settle first: only the newest navigation is heard, and a cue joins its message.
    await new Promise((resolve) => defer(resolve));
    while (queue.length && !disposed) {
      queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      const entry = queue.shift();
      if (isAi(entry) && entry.epoch < epoch) continue;
      current = {entry, abort: new AbortController(), pause: false};
      try {
        await (isAi(entry) ? playAi(current) : playOther(current));
      } finally {
        current = null;
      }
    }
    running = false;
    setState('silent');
  }

  function interrupt() {
    epoch += 1;
    drop(isAi);
    if (isAi(current?.entry)) {
      lastCut = {entry: current.entry, from: current.index ?? current.entry.from};
      current.abort.abort();
    }
    return epoch;
  }

  function add(entry) {
    const {item} = entry;
    if (item.source === 'ai') {
      // Any item for a task replaces its waiting progress.
      drop((e) => isAi(e) && e.item.kind === 'progress' && e.item.taskId === item.taskId);
      if (isAi(current?.entry) && current.entry.item.kind === 'progress' && entry.priority <= 3) current.abort.abort();
      if (item.kind !== 'progress') lastAi = item;
      lastCut = null;
    } else if (entry.priority === 1) {
      drop((e) => !isAi(e) && e.priority === 1);
      if (isAi(current?.entry)) {
        current.pause = true;
        current.abort.abort();
      } else if (current) {
        current.abort.abort();
      }
    } else if (item.kind === 'cue') {
      const waiting = queue.find((e) => e.item.kind === 'navigation');
      if (waiting && !waiting.item.cue) {
        waiting.item.cue = item.cue;
        return;
      }
      const at = now();
      if (waiting?.item.cue === item.cue || (lastAsked.name === item.cue && at - lastAsked.at < CUE_REPEAT_MS)) return;
      lastAsked = {name: item.cue, at};
    } else if (item.kind === 'navigation') {
      drop((e) => e.item.kind === 'navigation');
      // Navigation cuts the AI voice (with the freeze on, the lock blocks navigation while it speaks).
      if (isAi(current?.entry)) interrupt();
      else if (current && current.entry.priority >= 4) current.abort.abort();
    }
    queue.push(entry);
    run();
  }

  /** @param {!OutputItem} item */
  function say(item) {
    if (disposed || !item || (!item.text && !item.cue)) return;
    const source = item.source || 'system';
    const kind = item.kind || (source === 'ai' ? 'answer' : source);
    add({item: {...item, source, kind}, priority: PRIORITY[kind] ?? 3, epoch, seq: ++seq, from: 0});
  }

  function stopAll() {
    epoch += 1;
    queue.length = 0;
    current?.abort.abort();
    aiVoice.cancel();
    systemVoice.cancel();
  }

  return {
    say,
    cue: (name) => say({source: 'system', kind: 'cue', text: '', cue: name}),
    interrupt,
    stopAll,
    /** After a false interruption: the cut turn again, from the start of the cut sentence, without its earcon. */
    replayInterrupted() {
      if (!lastCut) return false;
      const {entry, from} = lastCut;
      lastCut = null;
      add({...entry, from, resumed: true, epoch, seq: ++seq});
      return true;
    },
    /** Called with each AI sentence as it starts. @returns {function(): void} unsubscribe */
    onSpeak(fn) {
      speakListeners.add(fn);
      return () => speakListeners.delete(fn);
    },
    /** Called with each navigation or system line as it is spoken or sent to the screen reader. @returns {function(): void} */
    onAnnounce(fn) {
      announceListeners.add(fn);
      return () => announceListeners.delete(fn);
    },
    /** Replays the last AI turn (not progress) in a new epoch. */
    repeat() {
      if (!lastAi) return;
      interrupt();
      say(lastAi);
    },
    state: () => state,
    onState(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    settings: () => ({...config}),
    setSettings(partial) {
      config = {...config, ...partial};
      cues.setVolume(config.cueVolume);
    },
    dispose() {
      stopAll();
      disposed = true;
      listeners.clear();
      cues.dispose();
    },
  };
}
