// @ts-check
// Intent: which action a request is for, or which answer a reply picks, and how it relates to the task so far.
// Reply {intent, relation, answer, question}; the learner's words go on unchanged.

import {snapshot} from '../context/snapshot.js';
import {speechProblems} from '../guardrails/speech.js';
import {ANSWER_INPUT, QUESTION_TYPE} from '../../blocks/question/model.js';
import {getBinding} from '../../blocks/question/binding.js';
import {inQuestionSlot} from '../guardrails/learner_work.js';
import {askWithRepair, parseJsonReply} from './run.js';

export const INTENTS = ['COMPREHEND', 'DEBUG', 'EDIT', 'SEARCH', 'HINT', 'OFF_TOPIC', 'CLARIFICATION', 'ANSWER'];
/** The harness action each intent runs; off-topic and clarification are answered without one. */
export const INTENT_ACTIONS = {COMPREHEND: 'COMPREHEND', DEBUG: 'DEBUG', EDIT: 'EDIT_GUIDE', SEARCH: 'SEARCH', HINT: 'HINT'};
export const RELATIONS = ['new', 'revise', 'ask'];
export const OFF_TOPIC_REPLY = 'I can only help with your program. Do you want me to explain, change, or fix something in it?';

/** What is at the cursor, in words; a question or an answer to one matters for hints. */
function atCursor(ws, cursor) {
  const block = cursor && ws.getBlockById(cursor);
  if (!block) return 'nothing';
  if (inQuestionSlot(block)) return 'a question block';
  if (block.type === QUESTION_TYPE) return block.getInputTargetBlock(ANSWER_INPUT) ? 'a question block' : 'an empty question block';
  if (getBinding(block)) return `a ${block.type} block, the learner's answer to a question`;
  return `a ${block.type} block`;
}

/**
 * @param {!Blockly.Workspace} ws
 * @param {{cursor?: ?string, learnerSays?: string, stackLetters?: ?Map<string, string>, taskContext?: string,
 *     answers?: !Array<{name: string, does: string}>}} options
 *     taskContext: the task so far (task_context.js); answers: what the learner can answer now, with what each does.
 *     Without them the request is v2's.
 */
export function buildIntentRequest(ws, {cursor = null, learnerSays = '', stackLetters = null, taskContext = '', answers = []}) {
  const view = snapshot(ws, {cursor, stackLetters});
  const input = {atCursor: atCursor(ws, cursor), program: view.text};
  if (taskContext) input.taskContext = taskContext;
  if (answers.length) input.answers = answers.map((a) => `${a.name}: ${a.does}`);
  return {call: {task: 'INTENT', learnerText: learnerSays, input}, toShort: view.toShort};
}

/** ANSWER and the relation came with v3; other replies (v2, offline, tests) have neither. */
const isV2 = (version) => !(Number(/^v(\d+)$/.exec(version || '')?.[1]) >= 3);

/**
 * @param {{answers?: !Array<{name: string}>, taskContext?: string, taskAction?: ?string}=} given  what the request had
 * @param {string=} version  the prompt version that answered
 * @returns {!Array<string>}
 */
export function checkIntentReply(ws, output, {answers = [], taskContext = '', taskAction = null} = {}, version = undefined) {
  if (!output || typeof output !== 'object') return ['the reply must be one JSON object'];
  const intents = isV2(version) ? INTENTS.filter((i) => i !== 'ANSWER') : INTENTS;
  if (!intents.includes(output.intent)) return [`intent must be one of ${intents.join(', ')}`];
  if (isV2(version)) return output.intent === 'CLARIFICATION' ? clarificationProblems(ws, output) : [];
  if (output.intent === 'ANSWER') {
    const names = answers.map((a) => a.name);
    if (!names.length) return ['there is nothing to answer now; pick another intent'];
    if (output.answer != null && !names.includes(output.answer)) return [`answer must be one of ${names.join(', ')}, or null`];
    return [];
  }
  // Without a task the relation means nothing, so it is ignored rather than repaired.
  if (!taskContext) return output.intent === 'CLARIFICATION' ? clarificationProblems(ws, output) : [];
  const relation = output.relation ?? null;
  if (!RELATIONS.includes(relation)) return [`with a task, relation must be one of ${RELATIONS.join(', ')}`];
  if (relation === 'revise' && !['DEBUG', 'EDIT_GUIDE'].includes(taskAction)) {
    return ['revise is only for a debug or edit task; this is a new request or a question'];
  }
  return output.intent === 'CLARIFICATION' ? clarificationProblems(ws, output) : [];
}

function clarificationProblems(ws, output) {
  if (typeof output.question !== 'string') return ['with CLARIFICATION, question must be text'];
  return speechProblems(output.question, ws).map((p) => p.replace(/^voiceLine/, 'question'));
}

/**
 * @param {!Blockly.Workspace} ws
 * @param {{client: !import('../model/agent_client.js').AgentClient, cursor?: ?string, learnerSays?: string,
 *     stackLetters?: ?Map<string, string>, signal?: AbortSignal, taskContext?: string, taskAction?: ?string,
 *     answers?: !Array<{name: string, does: string}>}} options
 *     taskAction: the action of the task in taskContext, so revise can be checked
 * @returns {!Promise<{output: ?{intent: string, relation: ?string, answer: ?string, question: ?string}, action: ?string,
 *     reply: ?string,
 *     valid: boolean,
 *     repaired: boolean, problems: !Array<string>, firstProblems: !Array<string>, blocked?: {say: string, reason: string},
 *     error?: string}>}
 *     action: the harness action to run next; reply: what to say instead (off-topic, clarification)
 */
export async function runIntent(ws, options) {
  const {call, toShort} = buildIntentRequest(ws, options);
  let version;
  const {output, problems, repaired, firstProblems, blocked, error, workspaceVersion} = await askWithRepair(ws, options.client, call,
      parseJsonReply, (o, meta) => checkIntentReply(ws, o, options, (version = meta.promptVersion)), toShort, options);
  const valid = !problems.length;
  const intent = valid ? output.intent : null;
  // A v2 reply, or one without a task, has no relation: every message is new.
  const clean = valid ? {intent, relation: intent === 'ANSWER' || isV2(version) || !options.taskContext ? null : output.relation ?? null,
    answer: intent === 'ANSWER' ? output.answer ?? null : null, question: intent === 'CLARIFICATION' ? output.question : null} :
    output;
  return {
    output: clean,
    action: INTENT_ACTIONS[intent] || null,
    reply: intent === 'OFF_TOPIC' ? OFF_TOPIC_REPLY : intent === 'CLARIFICATION' ? output.question : null,
    valid, repaired, problems, firstProblems, blocked, error, workspaceVersion,
  };
}
