// @ts-check
// Runs programs in a worker, a new one per run, so a program that never ends can't freeze the page. The page keeps
// its own compute clock and ends the worker if the program hangs where the step checks can't see it.

import {HEADLESS_LIMITS} from './run_core.js';

/** Extra time the worker gets past its compute limit before the page ends it. */
const GRACE_MS = 500;

/**
 * @param {function(): !Worker} makeWorker
 * @param {{clock?: function(): number, setTimer?: function(function(), number): *, clearTimer?: function(*): void}=} options
 * @returns {{run: function(!import('./run_core.js').RunRequest, !import('./run_core.js').RunHost=):
 *     !Promise<!import('./run_core.js').RunResult>}}
 */
export function createWorkerRunner(makeWorker, {clock = () => Date.now(), setTimer = (f, ms) => setTimeout(f, ms),
  clearTimer = (t) => clearTimeout(t)} = {}) {
  return {
    run(request, {onLine, onInput, signal} = {}) {
      return new Promise((resolve) => {
        const limits = {...HEADLESS_LIMITS, ...request.limits};
        const worker = makeWorker();
        const lines = [];
        const inputs = [];
        let at = null;
        let steps = 0;
        let used = 0;
        let since = clock();
        let timer = null;
        let waiting = false;
        let done = false;

        // A result made here, when the worker can't give one.
        const local = (status) => ({status, lines, inputs, at, steps, computeMs: used + (waiting ? 0 : clock() - since)});
        const end = (result) => {
          if (done) return;
          done = true;
          clearTimer(timer);
          worker.terminate();
          signal?.removeEventListener('abort', onAbort);
          resolve(result);
        };
        const onAbort = () => end(local('cancelled'));
        const resume = () => {
          waiting = false;
          since = clock();
          timer = setTimer(() => end(local('timeLimit')), Math.max(0, limits.computeMs + GRACE_MS - used));
        };
        // Waiting for the learner isn't running.
        const pause = () => {
          clearTimer(timer);
          used += clock() - since;
          waiting = true;
        };

        worker.onmessage = async ({data}) => {
          if (done) return;
          if (data.type === 'line') {
            lines.push(data.line);
            onLine?.(data.line);
          } else if (data.type === 'progress') {
            at = data.at;
            steps = data.steps;
          } else if (data.type === 'input') {
            pause();
            at = data.blockId;
            let answer = null;
            try {
              answer = await onInput?.(data.prompt, data.blockId);
            } catch (e) {
              // An input the page couldn't get stops the run, like a cancelled prompt.
              answer = null;
            }
            if (done) return;
            if (answer !== null && answer !== undefined) inputs.push({prompt: data.prompt, answer: String(answer), blockId: data.blockId});
            resume();
            worker.postMessage({type: 'answer', answer: answer ?? null});
          } else if (data.type === 'done') {
            end(data.result);
          }
        };
        worker.onerror = (e) => {
          e.preventDefault?.();
          end({...local('error'), error: {message: e.message || 'The program could not run.', name: 'Error', blockId: at}});
        };

        if (signal?.aborted) return end(local('cancelled'));
        signal?.addEventListener('abort', onAbort);
        worker.postMessage({type: 'run', request});
        resume();
      });
    },
  };
}
