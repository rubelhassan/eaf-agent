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

/**
 * The learner's Run warning, kept compact: empty questions first; only when none
 * are empty, answers that don't fit (practice only; a quiz never reveals fit).
 * @param {!Blockly.Workspace} workspace
 * @returns {?string} Null when there is nothing to warn about.
 */
export function learnerRunWarning(workspace) {
  const statuses = questionStatuses(workspace);
  const empty = statuses.filter((s) => s.state === AnswerState.EMPTY).length;
  if (empty) {
    return `${plural(empty, 'question block is', 'question blocks are')} not answered yet.`;
  }
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
 * @param {{execute: function(!Array<string>): !import('./task_tests.js').Execution,
 *          locate?: function(!Blockly.Block): string}} host
 * @returns {{lines: !Array<string>, summary: string}}  Lines for the output panel; a short spoken summary.
 */
export function assess(workspace, {execute, locate = () => ''}) {
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
    const results = runTests(tests, execute);
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
