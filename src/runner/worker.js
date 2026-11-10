// @ts-check
// The runner's worker: runs one program and posts its lines, prompts and result to the page. Built as its own bundle
// (run_worker.js) by build.sh.

import {runCodeAsync} from './run_core.js';

/**
 * Answers run messages on a worker scope (or a stand-in for tests).
 * Page to worker: {type: 'run', request}, {type: 'answer', answer}.
 * Worker to page: {type: 'line', line}, {type: 'input', prompt, blockId}, {type: 'progress', at, steps}, {type: 'done', result}.
 * @param {{postMessage: function(*): void, onmessage: ?function(!{data: *}): void}} scope
 */
export function serveRuns(scope) {
  let answer = null;
  scope.onmessage = async ({data}) => {
    if (data?.type === 'answer') {
      answer?.(data.answer);
      answer = null;
      return;
    }
    if (data?.type !== 'run') return;
    const result = await runCodeAsync(data.request, {
      onLine: (line) => scope.postMessage({type: 'line', line}),
      onProgress: (progress) => scope.postMessage({type: 'progress', ...progress}),
      onInput: (prompt, blockId) => new Promise((resolve) => {
        answer = resolve;
        scope.postMessage({type: 'input', prompt, blockId});
      }),
    });
    scope.postMessage({type: 'done', result});
  };
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) serveRuns(self);
