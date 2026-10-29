// @ts-check
// Question blocks and learners' answers belong to the learner; the agent never fills or changes them.

import {QUESTION_TYPE, ANSWER_INPUT} from '../../blocks/question/model.js';
import {getBinding} from '../../blocks/question/binding.js';

/** @returns {?string} Why the agent can't change this block, or null. */
export function learnerWorkReason(block) {
  if (block.type === QUESTION_TYPE) return `${block.id} is a question block; only the learner fills or changes it`;
  if (getBinding(block)) return `${block.id} is the learner's answer to a question; leave it to the learner`;
  return null;
}

/** @returns {?string} Why nothing may be put into this input, or null. */
export function answerInputReason(block, inputName) {
  return block.type === QUESTION_TYPE && inputName === ANSWER_INPUT ? `${block.id} is a question block; only the learner fills it` : null;
}

export const isLearnerWork = (block) => block.type === QUESTION_TYPE || !!getBinding(block);


/** @returns {?string} Why the agent can't create a block of this type, or null. */
export function newBlockReason(type) {
  return type === QUESTION_TYPE ? 'question blocks are made by teachers, not by the assistant' : null;
}
