/**
 * Hidden reference answer of a question: the blocks that correctly fill it, kept
 * as Blockly JSON block state in the question's config. Learners never see it.
 * While the teacher edits the task, the answer is built in the question's slot; exporting a task
 * moves it into the hidden reference.
 */

import * as Blockly from 'blockly/core';
import {ANSWER_INPUT} from './model.js';
import {updateQuestionConfig} from './definition.js';

/** @returns {?Object} The question's hidden reference (block state), or null. */
export function referenceOf(question) {
  return question.getQuestionConfig().reference;
}

/** @returns {boolean} True if the question has a hidden reference or a filled slot. */
export function hasReference(question) {
  return !!referenceOf(question) || !!question.getInputTargetBlock(ANSWER_INPUT);
}

/**
 * Moves the slot's blocks into the hidden reference (no events: used on export copies).
 * @returns {boolean} False if the slot was empty.
 */
export function slotToReference(question) {
  const first = question.getInputTargetBlock(ANSWER_INPUT);
  if (!first) return false;
  const reference = Blockly.serialization.blocks.save(first, {addCoordinates: false});
  question.setQuestionConfig({...question.getQuestionConfig(), reference});
  first.dispose(/* healStack= */ false);
  return true;
}

/**
 * Puts the hidden reference back into the empty slot so the teacher can edit it,
 * and clears the hidden copy. Call inside an event group to make it one undo step.
 * @returns {boolean} False if there is no reference or the slot is taken.
 */
export function referenceToSlot(question) {
  const reference = referenceOf(question);
  const slot = question.getInput(ANSWER_INPUT)?.connection;
  if (!reference || !slot || slot.isConnected()) return false;
  // Blockly gives fresh ids where the saved ones are taken.
  const first = Blockly.serialization.blocks.append(reference, question.workspace);
  slot.connect(first.outputConnection || first.previousConnection);
  updateQuestionConfig(question, {reference: null});
  return true;
}
