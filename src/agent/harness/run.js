// @ts-check
// Debug and edit: ask the model, map short ids back, check the reply in code, one repair round.

import {snapshot} from '../context/snapshot.js';
import {validatePlan} from '../editor/plan.js';
import {newRequestId} from '../model/agent_client.js';
import {workspaceVersion} from '../context/version.js';
import {getPolicy} from '../../blocks/policy.js';
import {DEBUG} from './debug.js';
import {EDIT_GUIDE} from './edit.js';
import {normalizeReply} from './normalize.js';
import {SPOKEN_WORD_LIMIT, placeProblems, speechProblems} from '../guardrails/speech.js';

export const PLAN_ACTIONS = {DEBUG, EDIT_GUIDE};

/** Parses a reply that should be one JSON object. */
export function parseJsonReply(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    const match = text.match(/\{[\s\S]*\}/);
    try {
      return match ? JSON.parse(match[0]) : null;
    } catch (e2) {
      return null;
    }
  }
}

/**
 * @param {string} task  DEBUG | EDIT_GUIDE
 * @param {!Blockly.Workspace} ws
 * @param {{cursor?: ?string, onWorkspace?: boolean, learnerSays?: string, allowedTypes?: ?Array<string>,
 *     stackLetters?: ?Map<string, string>, taskContext?: string}} options
 *     onWorkspace: the cursor is on empty workspace
 *     taskContext: the task so far, for a revision or an answer to a question asked back; a new request has none
 * @returns {{call: !Object, toReal: !Map<string, string>, toShort: !Map<string, string>}}
 */
export function buildPlanRequest(task, ws, {cursor = null, onWorkspace = false, learnerSays = '',
  allowedTypes = ws.allowedTypeCatalog || null, stackLetters = null, taskContext = ''}) {
  const view = snapshot(ws, {cursor, onWorkspace, allowedTypes, stackLetters});
  const input = taskContext ? {taskContext, program: view.text} : {program: view.text};
  return {call: {task, learnerText: learnerSays, input}, toReal: view.toReal, toShort: view.toShort};
}

/** A copy of a reply with short ids replaced by real ones. Unknown ids stay, so the checks report them. */
export function withRealIds(task, output, toReal) {
  if (!output || typeof output !== 'object') return output;
  const action = PLAN_ACTIONS[task];
  const copy = structuredClone(output);
  const real = (id) => (typeof id === 'string' && toReal.has(id) ? toReal.get(id) : id);
  const newBlock = (spec) => {
    if (!spec || typeof spec !== 'object') return;
    // A new block reusing a view id would clash; mapping it makes the check say so.
    if (typeof spec.id === 'string') spec.id = real(spec.id);
    Object.values(spec.inputs || {}).forEach(newBlock);
    newBlock(spec.next);
  };
  const refs = action.blockRefs(copy);
  if (refs) refs.splice(0, refs.length, ...refs.map(real));
  for (const step of action.steps(copy)) {
    for (const op of Array.isArray(step?.ops) ? step.ops : []) {
      if (!op || typeof op !== 'object') continue;
      for (const key of ['after', 'before', 'parent']) if (key in op) op[key] = real(op[key]);
      if (op.op === 'insert') newBlock(op.block);
      else op.block = real(op.block);
    }
  }
  return copy;
}

/** Parses, normalizes and maps a reply to real ids. */
function readReply(task, text, toReal, adjusted, normalizing = {}) {
  const normal = normalizeReply(parseJsonReply(text), toReal, PLAN_ACTIONS[task], normalizing);
  normal.adjusted.forEach((a) => adjusted.add(a));
  return withRealIds(task, normal.output, toReal);
}

/** Problems written with short ids, so the model can act on them. */
function inViewIds(problems, toShort) {
  const ids = [...toShort.keys()].sort((a, b) => b.length - a.length);
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return problems.map((p) => ids.reduce((text, id) =>
    text.replace(new RegExp(`(?<=^|[\\s(])${escape(id)}(?=$|[\\s,;:)])`, 'g'), toShort.get(id)), p));
}

/** @returns {!Array<string>} Everything wrong with a parsed reply. */
export function checkPlanReply(task, ws, output, options = {}) {
  return [...checkPlan(task, ws, output, options), ...spokenProblems(task, ws, output, options)];
}

/**
 * The speech checks on voiceLine, the only part of a reply the learner hears. An empty line is a shape problem.
 * @param {{placesOnly?: boolean}=} options  placesOnly: just the impossible places
 */
function spokenProblems(task, ws, output, {stackLetters = null, placesOnly = false} = {}) {
  const line = output?.voiceLine;
  if (typeof line !== 'string' || !line.trim()) return [];
  const ops = PLAN_ACTIONS[task].steps(output).flatMap((s) => (Array.isArray(s?.ops) ? s.ops : []));
  const newStacks = ops.filter((op) => op?.stack === 'new').length;
  return placesOnly ? placeProblems(line, ws, {stackLetters, newStacks}) :
    speechProblems(line, ws, {limit: SPOKEN_WORD_LIMIT, stackLetters, newStacks});
}

/** Problems with the reply's shape and steps, without the spoken text. */
function checkPlan(task, ws, output, {allowedTypes = ws.allowedTypeCatalog || null, version} = {}) {
  if (!output || typeof output !== 'object') return ['the reply must be one JSON object'];
  const action = PLAN_ACTIONS[task];
  const problems = action.shape(output, ws, version || action.version);
  const steps = action.steps(output);
  if (!problems.length && steps.length) {
    const check = validatePlan(ws, steps, {allowedTypes});
    check.result?.dispose();
    for (const e of check.errors) problems.push(e.step < 0 ? e.message : `step ${e.step + 1}, op ${e.op + 1}: ${e.message}`);
  }
  return problems;
}

/**
 * One call, then one repair round with the problems when the reply fails its checks.
 * A blocked or failed call gets no repair round.
 * @param {!Blockly.Workspace} ws
 * @param {!import('../model/agent_client.js').AgentClient} client
 * @param {{task: string, learnerText: string, input: !Object}} call
 * @param {function(string): *} read  reply text -> output
 * @param {function(*, !Object): !Array<string>} check  output, meta -> problems
 * @param {!Map<string, string>} toShort  so problems name blocks as the model saw them
 * @param {{signal?: AbortSignal, taskId?: ?string, revision?: ?number}=} options
 * @returns {!Promise<{output: *, problems: !Array<string>, repaired: boolean, firstProblems: !Array<string>,
 *     meta: !Object, workspaceVersion: string, blocked?: {say: string, reason: string}, error?: string}>}
 *     workspaceVersion: the program the request was built from
 */
export async function askWithRepair(ws, client, call, read, check, toShort, {signal, taskId = null, revision = null} = {}) {
  const version = workspaceVersion(ws);
  const {activity, wholePlan} = getPolicy(ws);
  const first = {requestId: newRequestId(), taskId, revision, policy: {activity, wholePlan}, ...call};
  const stopped = (r) => {
    const problems = [r.status === 'blocked' ? `blocked: ${r.reason}` : `model error: ${r.code}`];
    const result = {output: null, problems, repaired: false, firstProblems: problems, meta: r.meta || {}, workspaceVersion: version};
    return r.status === 'blocked' ? {...result, blocked: {say: r.say, reason: r.reason}} : {...result, error: r.code};
  };

  // The server reports problems only it can see (a mask id the request never had).
  const allProblems = (output, meta) => [...check(output, meta), ...(Array.isArray(meta.problems) ? meta.problems : [])];
  let reply = await client.call(first, {signal});
  if (reply.status !== 'ok') return stopped(reply);
  let output = read(reply.reply);
  let problems = allProblems(output, reply.meta || {});
  const firstProblems = problems;
  let repaired = false;
  if (problems.length) {
    repaired = true;
    reply = await client.call({...first, repair: {problems: inViewIds(problems, toShort)}}, {signal});
    if (reply.status !== 'ok') {
      client.result({requestId: first.requestId, valid: false, problems});
      return {...stopped(reply), repaired, firstProblems};
    }
    output = read(reply.reply);
    problems = allProblems(output, reply.meta || {});
  }
  client.result({requestId: first.requestId, valid: !problems.length, problems});
  return {output, problems, repaired, firstProblems, meta: reply.meta || {}, workspaceVersion: version};
}

/**
 * Runs debug or edit with one repair round. Never applies anything.
 * @param {string} task  DEBUG | EDIT_GUIDE
 * @param {!Blockly.Workspace} ws
 * @param {{client: !import('../model/agent_client.js').AgentClient, cursor?: ?string, onWorkspace?: boolean,
 *     learnerSays?: string, allowedTypes?: ?Array<string>, version?: string, stackLetters?: ?Map<string, string>}} options
 * @returns {!Promise<{output: ?Object, valid: boolean, repaired: boolean, problems: !Array<string>,
 *     firstProblems: !Array<string>, adjusted: !Array<string>, error?: string}>}
 *     adjusted: variants the harness normalized (e.g. 'place wrapper'), for the eval.
 */
export async function runPlanAction(task, ws, options) {
  const {call, toReal, toShort} = buildPlanRequest(task, ws, options);
  const adjusted = new Set();
  const placelessNewStack = !!options.onWorkspace || !ws.getTopBlocks(false).length;
  // The prompt version decides the debug severities, so the checks follow the version that answered.
  const checks = (meta) => ({...options, version: meta.promptVersion});
  const {output, problems, repaired, firstProblems, meta, blocked, error, workspaceVersion: version} = await askWithRepair(ws,
      options.client, call, (text) => readReply(task, text, toReal, adjusted, {placelessNewStack}),
      (o, m) => checkPlanReply(task, ws, o, checks(m)),
      toShort, options);
  const result = {output, valid: !problems.length, repaired, problems, firstProblems, adjusted: [...adjusted], blocked,
    error, workspaceVersion: version};
  // Never offer an unchecked change, or one introduced by a line that breaks the speech rules. A wrong place in the
  // speech alone keeps the plan.
  const places = spokenProblems(task, ws, output, {...checks(meta), placesOnly: true});
  const spoken = spokenProblems(task, ws, output, checks(meta)).filter((p) => !places.includes(p));
  if (checkPlan(task, ws, output, checks(meta)).length || spoken.length) {
    result.output = output && typeof output === 'object' ? PLAN_ACTIONS[task].withoutSteps(output) : null;
  }
  return result;
}
