// @ts-check
// A stack's custom name ("C Greeting": the letter is given, the name is chosen). It lives in a block's data, so it is
// saved with the program, and changes go through an undoable event, because Blockly's BlockChange doesn't undo data.

import * as Blockly from 'blockly/core';

const DATA_KEY = 'eafStackName';
export const STACK_NAME_EVENT = 'eaf_stack_name';
export const STACK_NAME_MAX = 30;

function readData(block) {
  if (!block?.data) return {};
  try {
    const parsed = JSON.parse(block.data);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    return {};
  }
}

const topOf = (block) => {
  let top = block;
  while (top.getParent()) top = top.getParent();
  return top;
};

/** The block along the stack that holds its name (the name stays with the stack when a block goes above the top). */
function holder(block) {
  for (let b = topOf(block); b; b = b.getNextBlock()) if (typeof readData(b)[DATA_KEY] === 'string') return b;
  return null;
}

/** @returns {string} The name of the stack `block` is in, or ''. */
export function stackName(block) {
  const b = block && holder(block);
  return b ? readData(b)[DATA_KEY] : '';
}

/** @returns {?string} Why a name can't be used, or null. */
export function stackNameProblem(name) {
  if (typeof name !== 'string') return 'a stack name must be text';
  if (name.trim().length > STACK_NAME_MAX) return `a stack name has at most ${STACK_NAME_MAX} characters`;
  return null;
}

/**
 * Names the stack `block` is in, as an undoable change; '' removes the name.
 * @param {!Blockly.Block} block
 * @param {string} name
 */
export function setStackName(block, name) {
  const target = holder(block) || topOf(block);
  const data = readData(target);
  const text = name.trim();
  if (text) data[DATA_KEY] = text;
  else delete data[DATA_KEY];
  const before = target.data || null;
  const after = Object.keys(data).length ? JSON.stringify(data) : null;
  if (before === after) return;
  target.data = after;
  if (Blockly.Events.isEnabled()) Blockly.Events.fire(new StackNameChange(target, before, after));
}

/** Undoable record of a stack name changing (the block's whole data before and after). */
export class StackNameChange extends Blockly.Events.BlockBase {
  /**
   * @param {!Blockly.Block=} block
   * @param {?string=} oldData
   * @param {?string=} newData
   */
  constructor(block, oldData, newData) {
    super(block);
    this.type = STACK_NAME_EVENT;
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
    const change = super.fromJson(json, workspace, event ?? new StackNameChange());
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

Blockly.registry.register(Blockly.registry.Type.EVENT, STACK_NAME_EVENT, StackNameChange, true);
