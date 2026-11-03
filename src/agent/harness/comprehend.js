// @ts-check
// Comprehend reply: {voiceLine}. Speech rules are checked in code and get the repair round. A question about the
// offered change (scope "proposal") uses its own prompt with the task so far.

import {snapshot} from '../context/snapshot.js';
import {SPOKEN_WORD_LIMIT, SPOKEN_WORD_LIMIT_MORE, speechProblems} from '../guardrails/speech.js';
import {askWithRepair, parseJsonReply} from './run.js';
import {inQuestionSlot} from '../guardrails/learner_work.js';

export const SCOPES = ['field', 'block', 'statement', 'stack', 'program'];

/**
 * @param {!Blockly.Workspace} ws
 * @param {{cursor?: ?string, field?: ?string, scope?: string, learnerSays?: string, more?: boolean,
 *     stackLetters?: ?Map<string, string>, taskContext?: string}} options
 *     more: the learner asked for more detail, so the word limit is higher; taskContext: with scope "proposal"
 */
export function buildComprehendRequest(ws, {cursor = null, field = null, scope, learnerSays = '', more = false, stackLetters = null,
  taskContext = ''}) {
  const question = inQuestionSlot(cursor && ws.getBlockById(cursor));
  if (question) {
    cursor = question.id;
    field = null;
    if (!['proposal', 'stack', 'program'].includes(scope)) scope = 'block';
  }
  const view = snapshot(ws, {cursor, field, stackLetters});
  const limit = more ? SPOKEN_WORD_LIMIT_MORE : SPOKEN_WORD_LIMIT;
  if (scope === 'proposal') {
    const call = {task: 'COMPREHEND_PROPOSAL', learnerText: learnerSays, input: {wordLimit: limit, taskContext, program: view.text}};
    return {call, toShort: view.toShort, limit};
  }
  const where = scope && SCOPES.includes(scope) ? scope : field ? 'field' : cursor ? 'block' : 'program';
  const call = {task: 'COMPREHEND', learnerText: learnerSays, input: {scope: where, wordLimit: limit, program: view.text}};
  return {call, toShort: view.toShort, limit};
}

/** @returns {!Array<string>} */
export function checkComprehendReply(ws, output, limit, stackLetters = null) {
  if (!output || typeof output !== 'object') return ['the reply must be one JSON object'];
  if (typeof output.voiceLine !== 'string') return ['voiceLine must be text'];
  return speechProblems(output.voiceLine, ws, {limit, stackLetters});
}

/**
 * Explains the part at the cursor. A reply that still breaks a speech rule after the repair is returned
 * marked invalid, so the caller decides whether to speak it.
 * @param {!Blockly.Workspace} ws
 * @param {{client: !import('../model/agent_client.js').AgentClient, cursor?: ?string, field?: ?string,
 *     scope?: string, learnerSays?: string, more?: boolean, stackLetters?: ?Map<string, string>, signal?: AbortSignal,
 *     taskContext?: string}} options
 * @returns {!Promise<{output: ?Object, valid: boolean, repaired: boolean, problems: !Array<string>, firstProblems: !Array<string>,
 *     blocked?: {say: string, reason: string}, error?: string}>}
 */
export async function runComprehend(ws, options) {
  const {call, toShort, limit} = buildComprehendRequest(ws, options);
  const {output, problems, repaired, firstProblems, blocked, error, workspaceVersion} = await askWithRepair(ws, options.client, call,
      parseJsonReply, (o) => checkComprehendReply(ws, o, limit, options.stackLetters), toShort, options);
  return {output, valid: !problems.length, repaired, problems, firstProblems, blocked, error, workspaceVersion};
}
