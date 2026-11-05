// @ts-check
/**
 * Run integration: what the learner is warned about on Run, and the
 * teacher's assessment of a submission (questions, then task tests).
 * Text only: the host decides where to show it and whether to speak it. The host
 * runs code; see task_tests.js for the `execute` contract.
 */

import {Activity, getPolicy} from '../policy.js';
import {getBinding} from './binding.js';
import {ANSWER_INPUT} from './model.js';
import {AnswerState, chainFrom, gapOf, isMisfit, isQuestion, stateOfAnswer} from './rules.js';
import {misfitReason} from './speech.js';
import {blockTypeName, withArticle} from '../block_names.js';
import {getTaskTests, runTests} from './task_tests.js';

/**
 * @typedef {Object} QuestionStatus
 * @property {string} gap
 * @property {string} state  One of AnswerState.
 * @property {!Object} config
 * @property {!Blockly.Block} block  The question, or the first answer block.
 * @property {!Array<!Blockly.Block>} members  Top-level answer blocks.
 */

/**
 * Status of a question block. Learners' answers replace the question, but an
 * teacher's worked answer sits in its slot: that is judged like an answer.
 * @returns {!QuestionStatus}
 */
function questionBlockStatus(block) {
  const config = block.getQuestionConfig();
  const first = block.getInputTargetBlock(ANSWER_INPUT);
  if (!first) return {gap: block.id, state: AnswerState.EMPTY, config, block, members: []};
  const members = first.outputConnection ? [first] : chainFrom(first);
  const {activity} = getPolicy(block.workspace);
  return {gap: block.id, state: stateOfAnswer(config, members, activity), config, block, members};
}

/**
 * Every question in the program, in program order (stacks top to bottom, then
 * blocks in order), whether empty or answered.
 * @param {!Blockly.Workspace} workspace
 * @returns {!Array<!QuestionStatus>}
 */
export function questionStatuses(workspace) {
  const statuses = [];
  const seen = new Set();
  for (const top of workspace.getTopBlocks(true)) {
    for (const block of top.getDescendants(true)) {
      if (block.isInsertionMarker?.()) continue;
      if (isQuestion(block)) {
        statuses.push(questionBlockStatus(block));
        continue;
      }
      const binding = getBinding(block);
      if (!binding || seen.has(binding.gap)) continue;
      seen.add(binding.gap);
      const gap = gapOf(block);
      if (gap) statuses.push({gap: gap.gap, state: gap.state, config: gap.config, block: gap.members[0] || block, members: gap.members});
    }
  }
  return statuses;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const RUN_GATE_LINES = {
  one: (place) => `Not run yet. 1 question is still empty${place ? `: ${place}` : ''}. Answer it, then run again.`,
  many: ({empty, place}) => `Not run yet. ${empty} questions are still empty${place ? `; the first is ${place}` : ''}. Answer them, then run again.`,
};

/**
 * @param {!Blockly.Workspace} workspace
 * @param {{locate?: function(!Blockly.Block): string}=} options
 * @returns {{blocked: boolean, empty: number, first: ?Blockly.Block, line: string}}
 */
export function runGate(workspace, {locate = () => ''} = {}) {
  const unanswered = questionStatuses(workspace).filter((status) => status.state === AnswerState.EMPTY);
  const empty = unanswered.length;
  if (!empty) return {blocked: false, empty: 0, first: null, line: ''};
  const first = unanswered[0].block;
  const place = locate(first).replace(/^stack (\w+), block (\d+)$/, 'block $2 of stack $1');
  const line = empty === 1 ? RUN_GATE_LINES.one(place) : RUN_GATE_LINES.many({empty, place});
  return {blocked: true, empty, first, line};
}

/**
 * The learner's misfit note in practice. Emptiness is handled by the Run gate.
 * @param {!Blockly.Workspace} workspace
 * @returns {?string} Null when there is nothing to warn about.
 */
export function learnerRunWarning(workspace) {
  const statuses = questionStatuses(workspace);
  if (getPolicy(workspace).activity === Activity.QUIZ) return null;
  const misfits = statuses.filter((s) => isMisfit(s.state)).length;
  if (misfits) {
    return `${plural(misfits, 'answer does', 'answers do')} not fit ${misfits === 1 ? 'its question' : 'their questions'} yet.`;
  }
  return null;
}

/**
 * @param {!QuestionStatus} status
 * @returns {string} e.g. "fits", "empty", "doesn't fit: got true. It needs a compare block."
 */
function statusText(status) {
  if (status.state === AnswerState.EMPTY) return 'empty';
  if (!isMisfit(status.state)) return 'fits';
  const got = status.members.length === 1 ?
    `${withArticle(blockTypeName(status.members[0].type))} block` :
    `${status.members.length} blocks`;
  return `doesn't fit: got ${got}. ${misfitReason({config: status.config, members: status.members, state: status.state})}`;
}

/**
 * The teacher's assessment of the program on the workspace (e.g. an imported
 * learner submission): every question's status, then the task tests. Tests are
 * skipped while any question is empty.
 * @param {!Blockly.Workspace} workspace
 * @param {{execute: function(!Array<string>): (!import('./task_tests.js').Execution|!Promise<!import('./task_tests.js').Execution>),
 *          locate?: function(!Blockly.Block): string}} host
 * @returns {!Promise<{lines: !Array<string>, summary: string}>}  Lines for the output panel; a short spoken summary.
 */
export async function assess(workspace, {execute, locate = () => ''}) {
  const lines = [];
  const summary = [];
  const statuses = questionStatuses(workspace);

  if (statuses.length) {
    const fits = statuses.filter((s) => s.state !== AnswerState.EMPTY && !isMisfit(s.state)).length;
    lines.push(`Questions: ${fits} of ${statuses.length} fit.`);
    summary.push(`Questions: ${fits} of ${statuses.length} fit.`);
    statuses.forEach((status, i) => {
      const where = locate(status.block);
      const name = status.config.prompt ? ` "${status.config.prompt}"` : '';
      lines.push(`  Question ${i + 1}${where ? ` (${where})` : ''}${name}: ${statusText(status)}`);
    });
  }

  const tests = getTaskTests(workspace);
  const empty = statuses.filter((s) => s.state === AnswerState.EMPTY).length;
  if (!tests.length) {
    lines.push('Tests: this task has no tests.');
  } else if (empty) {
    const text = `Tests skipped: ${plural(empty, 'question is', 'questions are')} empty.`;
    lines.push(text);
    summary.push(text);
  } else {
    const results = await runTests(tests, execute);
    const passed = results.filter((r) => r.ok).length;
    lines.push(`Tests: ${passed} of ${results.length} pass.`);
    summary.push(`Tests: ${passed} of ${results.length} pass.`);
    for (const result of results) {
      const inputs = result.test.inputs.length ? ` (inputs: ${result.test.inputs.join(', ')})` : '';
      lines.push(`  Test ${result.index}${inputs}: ${result.ok ? 'pass' : `fail. ${result.reason}`}`);
      if (!result.ok && result.lines.length) lines.push(`    Printed: ${result.lines.join(' | ')}`);
    }
  }
  return {lines, summary: summary.join(' ')};
}
