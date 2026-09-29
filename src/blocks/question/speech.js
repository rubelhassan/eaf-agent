/**
 * Spoken text for question placeholders and the blocks that answer them.
 * Speech-ready: no symbols or markdown, and blocks are named by what they are,
 * never by color or shape.
 */

import * as Blockly from 'blockly/core';
import {blockTypeName, joinAlternatives, valuePhrase, withArticle} from '../block_names.js';
import {Activity, LearnerLevel, getPolicy} from '../policy.js';
import {Expects} from './model.js';
import {AnswerState, Rejection, isMisfit} from './rules.js';

/** @type {!Map<string, ?Array<string>>} */
const outputCheckCache = new Map();

/**
 * @param {string} type
 * @returns {?Array<string>} The output check of a block type, or null (any / not a value block).
 */
function outputCheckOf(type) {
  if (outputCheckCache.has(type)) return outputCheckCache.get(type);
  let check = null;
  if (Blockly.Blocks[type]) {
    const scratch = new Blockly.Workspace();
    try {
      check = scratch.newBlock(type).outputConnection?.getCheck() ?? null;
    } catch (e) {
      check = null;
    } finally {
      scratch.dispose();
    }
  }
  outputCheckCache.set(type, check);
  return check;
}

/** The value phrase all types share ("a number"), or null. */
function sharedValuePhrase(types) {
  const phrases = types.map((type) => valuePhrase(outputCheckOf(type)));
  return phrases.length && phrases.every((p) => p && p === phrases[0]) ? phrases[0] : null;
}

/**
 * What the gap needs, e.g. "a true or false value, like a compare or and or block".
 * @param {!import('./model.js').QuestionConfig} config
 * @returns {string}
 */
export function needPhrase(config) {
  if (config.needLabel) return config.needLabel;
  const names = joinAlternatives(config.intendedTypes.map(blockTypeName));

  switch (config.expects) {
    case Expects.VALUE: {
      if (!names) return 'a value block';
      const phrase = sharedValuePhrase(config.intendedTypes);
      return phrase ? `${phrase}, like ${withArticle(names)} block` : `${withArticle(names)} block`;
    }
    case Expects.STATEMENT:
      return names ? `${withArticle(names)} block` : 'one statement block';
    case Expects.SEQUENCE: {
      const count = config.minBlocks > 1 ? `at least ${config.minBlocks}` : 'one or more';
      return names ? `${count} blocks using ${names}` : `${count} statement blocks`;
    }
    default:
      return 'a block';
  }
}

const isBeginner = (workspace) => getPolicy(workspace).learnerLevel === LearnerLevel.BEGINNER;

/**
 * @param {!Blockly.Block} question  An unanswered placeholder.
 * @returns {string} Spoken when the learner's cursor lands on it.
 */
export function placeholderFocusText(question) {
  const line = `Question. Needs ${needPhrase(question.getQuestionConfig())}.`;
  return isBeginner(question.workspace) ? `${line} Press Enter to open the question.` : line;
}

/**
 * Whether learners are told that an answer doesn't fit: in practice only; a quiz
 * never reveals it (the teacher sees it when assessing).
 * @param {!Blockly.Workspace} workspace
 */
export function revealsFit(workspace) {
  const {activity, teacherMode} = getPolicy(workspace);
  return !teacherMode && activity !== Activity.QUIZ;
}

/**
 * Why an answer doesn't fit its question yet, e.g. "It needs a true or false value,
 * like a compare block." Null when it fits.
 * @param {!{config: !Object, members: !Array, state: string}} gap  From rules.gapOf.
 * @returns {?string}
 */
export function misfitReason(gap) {
  if (gap.state === AnswerState.MISMATCH) return `It needs ${needPhrase(gap.config)}.`;
  if (gap.state === AnswerState.NOT_ENOUGH) {
    return `It needs at least ${gap.config.minBlocks} blocks, and has ${gap.members.length}.`;
  }
  return null;
}

/**
 * Appended to a bound answer block's normal description.
 * @param {!{config: !Object, members: !Array, state: string}} gap  From rules.gapOf.
 * @returns {string}
 */
export function answerFocusSuffix(gap, workspace) {
  let text = 'Answers a question.';
  if (revealsFit(workspace) && isMisfit(gap.state)) text += ` It does not fit yet. ${misfitReason(gap)}`;
  return isBeginner(workspace) ? `${text} Press Enter to open the question.` : text;
}

/**
 * Spoken when blocks are placed into a question.
 * @param {!Array<!Blockly.Block>} blocks  The top-level blocks placed.
 * @param {!{config: !Object, members: !Array, state: string}} gap  From rules.gapOf, after placing.
 * @param {!Blockly.Workspace} workspace
 * @returns {string}
 */
export function placedText(blocks, gap, workspace) {
  const what = blocks.length === 1 ? `${withArticle(blockTypeName(blocks[0].type))} block` : `${blocks.length} blocks`;
  if (!revealsFit(workspace) || !isMisfit(gap.state)) return `Question answered with ${what}.`;
  const help = gap.config.hints.length || gap.config.ai.level !== 'off' ? ' Press Enter on it for hints.' : '';
  return `Placed ${what}. This doesn't answer the question yet. ${misfitReason(gap)}${help}`;
}

/**
 * @param {!import('./model.js').QuestionConfig} config
 * @returns {string} Full details, spoken on Enter.
 */
export function detailsText(config) {
  const parts = ['Question.'];
  if (config.prompt) parts.push(sentence(config.prompt));
  if (config.instruction) parts.push(sentence(config.instruction));
  if (!config.prompt && !config.instruction) parts.push('No instructions yet.');
  parts.push(`It needs ${needPhrase(config)}.`);
  return parts.join(' ');
}

/**
 * @param {!import('./model.js').QuestionConfig} config
 * @param {{reason?: string}} result  From rules.evaluatePair.
 * @param {!Blockly.Workspace} workspace
 * @returns {string} Why the block cannot go there, with help for beginners.
 */
export function rejectionText(config, result, workspace) {
  if (result.reason === Rejection.ONE_BLOCK) return 'This question takes just one block.';
  if (result.reason === Rejection.NOT_A_QUESTION) return 'A question cannot answer another question.';
  if (result.reason === Rejection.LOCKED) return 'This part of the program is locked in this quiz. Answer the questions instead.';
  return `This question needs ${needPhrase(config)}.`;
}

/** Ensures the teacher's text ends like a sentence so speech pauses naturally. */
function sentence(value) {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}
