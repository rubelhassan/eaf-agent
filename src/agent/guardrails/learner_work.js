// @ts-check
// Question blocks and learners' answers belong to the learner; the agent never fills or changes them.

import {QUESTION_TYPE, ANSWER_INPUT, Expects} from '../../blocks/question/model.js';
import {getBinding} from '../../blocks/question/binding.js';

/** @returns {?Blockly.Block} The question enclosing a reference block, or null. */
export function inQuestionSlot(block) {
  for (let parent = block?.getSurroundParent?.(); parent; parent = parent.getSurroundParent()) {
    if (parent.type === QUESTION_TYPE) return parent;
  }
  return null;
}

function protectedBy(block) {
  for (let current = block; current; current = current.getSurroundParent()) {
    if (current.type === QUESTION_TYPE || getBinding(current)) return current;
  }
  return null;
}

/** @returns {boolean} Whether the block is a question, an answer, or enclosed by one. */
export function isLearnerWork(block) {
  return !!protectedBy(block);
}

/** @returns {?string} Why the agent can't change this block, or null. */
export function learnerWorkReason(block) {
  const owner = protectedBy(block);
  if (!owner) return null;
  if (owner === block && block.type === QUESTION_TYPE) {
    return `${block.id} is a question block; only the learner fills or changes it`;
  }
  return `${block.id} is part of the learner's answer to a question; leave it to the learner`;
}

/** @returns {?string} Why a statement placement would answer or extend a question. */
export function answeringPlaceReason(anchor, where) {
  const enclosed = learnerWorkReason(anchor);
  if (enclosed) return enclosed;
  const adjacent = where === 'after' ? anchor.getNextBlock() : anchor.getPreviousBlock();
  if (!adjacent) return null;
  const emptyQuestion = adjacent.type === QUESTION_TYPE && adjacent.previousConnection &&
    !adjacent.getInputTargetBlock(ANSWER_INPUT);
  const answer = getBinding(adjacent);
  if (emptyQuestion || answer && answer.config.expects !== Expects.VALUE) {
    return `${adjacent.id} is a question or its answer; only the learner fills or extends it`;
  }
  return null;
}

/** @returns {?string} Why nothing may be put into this input, or null. */
export function answerInputReason(block, inputName) {
  return block.type === QUESTION_TYPE && inputName === ANSWER_INPUT ? `${block.id} is a question block; only the learner fills it` : null;
}

/** @returns {?string} Why the agent can't create a block of this type, or null. */
export function newBlockReason(type) {
  return type === QUESTION_TYPE ? 'question blocks are made by teachers, not by the assistant' : null;
}
