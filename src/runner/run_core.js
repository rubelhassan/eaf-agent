// @ts-check
// Runs code from compile.js with limits. Plain JavaScript with no Blockly or DOM, so the same file runs in a browser
// worker and in Node.

/**
 * @typedef {{steps: number, computeMs: number, lines: number}} Limits
 * @typedef {{code: string, blockIds?: !Array<string>, input?: ('ask'|'list'), inputs?: !Array<string>,
 *     limits?: !Partial<Limits>, seed?: number}} RunRequest
 *     blockIds: the id table from compile.js (the code names blocks by their number in it);
 *     seed: a seeded Math.random, for runs that must repeat exactly; none means real random
 * @typedef {{text: string, blockId: ?string, step: number}} Line
 * @typedef {{status: ('finished'|'error'|'stepLimit'|'timeLimit'|'lineLimit'|'outOfInputs'|'cancelled'),
 *     lines: !Array<Line>, inputs: !Array<{prompt: string, answer: string, blockId: ?string}>,
 *     error?: {message: string, name: string, blockId: ?string}, at: ?string, steps: number, computeMs: number}} RunResult
 *     at: the block running when a run stopped or failed (null when it finished)
 * @typedef {{onLine?: function(!Line): void, onInput?: function(string, ?string): !Promise<?string>,
 *     onProgress?: function({at: ?string, steps: number}): void, signal?: AbortSignal, clock?: function(): number}} RunHost
 *     onInput: the learner's answer, or null to stop the run (an answer after an abort is ignored);
 *     onProgress: now and then, the block running; clock: milliseconds, for tests
 *
 * The limits are checked at steps, before each print and prompt, and when the program ends. A helper that loops
 * inside one step (a prime check on a huge number) can't be stopped from here: in the browser the page ends the
 * worker; in Node the runner only runs the trusted eval corpus.
 */

/** @type {!Limits} */
export const LEARNER_LIMITS = Object.freeze({steps: 1000000, computeMs: 2000, lines: 1000});
// Headless runs have no line limit of their own; every print is a step.
/** @type {!Limits} */
export const HEADLESS_LIMITS = Object.freeze({steps: 100000, computeMs: 1000, lines: Infinity});

// Reading the clock on every step would slow loops down.
const CLOCK_EVERY = 1024;

class Stop {
  constructor(status) {
    this.status = status;
  }
}

/** mulberry32: small, fast, and the same numbers on every machine. */
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Settles when the signal aborts; dispose removes the listener. */
function whenAborted(signal) {
  let dispose = () => {};
  const promise = new Promise((resolve) => {
    if (!signal) return;
    signal.addEventListener('abort', resolve, {once: true});
    dispose = () => signal.removeEventListener('abort', resolve);
  });
  return {promise, dispose};
}

const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const ABORTED = Symbol('aborted');

/** The `$run` object the code calls, and how to turn the outcome into a result. */
function createRun(request, host) {
  const limits = {...HEADLESS_LIMITS, ...request.limits};
  const clock = host.clock || (() => Date.now());
  const queue = [...(request.inputs || [])];
  const blockId = (index) => request.blockIds?.[index] ?? null;
  const state = {lines: [], inputs: [], at: null, steps: 0, waited: 0, started: clock()};
  const elapsed = () => clock() - state.started - state.waited;
  const stop = (status, at) => {
    if (at !== undefined) state.at = at;
    return new Stop(status);
  };
  const checkBudget = () => {
    if (host.signal?.aborted) throw stop('cancelled');
    if (elapsed() > limits.computeMs) throw stop('timeLimit');
  };
  const answered = (prompt, answer, id) => {
    state.inputs.push({prompt: String(prompt), answer: String(answer), blockId: id});
    return String(answer);
  };

  const listInput = (prompt, index) => {
    const id = blockId(index);
    checkBudget();
    if (!queue.length) throw stop('outOfInputs', id);
    return answered(prompt, queue.shift(), id);
  };
  const askInput = async (prompt, index) => {
    const id = blockId(index);
    checkBudget();
    const asked = clock();
    const abort = whenAborted(host.signal);
    try {
      const answering = Promise.resolve(host.onInput?.(String(prompt), id));
      // After an abort nobody waits for this answer; a late failure has nothing left to stop.
      answering.catch(() => {});
      const answer = await Promise.race([answering, abort.promise.then(() => ABORTED)]);
      // Waiting for the learner isn't running.
      state.waited += clock() - asked;
      if (answer === ABORTED || host.signal?.aborted || answer === null || answer === undefined) throw stop('cancelled', id);
      return answered(prompt, answer, id);
    } finally {
      abort.dispose();
    }
  };

  // Frozen, so nothing in the program can replace the step trap.
  const run = Object.freeze({
    step(index) {
      const id = blockId(index);
      state.at = id;
      if (++state.steps > limits.steps) throw stop('stepLimit');
      if (host.signal?.aborted) throw stop('cancelled');
      if (state.steps % CLOCK_EVERY === 0) {
        checkBudget();
        host.onProgress?.({at: id, steps: state.steps});
      }
    },
    print(value, index) {
      const id = blockId(index);
      checkBudget();
      if (state.lines.length >= limits.lines) throw stop('lineLimit', id);
      const line = {text: String(value), blockId: id, step: state.steps};
      state.lines.push(line);
      host.onLine?.(line);
    },
    input: request.input === 'ask' ? askInput : listInput,
  });

  /** @returns {!RunResult} */
  const result = (status, error = null) => ({
    status,
    lines: state.lines,
    inputs: state.inputs,
    ...(error ? {error: {message: error?.message || String(error), name: error?.name || 'Error', blockId: state.at}} : {}),
    at: status === 'finished' ? null : state.at,
    steps: state.steps,
    computeMs: elapsed(),
  });
  const ended = (e) => (e instanceof Stop ? result(e.status) : result('error', e));
  /** The program got to its end: within budget it finished. */
  const finished = () => {
    try {
      checkBudget();
      return result('finished');
    } catch (e) {
      return ended(e);
    }
  };
  const math = request.seed === undefined ? Math : Object.assign(Object.create(Math), {random: seededRandom(request.seed)});
  return {run, math, ended, finished};
}

/**
 * Runs list-input code to the end or a limit. Synchronous; for ask-input code use runCodeAsync.
 * @param {!RunRequest} request
 * @param {!RunHost=} host
 * @returns {!RunResult}
 */
export function runCode(request, host = {}) {
  const {run, math, ended, finished} = createRun({...request, input: 'list'}, host);
  try {
    if (host.signal?.aborted) throw new Stop('cancelled');
    new Function('$run', 'Math', request.code)(run, math);
  } catch (e) {
    return ended(e);
  }
  return finished();
}

/**
 * Runs code compiled with input 'ask' (or 'list'), waiting for the learner's answers.
 * @param {!RunRequest} request
 * @param {!RunHost=} host
 * @returns {!Promise<!RunResult>}
 */
export async function runCodeAsync(request, host = {}) {
  const {run, math, ended, finished} = createRun(request, host);
  try {
    if (host.signal?.aborted) throw new Stop('cancelled');
    await new AsyncFunction('$run', 'Math', request.code)(run, math);
  } catch (e) {
    return ended(e);
  }
  return finished();
}

/**
 * A result in the shape the assessment and the eval read: printed text, and flags for how it stopped.
 * @param {!RunResult} r
 * @returns {{lines: !Array<string>, error?: string, outOfInputs?: boolean, timedOut?: boolean}}
 */
export function toExecution(r) {
  const lines = r.lines.map((l) => l.text);
  if (r.status === 'error') return {lines, error: r.error?.message || 'error'};
  if (r.status === 'outOfInputs') return {lines, outOfInputs: true};
  if (['stepLimit', 'timeLimit', 'lineLimit'].includes(r.status)) return {lines, timedOut: true};
  if (r.status === 'cancelled') return {lines, error: 'The run was stopped.'};
  return {lines};
}
