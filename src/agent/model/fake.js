// @ts-check
// Without a network: a scripted model and a fake agent for tests, and canned replies when there is no agent server.

/**
 * A scripted model (a provider for the server core): replies in order, the last one repeating.
 * @param {!Array<string|!Object>} replies  Strings are sent as text, objects as JSON.
 * @returns {{complete: function(!Object): !Promise<!Object>, sent: !Array<!Object>}}
 */
export function createScriptedClient(replies) {
  const queue = [...replies];
  const sent = [];
  return {
    sent,
    async complete(payload) {
      sent.push(payload);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return {text: typeof next === 'string' ? next : JSON.stringify(next ?? ''), usage: {}, latencyMs: 0};
    },
  };
}

/**
 * An agent client for tests. Strings are sent as the reply text, objects as JSON, and functions get the call
 * and return a whole result (blocked, error). The last entry repeats.
 * @param {!Array<string|!Object|function(!import('./agent_client.js').AgentCall): !Object>} replies
 * @returns {!import('./agent_client.js').AgentClient & {calls: !Array<!Object>, results: !Array<!Object>}}
 */
export function createFakeAgentClient(replies) {
  const queue = [...replies];
  const calls = [];
  const results = [];
  return {
    calls,
    results,
    async call(call, {signal} = {}) {
      calls.push(call);
      if (signal?.aborted) return {requestId: call.requestId, status: 'error', code: 'ABORTED'};
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (typeof next === 'function') return {requestId: call.requestId, meta: {}, ...next(call)};
      const reply = typeof next === 'string' ? next : JSON.stringify(next ?? '');
      return {requestId: call.requestId, status: 'ok', reply, meta: {model: 'fake', promptVersion: 'fake'}};
    },
    result(r) {
      results.push(r);
    },
  };
}

const OFFLINE = {
  COMPREHEND: {voiceLine: "I'm offline right now, so I can't explain this."},
  DEBUG: {issue: null, fix: null, voiceLine: "I'm offline right now, so I can't check your program."},
  EDIT_GUIDE: {steps: [], voiceLine: "I'm offline right now, so I can't plan a change."},
  SEARCH: {blocks: [], voiceLine: "I'm offline right now, so I can't search your program."},
  HINT: {hint: 'What does this part of the program need to do?'},
};

/** Rough routing by words, so offline requests still reach each action. */
function offlineIntent(said) {
  const words = String(said).toLowerCase();
  const intent = /\b(fix|wrong|broken|bug|error|not working)\b/.test(words) ? 'DEBUG' :
    /\b(add|change|make|remove|delete|move|replace)\b/.test(words) ? 'EDIT' :
    /\b(where|find|which block)\b/.test(words) ? 'SEARCH' :
    /\b(hint|stuck)\b/.test(words) ? 'HINT' : 'COMPREHEND';
  return {intent, question: null};
}

/**
 * Canned replies with no network, for the app when the agent server doesn't answer.
 * @returns {!import('./agent_client.js').AgentClient}
 */
export function createOfflineAgentClient() {
  return {
    async call(call) {
      const reply = call.task === 'INTENT' ? offlineIntent(call.learnerText) : OFFLINE[call.task] || {};
      return {requestId: call.requestId, status: 'ok', reply: JSON.stringify(reply), meta: {model: 'offline', promptVersion: 'offline'}};
    },
    result() {},
  };
}
