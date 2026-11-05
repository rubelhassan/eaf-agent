/**
 * Question editing: opens the Edit question form for teachers, from
 * the popover's Edit button and automatically when a teacher places a new
 * question from the toolbox.
 *
 * A block taken from the toolbox is created together with a drag start (mouse)
 * or a connect (keyboard insert) in the same event batch; loading a file creates
 * blocks without either, so loads never open the form.
 */

import * as Blockly from 'blockly/core';
import {getPolicy} from '../../policy.js';
import {GENERATED_GROUP_PREFIX} from '../model.js';
import {isQuestion} from '../rules.js';
import {QuestionDialog} from './question_dialog.js';

/** @type {!WeakMap<!Object, !QuestionEditing>} */
const controllers = new WeakMap();

/** @returns {?QuestionEditing} */
export function editingFor(workspace) {
  return controllers.get(workspace) || null;
}

export class QuestionEditing {
  /** @param {!Blockly.WorkspaceSvg} workspace */
  constructor(workspace) {
    this.workspace = workspace;
    this.dialog_ = new QuestionDialog(workspace);
    /** Questions taken from the toolbox by mouse, waiting for their drop. */
    this.awaitingDrop_ = new Set();
    this.batch_ = null;
    this.listener_ = (event) => this.onEvent_(event);
  }

  /** @returns {!QuestionEditing} */
  attach() {
    controllers.set(this.workspace, this);
    this.workspace.addChangeListener(this.listener_);
    return this;
  }

  dispose() {
    this.workspace.removeChangeListener(this.listener_);
    this.dialog_.dispose();
    controllers.delete(this.workspace);
  }

  /** @returns {boolean} True when teachers may edit questions. */
  canEdit(block) {
    return isQuestion(block) && getPolicy(this.workspace).teacherMode;
  }

  /** Opens the Edit question form for a question block (teacher mode only). */
  edit(block) {
    if (this.canEdit(block)) this.dialog_.open(block);
  }

  onEvent_(event) {
    if (event.workspaceId !== this.workspace.id || !getPolicy(this.workspace).teacherMode) return;
    if (event.group?.startsWith(GENERATED_GROUP_PREFIX)) return;
    const E = Blockly.Events;
    if (event.type === E.BLOCK_DRAG && !event.isStart) {
      const dropped = (event.blocks || []).find((b) => this.awaitingDrop_.delete(b.id));
      if (dropped) this.openSoon_(dropped.id);
      return;
    }
    if (![E.BLOCK_CREATE, E.BLOCK_MOVE, E.BLOCK_DRAG].includes(event.type)) return;
    if (!this.batch_) {
      this.batch_ = {created: new Set(), placed: new Set(), dragging: new Set()};
      setTimeout(() => this.processBatch_(), 0);
    }
    if (event.type === E.BLOCK_CREATE) this.batch_.created.add(event.blockId);
    if (event.type === E.BLOCK_MOVE && event.newParentId) this.batch_.placed.add(event.blockId);
    if (event.type === E.BLOCK_DRAG && event.isStart) this.batch_.dragging.add(event.blockId);
  }

  processBatch_() {
    const {created, placed, dragging} = this.batch_;
    this.batch_ = null;
    for (const id of created) {
      if (!isQuestion(this.workspace.getBlockById(id))) continue;
      if (placed.has(id)) this.openSoon_(id);
      else if (dragging.has(id)) this.awaitingDrop_.add(id);
    }
  }

  /** After the placement settles (the gap tracker and locks run first). */
  openSoon_(id) {
    setTimeout(() => {
      const block = this.workspace.getBlockById(id);
      if (block && !this.dialog_.isOpen()) this.edit(block);
    }, 0);
  }
}
