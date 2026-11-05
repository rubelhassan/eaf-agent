/**
 * Question gap rules: which blocks may answer a question, and when it counts as answered.
 *
 * A gap is either an unanswered placeholder block, or the learner blocks bound to
 * it (see binding.js). Only top-level answer blocks matter; blocks nested inside
 * an answer (e.g. the numbers in a compare block) are the learner's business.
 * Rules apply to learners only: in teacher mode, placeholders are ordinary blocks.
 *
 * Intended blocks never block an insert (decided at M4): any shape-compatible block
 * may go in, and a gap holding a block that isn't intended is MISMATCH ("doesn't fit
 * yet"). Only structural rules refuse: a question inside a question, a second block
 * in a quiz statement gap, and quiz locks.
 */

import * as Blockly from 'blockly/core';
import {Activity, getPolicy} from '../policy.js';
import {getBinding} from './binding.js';
import {ANSWER_INPUT, Expects, QUESTION_TYPE} from './model.js';

export const AnswerState = Object.freeze({
  EMPTY: 'empty',
  SATISFIED: 'satisfied',
  /** Sequence gap with fewer blocks than minBlocks. */
  NOT_ENOUGH: 'not-enough',
  /** Holds a block that is not intended, or too many blocks in a quiz. */
  MISMATCH: 'mismatch',
});

/** @returns {boolean} True for answer states that don't fit the question yet. */
export function isMisfit(state) {
  return state === AnswerState.MISMATCH || state === AnswerState.NOT_ENOUGH;
}

export const Rejection = Object.freeze({
  ONE_BLOCK: 'one-block',
  NOT_A_QUESTION: 'question-in-gap',
  /** Quiz: the connection belongs to the task and is not a question's spot. */
  LOCKED: 'locked',
});

/**
 * Set by task.js (avoids a circular import): whether a block belongs to the task.
 * @type {function(!Blockly.Block): boolean}
 */
let isTaskBlockFn = () => false;
export function setTaskBlockCheck(fn) {
  isTaskBlockFn = fn;
}

/** @returns {boolean} */
export function isQuestion(block) {
  return block?.type === QUESTION_TYPE && !block.isInsertionMarker?.();
}

/**
 * The block really attached at a connection, looking through Blockly's drag
 * preview (insertion markers are ghost copies and never part of a gap).
 * @param {!Blockly.Connection} connection
 * @returns {?Blockly.Block}
 */
function realTarget(connection) {
  let block = connection.targetBlock();
  // A statement preview sits between blocks: look past it. A value preview fills
  // an empty socket (replacements only fade the occupant), so there is nothing behind it.
  while (block?.isInsertionMarker?.()) block = block.nextConnection?.targetBlock() ?? null;
  return block;
}

/**
 * @param {?Blockly.Block} block
 * @returns {!Array<!Blockly.Block>} The block and every block after it via next connections.
 */
export function chainFrom(block) {
  const chain = [];
  for (let b = block; b; b = b.getNextBlock()) chain.push(b);
  return chain;
}

/**
 * @param {!Blockly.Workspace} workspace
 * @param {string} gap
 * @returns {!Array<!Blockly.Block>} Blocks bound to the gap, in stack order when contiguous.
 */
export function membersOf(workspace, gap) {
  const members = workspace.getAllBlocks(false)
      .filter((b) => !b.isInsertionMarker?.() && getBinding(b)?.gap === gap);
  // Order by position in the chain: a member whose predecessor is not a member comes first.
  const set = new Set(members);
  const first = members.find((b) => !set.has(b.getPreviousBlock?.() ?? b.getParent()));
  if (!first || !first.nextConnection) return members;
  const ordered = chainFrom(first).filter((b) => set.has(b));
  return ordered.length === members.length ? ordered : members;
}

/**
 * Whether a practice statement gap is open-ended: one intended block satisfies
 * it and any other statements may accompany it. Quiz statement gaps take exactly
 * one block; value and sequence gaps require every top-level block to match.
 */
function allowsExtras(config, activity) {
  return config.expects === Expects.STATEMENT && activity !== Activity.QUIZ;
}

/**
 * Decides whether blocks may enter a gap. Only structural rules refuse; whether the
 * blocks are intended is judged afterwards by stateOfAnswer.
 * @param {!import('./model.js').QuestionConfig} config
 * @param {!Array<string>} incomingTypes  Types of the blocks entering at the top level.
 * @param {!Array<string>} stayingTypes  Types of the top-level answer blocks that stay.
 * @param {string} activity  One of Activity.
 * @returns {{ok: boolean, reason?: string}}
 */
export function evaluateInsert(config, incomingTypes, stayingTypes, activity) {
  if (incomingTypes.includes(QUESTION_TYPE)) return {ok: false, reason: Rejection.NOT_A_QUESTION};
  const quizSingle = config.expects === Expects.STATEMENT && activity === Activity.QUIZ;
  if (quizSingle && stayingTypes.length + incomingTypes.length > 1) {
    return {ok: false, reason: Rejection.ONE_BLOCK};
  }
  return {ok: true};
}

/**
 * @param {!import('./model.js').QuestionConfig} config
 * @param {!Array<!Blockly.Block>} members  Top-level answer blocks.
 * @param {string} activity
 * @returns {string} One of AnswerState.
 */
export function stateOfAnswer(config, members, activity) {
  if (!members.length) return AnswerState.EMPTY;
  const intended = config.intendedTypes;
  if (intended.length) {
    const matches = (b) => intended.includes(b.type);
    const fits = allowsExtras(config, activity) ? members.some(matches) : members.every(matches);
    if (!fits) return AnswerState.MISMATCH;
  }
  if (config.expects === Expects.STATEMENT && activity === Activity.QUIZ && members.length !== 1) {
    return AnswerState.MISMATCH;
  }
  if (config.expects === Expects.SEQUENCE && members.length < config.minBlocks) {
    return AnswerState.NOT_ENOUGH;
  }
  return AnswerState.SATISFIED;
}

/**
 * @param {!Blockly.Block} block  A placeholder or a bound answer block.
 * @returns {?{gap: string, config: !Object, members: !Array<!Blockly.Block>, state: string}}
 */
export function gapOf(block) {
  const {activity} = getPolicy(block.workspace);
  if (isQuestion(block)) {
    return {gap: block.id, config: block.getQuestionConfig(), members: [], state: AnswerState.EMPTY};
  }
  const binding = getBinding(block);
  if (!binding) return null;
  const members = membersOf(block.workspace, binding.gap);
  return {gap: binding.gap, config: binding.config, members, state: stateOfAnswer(binding.config, members, activity)};
}

/**
 * The gap that attaching blocks at a connection pair would fill, replace, or join.
 * @param {!Blockly.Connection} superior  A value input or next/statement connection.
 * @param {!Blockly.Connection} inferior  An output or previous connection.
 * @returns {?{config: !Object, incoming: !Array<!Blockly.Block>, staying: !Array<!Blockly.Block>}}
 */
export function attachContext(superior, inferior) {
  const workspace = superior.getSourceBlock().workspace;
  if (getPolicy(workspace).teacherMode) return null;
  const {INPUT_VALUE, NEXT_STATEMENT, PREVIOUS_STATEMENT} = Blockly.ConnectionType;
  const occupant = realTarget(superior);
  const candidate = inferior.getSourceBlock();
  if (candidate.isInsertionMarker?.()) return null;

  // Into a question's own slot: the main way to answer it.
  const owner = superior.getSourceBlock();
  if (isQuestion(owner) && owner.getInput(ANSWER_INPUT)?.connection === superior) {
    const incoming = superior.type === INPUT_VALUE ? [candidate] : chainFrom(candidate);
    return {config: owner.getQuestionConfig(), incoming, staying: []};
  }

  if (superior.type === INPUT_VALUE) {
    if (occupant === candidate) return null;
    if (isQuestion(occupant)) return {config: occupant.getQuestionConfig(), incoming: [candidate], staying: []};
    const binding = getBinding(occupant);
    return binding ? {config: binding.config, incoming: [candidate], staying: []} : null;
  }
  if (superior.type !== NEXT_STATEMENT || inferior.type !== PREVIOUS_STATEMENT) return null;

  // (A stack dropped onto the top of a loose placeholder cannot be told apart here from
  // Blockly reattaching a displaced placeholder below a new block, so the gap tracker
  // checks that case when it fills.)
  if (occupant === candidate || isQuestion(candidate)) return null;
  const incoming = chainFrom(candidate);

  // Directly above or below an empty placeholder: fills it.
  if (isQuestion(occupant)) return {config: occupant.getQuestionConfig(), incoming, staying: []};
  if (isQuestion(owner) && superior === owner.nextConnection && !owner.getInputTargetBlock(ANSWER_INPUT)) {
    return {config: owner.getQuestionConfig(), incoming, staying: []};
  }

  // Below a statement answer block, or above the first one: joins that gap.
  const above = superior === owner.nextConnection ? getBinding(owner) : null;
  const below = occupant ? getBinding(occupant) : null;
  const binding = above || (below && !isMemberOf(occupant.getPreviousBlock(), below.gap) ? below : null);
  if (!binding || binding.config.expects === Expects.VALUE) return null;
  const staying = membersOf(workspace, binding.gap).filter((b) => !incoming.includes(b));
  return {config: binding.config, incoming, staying};
}

function isMemberOf(block, gap) {
  return !!block && getBinding(block)?.gap === gap;
}

/**
 * @param {!Blockly.Connection} a
 * @param {!Blockly.Connection} b
 * @returns {?{ok: boolean, reason?: string, config?: !Object}}
 *     The rule result, or null if the pair does not touch a gap.
 */
export function evaluatePair(a, b) {
  const superior = a.isSuperior() ? a : b;
  const inferior = superior === a ? b : a;
  if (!superior.isSuperior() || inferior.isSuperior()) return null;
  if (inferior.getSourceBlock()?.isShadow()) return null;
  const context = attachContext(superior, inferior);
  const {activity, teacherMode} = getPolicy(superior.getSourceBlock().workspace);
  if (!context) {
    // Quiz: learners may only attach to the task at a question.
    const touchesTask = [superior.getSourceBlock(), inferior.getSourceBlock()].some((b) => isTaskBlockFn(b));
    const quizLearner = !teacherMode && activity === Activity.QUIZ;
    return quizLearner && touchesTask && !inferior.getSourceBlock().isInsertionMarker?.() ?
      {ok: false, reason: Rejection.LOCKED, config: null} :
      null;
  }
  const result = evaluateInsert(
      context.config, context.incoming.map((x) => x.type), context.staying.map((x) => x.type), activity);
  return {...result, config: context.config};
}

/** Connection rule for the checker. */
export function allowsConnection(a, b) {
  const result = evaluatePair(a, b);
  return !result || result.ok;
}
