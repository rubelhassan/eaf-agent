// @ts-check
// What the harness needs from the agent server. The server client (server_client.js) and the fakes implement it.
// Prompts, models and inference settings stay on the other side of this line, in server/.

/**
 * @typedef {'INTENT'|'COMPREHEND'|'COMPREHEND_PROPOSAL'|'DEBUG'|'EDIT_GUIDE'|'SEARCH'|'HINT'} AgentTask
 */

/**
 * One model call. The server client adds the session before sending.
 * @typedef {Object} AgentCall
 * @property {string} requestId  Same id on the repair round.
 * @property {AgentTask} task
 * @property {string} learnerText
 * @property {!Object} input  The task's input parts, e.g. {program, atCursor} for INTENT.
 * @property {?string=} taskId
 * @property {?number=} revision
 * @property {{activity: string, wholePlan: boolean}=} policy
 * @property {?{problems: !Array<string>}=} repair  Problems named with the view's short ids.
 */

/**
 * @typedef {Object} AgentMeta
 * @property {string=} model
 * @property {string=} promptVersion
 * @property {boolean=} cached
 * @property {number=} latencyMs
 * @property {{input?: number, output?: number, reasoning?: number}=} tokens
 * @property {number=} costUsd
 */

/**
 * @typedef {Object} AgentResult
 * @property {string} requestId
 * @property {'ok'|'blocked'|'error'} status
 * @property {string=} reply  ok: the model's text.
 * @property {string=} say  blocked: what to tell the learner; no model was called.
 * @property {string=} reason  blocked: distress | policy.
 * @property {string=} code  error: TIMEOUT | ABORTED | MODEL | INVALID_ENVELOPE | LIMIT.
 * @property {string=} message  error: details for logs, never spoken.
 * @property {!AgentMeta=} meta
 */

/**
 * @typedef {Object} AgentClient
 * @property {function(!AgentCall, {signal?: AbortSignal}=): !Promise<!AgentResult>} call
 * @property {function({requestId: string, valid: boolean, problems: !Array<string>}): void} result
 *     After the browser checked the final reply; only valid replies may be cached.
 */

let counter = 0;

/** A request id unique within the page. */
export function newRequestId() {
  counter += 1;
  return `r_${Date.now().toString(36)}_${counter}`;
}
