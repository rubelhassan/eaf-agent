/**
 * Binding between a question and the learner blocks that answer it.
 *
 * When a learner's block replaces a question placeholder, the question is not
 * forgotten: each answer block carries {gap, config} in its Blockly `data`
 * (namespaced JSON), so the binding survives save/load and copy/paste.
 * Changes go through an undoable custom event, because Blockly's BlockChange
 * does not undo `data`.
 */

import * as Blockly from 'blockly/core';
import {normalizeConfig} from './model.js';

const DATA_KEY = 'eafQuestion';
export const BINDING_EVENT = 'eaf_question_binding';

/**
 * @typedef {Object} Binding
 * @property {string} gap  Gap id (the id of the placeholder the answer replaced).
 * @property {!import('./model.js').QuestionConfig} config
 */

/** @returns {!Object} The block's data parsed as an object (other keys preserved). */
function readData(block) {
  if (!block?.data) return {};
  try {
    const parsed = JSON.parse(block.data);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    return {};
  }
}

/**
 * @param {?Blockly.Block} block
 * @returns {?Binding}
 */
export function getBinding(block) {
  const raw = readData(block)[DATA_KEY];
  if (!raw || typeof raw.gap !== 'string') return null;
  return {gap: raw.gap, config: normalizeConfig(raw.config)};
}

/** Serializes `binding` into the block's data string, preserving other keys. */
function dataWith(block, binding) {
  const data = readData(block);
  if (binding) data[DATA_KEY] = {gap: binding.gap, config: binding.config};
  else delete data[DATA_KEY];
  return Object.keys(data).length ? JSON.stringify(data) : null;
}

/**
 * Sets or clears a block's binding as an undoable change.
 * @param {!Blockly.Block} block
 * @param {?Binding} binding
 */
export function setBinding(block, binding) {
  const before = block.data || null;
  const after = dataWith(block, binding);
  if (before === after) return;
  block.data = after;
  if (Blockly.Events.isEnabled()) {
    Blockly.Events.fire(new BindingChange(block, before, after));
  }
}

/** Undoable record of a block's data changing because of a question binding. */
export class BindingChange extends Blockly.Events.BlockBase {
  /**
   * @param {!Blockly.Block=} block
   * @param {?string=} oldData
   * @param {?string=} newData
   */
  constructor(block, oldData, newData) {
    super(block);
    this.type = BINDING_EVENT;
    this.oldData = oldData ?? null;
    this.newData = newData ?? null;
  }

  toJson() {
    const json = super.toJson();
    json.oldData = this.oldData;
    json.newData = this.newData;
    return json;
  }

  static fromJson(json, workspace, event) {
    const change = super.fromJson(json, workspace, event ?? new BindingChange());
    change.oldData = json.oldData ?? null;
    change.newData = json.newData ?? null;
    return change;
  }

  isNull() {
    return this.oldData === this.newData;
  }

  run(forward) {
    const block = this.getEventWorkspace_().getBlockById(this.blockId);
    if (block) block.data = forward ? this.newData : this.oldData;
  }
}

/** Registers the event class so undo/redo and JSON event round-trips work. Idempotent. */
export function registerBindingEvent() {
  Blockly.registry.register(Blockly.registry.Type.EVENT, BINDING_EVENT, BindingChange, true);
}
