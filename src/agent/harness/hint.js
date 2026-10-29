// @ts-check
// Hint for a question block: program view, the plugin's level and code checks plus the speech rules, one repair round.

import {snapshot} from '../context/snapshot.js';
import {speechProblems} from '../guardrails/speech.js';
import {getPolicy} from '../../blocks/policy.js';
import {blockTypeName} from '../../blocks/block_names.js';
import {checkHint, LEVEL_RULES} from '../../blocks/question/ai_hints.js';
import {getBinding} from '../../blocks/question/binding.js';
import {membersOf} from '../../blocks/question/rules.js';
import {needPhrase} from '../../blocks/question/speech.js';
import {askWithRepair, parseJsonReply} from './run.js';


/** The gap's question block, or the first block answering it, and its config. Never its reference. */
function findGap(ws, gap) {
  const question = ws.getBlockById(gap);
  if (question) return {block: question, config: /** @type {*} */ (question).getQuestionConfig()};
  const answer = membersOf(ws, gap)[0];
  if (!answer) throw new Error(`No question ${gap}`);
  return {block: answer, config: getBinding(answer).config};
}

/**
 * @param {!Blockly.Workspace} ws
 * @param {{gap: string, level: string, previousHints?: !Array<string>, stackLetters?: ?Map<string, string>}} options
 */
export function buildHintRequest(ws, {gap, level, previousHints = [], stackLetters = null}) {
  const {block, config} = findGap(ws, gap);
  const view = snapshot(ws, {cursor: block.id, stackLetters});
  const input = {
    level,
    levelRule: LEVEL_RULES[level],
    learnerLevel: getPolicy(ws).learnerLevel,
    question: config.prompt || '',
    instruction: config.instruction || '',
    needs: needPhrase(config),
    intended: config.intendedTypes.map(blockTypeName),
    earlierHints: previousHints,
    teacherNote: config.ai?.note || null,
    program: view.text,
  };
  return {call: {task: 'HINT', learnerText: '', input}, config, toShort: view.toShort};
}

/** The spoken hint after cleanup, and what is wrong with it. */
export function checkHintReply(ws, output, level, config, stackLetters = null) {
  if (!output || typeof output !== 'object' || typeof output.hint !== 'string') return {text: '', problems: ['hint must be text']};
  const result = checkHint(output.hint, level, config);
  const problems = result.ok ? [] : [result.reason];
  problems.push(...speechProblems(result.text, ws, {stackLetters}).map((p) => p.replace(/^voiceLine/, 'hint')));
  return {text: result.text, problems};
}

/**
 * @param {!Blockly.Workspace} ws
 * @param {{client: !import('../model/agent_client.js').AgentClient, gap: string, level: string,
 *     previousHints?: !Array<string>, stackLetters?: ?Map<string, string>, signal?: AbortSignal}} options
 * @returns {!Promise<{output: ?{hint: string}, valid: boolean, repaired: boolean, problems: !Array<string>,
 *     firstProblems: !Array<string>}>}  invalid: the caller uses its fallback hint
 */
export async function runHint(ws, options) {
  const {call, config, toShort} = buildHintRequest(ws, options);
  const read = (text) => {
    const output = parseJsonReply(text);
    const checked = checkHintReply(ws, output, options.level, config, options.stackLetters);
    return {output: checked.text ? {hint: checked.text} : output, problems: checked.problems};
  };
  const {output, problems, repaired, firstProblems, blocked, error, workspaceVersion} = await askWithRepair(ws, options.client,
      call, read, (r) => r.problems, toShort, options);
  return {output: output?.output ?? null, valid: !problems.length, repaired, problems, firstProblems, blocked, error, workspaceVersion};
}
