/**
 * Locks for learners:
 *   - question blocks can't be moved, deleted, or copied (only answered);
 *   - in a quiz, task blocks outside question answers can't be changed.
 * Teachers get everything unlocked. Only locks this module set are undone.
 * Leaving teacher mode records the teacher's blocks as the task.
 */

import * as Blockly from 'blockly/core';
import {Activity, getPolicy, onPolicyChange} from '../policy.js';
import {isQuestion} from './rules.js';
import {isTaskBlock, markTaskBlocks} from './task.js';
import {getBinding} from './binding.js';

/** @returns {boolean} Whether a block belongs to a question's answer, including nested inputs. */
function inAnswer(block) {
  // Surround parents skip the statement neighbours that getParent also visits.
  for (let current = block; current; current = current.getSurroundParent()) {
    if (isQuestion(current) || getBinding(current)) return true;
  }
  return false;
}

/**
 * @param {?Blockly.Block} block
 * @param {'edit'|'delete'} action
 * @returns {?string} Why a learner cannot change the block in a quiz.
 */
export function quizRefusal(block, action) {
  if (!block) return null;
  const {teacherMode, activity} = getPolicy(block.workspace);
  if (teacherMode || activity !== Activity.QUIZ || inAnswer(block)) return null;
  let owner = block;
  while (owner.isShadow() && owner.getParent()) owner = owner.getParent();
  if (!isTaskBlock(owner)) return null;
  return action === 'delete' ?
    'You can not delete this block during Quiz.' :
    'You can not modify blocks other than question blocks during Quiz.';
}

export class Locks {
  /** @param {!Blockly.Workspace} workspace */
  constructor(workspace) {
    this.workspace = workspace;
    /** @type {!Set<string>} Blocks this module locked. */
    this.locked_ = new Set();
    this.scheduled_ = false;
    this.listener_ = (event) => {
      if (event.workspaceId !== workspace.id || event.isUiEvent) return;
      if (event.type === Blockly.Events.BLOCK_CREATE) this.schedule_();
    };
  }

  /** @returns {!Locks} */
  attach() {
    this.workspace.addChangeListener(this.listener_);
    this.unsubscribe_ = onPolicyChange(this.workspace, (next, previous) => {
      // What the teacher built becomes the task learners work on.
      if (previous.teacherMode && !next.teacherMode) markTaskBlocks(this.workspace);
      this.apply();
    });
    this.apply();
    return this;
  }

  dispose() {
    this.workspace.removeChangeListener(this.listener_);
    this.unsubscribe_?.();
  }

  schedule_() {
    if (this.scheduled_) return;
    this.scheduled_ = true;
    setTimeout(() => {
      this.scheduled_ = false;
      this.apply();
    }, 0);
  }

  /** Applies the locks the current policy calls for. Call after loading a task. */
  apply() {
    const {teacherMode, activity} = getPolicy(this.workspace);
    const quiz = activity === Activity.QUIZ;
    for (const block of this.workspace.getAllBlocks(false)) {
      if (block.isInsertionMarker?.()) continue;
      const question = isQuestion(block);
      const lockTask = !teacherMode && quiz && !question && !!quizRefusal(block, 'edit');
      if ((!teacherMode && question) || lockTask) this.lock_(block, {question, editable: !lockTask});
      else if (this.locked_.has(block.id)) this.unlock_(block);
    }
  }

  lock_(block, {question, editable}) {
    block.setMovable(false);
    block.setDeletable(false);
    block.setEditable(editable);
    if (question) block.contextMenu = false; // no Duplicate or Delete from the menu
    this.locked_.add(block.id);
  }

  unlock_(block) {
    block.setMovable(true);
    block.setDeletable(true);
    block.setEditable(true);
    block.contextMenu = true;
    this.locked_.delete(block.id);
  }
}
