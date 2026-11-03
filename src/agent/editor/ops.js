// @ts-check
// The one op vocabulary for changing a program. Ops throw OpError with a short reason a model can act on.
//   setField   {block, field, value}            variable fields take the variable's name
//   insert     {block: NEW, ...place}           NEW = {type, id?, fields?, inputs?: {NAME: NEW}, next?: NEW}
//   move       {block: id, ...place}
//   delete     {block: id}
//   addBranch  {block: id, branch: 'elseif'|'else'}
//   nameStack  {block: id, name}                 names the stack the block is in; '' removes the name
//   place = {after: id} | {before: id} | {parent: id, input: NAME}   (a statement input: at its end)
//         | {stack: 'new', name?}                a new stack where the cursor is, else below the cursor's stack
// Each op returns the id of the block the cursor goes to after it.

import * as Blockly from 'blockly/core';
import {answerInputReason, answeringPlaceReason, isLearnerWork, learnerWorkReason, newBlockReason} from '../guardrails/learner_work.js';
import {setStackName, stackNameProblem} from '../../labels_and_comments/stack_name.js';

export const OP_NAMES = ['setField', 'insert', 'move', 'delete', 'addBranch', 'nameStack'];

export class OpError extends Error {}

/**
 * @typedef {Object} OpContext
 * @property {?Array<string>=} allowedTypes  Block types a plan may create (null: any).
 * @property {?{at?: {x: number, y: number}, near?: string}=} newStack  Where a new stack goes: the cursor's spot on
 *     empty workspace, else below the stack of the block the cursor is on, else below the last stack.
 */

function blockById(ws, id, role = 'block', ctx = {}) {
  if (typeof id !== 'string' || !id) throw new OpError(`${role} must be a block id as text, as written in the program`);
  const block = ws.getBlockById(id);
  if (block) return block;
  const removed = ctx.removed?.get(id);
  if (removed) throw new OpError(`${id} was ${removed}, so it is gone; move it out before that, or build a new block`);
  throw new OpError(`no block with id ${id}`);
}

/** Notes blocks an op removes, so a later op naming one gets a useful message. */
function noteRemoved(blocks, why, ctx) {
  if (!ctx.removed) return;
  const when = ctx.step !== undefined ? ` in step ${ctx.step + 1}` : '';
  for (const b of blocks) ctx.removed.set(b.id, `${why}${when}`);
}

function guardLearnerWork(block) {
  const reason = learnerWorkReason(block);
  if (reason) throw new OpError(reason);
}

const label = (block) => `${block.id} (${block.type})`;

function inputOf(block, name) {
  const input = typeof name === 'string' ? block.getInput(name) : null;
  if (!input?.connection) {
    const names = block.inputList.filter((i) => i.connection).map((i) => i.name);
    throw new OpError(`${label(block)} has no input ${name}; inputs: ${names.join(', ') || 'none'}`);
  }
  const reason = answerInputReason(block, input.name);
  if (reason) throw new OpError(reason);
  return input;
}

function setFieldValue(block, name, value) {
  const field = typeof name === 'string' ? block.getField(name) : null;
  if (!field) {
    const names = block.inputList.flatMap((i) => i.fieldRow).filter((f) => f.name && f.EDITABLE).map((f) => f.name);
    throw new OpError(`${label(block)} has no field ${name}; fields: ${names.join(', ') || 'none'}`);
  }
  if (value === null || value === undefined || typeof value === 'object') throw new OpError(`value for ${name} must be text or a number`);
  if (field instanceof Blockly.FieldVariable) {
    const variable = Blockly.Variables.getOrCreateVariablePackage(block.workspace, null, String(value), '');
    field.setValue(variable.getId());
    return;
  }
  field.setValue(value);
  const got = field.getValue();
  const same = field instanceof Blockly.FieldNumber ? Number(got) === Number(value) : String(got) === String(value);
  if (!same) {
    const options = field instanceof Blockly.FieldDropdown ? `; valid values: ${field.getOptions(false).map((o) => o[1]).join(', ')}` : '';
    throw new OpError(`${value} is not a valid value for ${name} on ${label(block)}${options}`);
  }
}

function checkTypes(spec, ctx) {
  if (typeof spec === 'string') {
    throw new OpError(`inputs and next take a nested new block like {"type":"text","fields":{"TEXT":"hi"}}, not an id (${spec}); ` +
      'to use a block already in the program, move it');
  }
  if (!spec || typeof spec !== 'object' || typeof spec.type !== 'string') throw new OpError('a new block needs a type');
  if (!Blockly.Blocks[spec.type]) throw new OpError(`unknown block type ${spec.type}`);
  const reason = newBlockReason(spec.type);
  if (reason) throw new OpError(reason);
  if (ctx.allowedTypes && !ctx.allowedTypes.includes(spec.type)) throw new OpError(`${spec.type} is not in the learner's toolbox`);
  for (const child of Object.values(spec.inputs || {})) checkTypes(child, ctx);
  if (spec.next) checkTypes(spec.next, ctx);
}

/** Builds a NEW block tree. Events are off while building and one create event is fired for the root, like Blockly's own paste. */
function build(ws, spec, ctx) {
  checkTypes(spec, ctx);
  const created = [];
  const make = (s) => {
    if (s.id !== undefined && (typeof s.id !== 'string' || !s.id)) throw new OpError('a new block id must be text');
    if (s.id && ws.getBlockById(s.id)) throw new OpError(`id ${s.id} is already used; give the new block another id`);
    const block = ws.newBlock(s.type, s.id || undefined);
    created.push(block);
    if (s.extraState && block.loadExtraState) block.loadExtraState(s.extraState);
    for (const [name, value] of Object.entries(s.fields || {})) setFieldValue(block, name, value);
    for (const [name, child] of Object.entries(s.inputs || {})) {
      const input = inputOf(block, name);
      const sub = make(child);
      const ok = input.type === Blockly.inputs.inputTypes.STATEMENT ?
        !!sub.previousConnection && input.connection.connect(sub.previousConnection) :
        !!sub.outputConnection && input.connection.connect(sub.outputConnection);
      if (ok === false) throw new OpError(`${sub.type} can't go in input ${name} of ${s.type}`);
    }
    if (s.next) {
      const sub = make(s.next);
      if (!block.nextConnection || !sub.previousConnection || block.nextConnection.connect(sub.previousConnection) === false) {
        throw new OpError(`${sub.type} can't follow ${s.type}`);
      }
    }
    return block;
  };

  // A variable a new block names is created along with it (undo leaves the variable, like Blockly's paste).
  let root;
  Blockly.Events.disable();
  try {
    root = make(spec);
  } catch (e) {
    for (const block of created.reverse()) if (!block.isDeadOrDying()) block.dispose(false);
    throw e;
  } finally {
    Blockly.Events.enable();
  }
  if (ws.rendered) {
    for (const block of root.getDescendants(false)) /** @type {*} */ (block).initSvg();
    /** @type {*} */ (root).render();
  }
  if (Blockly.Events.isEnabled()) Blockly.Events.fire(new (Blockly.Events.get(Blockly.Events.BLOCK_CREATE))(root));
  return root;
}

/** The last block of the statement chain starting at `block`. */
function lastInChain(block) {
  let last = block;
  while (last.getNextBlock()) last = last.getNextBlock();
  return last;
}

function connectStatement(conn, block, where) {
  if (!block.previousConnection) throw new OpError(`${label(block)} is a value block; it can't go ${where}`);
  const below = conn.targetBlock();
  below?.unplug(false);
  if (conn.connect(block.previousConnection) === false) {
    if (below) conn.connect(below.previousConnection);
    throw new OpError(`${label(block)} can't go ${where}`);
  }
  if (below) {
    const last = lastInChain(block);
    if (!last.nextConnection || last.nextConnection.connect(below.previousConnection) === false) {
      throw new OpError(`nothing can follow ${label(last)}, so it can't go ${where}`);
    }
  }
}

const STACK_GAP = 40;

/** A stack's box; a headless workspace has no sizes, so they are estimated. */
function stackBox(top) {
  if (/** @type {*} */ (top).getBoundingRectangle && top.workspace.rendered) {
    const r = /** @type {*} */ (top).getBoundingRectangle();
    return {left: r.left, top: r.top, right: r.right, bottom: r.bottom};
  }
  const xy = top.getRelativeToSurfaceXY();
  return {left: xy.x, top: xy.y, right: xy.x + 200, bottom: xy.y + 30 * top.getDescendants(false).length};
}

/** Free space for a new stack: the asked spot, moved down past any stack in the way. */
function newStackSpot(ws, block, ctx) {
  const others = ws.getTopBlocks(false).filter((t) => t !== block).map(stackBox);
  const near = ctx.newStack?.near && ws.getBlockById(ctx.newStack.near);
  let spot = ctx.newStack?.at;
  if (!spot) {
    let top = near;
    while (top?.getParent()) top = top.getParent();
    const anchor = top ? stackBox(top) : others.reduce((low, b) => (!low || b.bottom > low.bottom ? b : low), null);
    spot = anchor ? {x: anchor.left, y: anchor.bottom + STACK_GAP} : {x: STACK_GAP, y: STACK_GAP};
  }
  const own = stackBox(block);
  const width = own.right - own.left;
  const height = own.bottom - own.top;
  let {x, y} = spot;
  for (let moved = true, i = 0; moved && i <= others.length; i++) {
    moved = false;
    for (const b of others) {
      if (x < b.right && x + width > b.left && y < b.bottom && y + height > b.top) {
        y = b.bottom + STACK_GAP;
        moved = true;
      }
    }
  }
  return {x, y};
}

function startStack(ws, block, op, ctx) {
  if (op.stack !== 'new') throw new OpError('stack takes "new", to start a new stack');
  if (block.outputConnection) {
    throw new OpError(`${label(block)} is a value block; it can't start a stack, put it in an input`);
  }
  const {x, y} = newStackSpot(ws, block, ctx);
  const xy = block.getRelativeToSurfaceXY();
  block.moveBy(x - xy.x, y - xy.y);
  if (op.name !== undefined) {
    const problem = stackNameProblem(op.name);
    if (problem) throw new OpError(problem);
    setStackName(block, op.name);
  }
}

/** Puts `block` (already on the workspace, not connected) at a place. */
function place(ws, block, op, ctx) {
  const where = ['after', 'before', 'parent', 'stack'].filter((k) => op[k] !== undefined);
  if (where.length !== 1) {
    if ('place' in op) throw new OpError('write after, before, or parent with input directly in the op, not inside place');
    throw new OpError('give exactly one place: after, before, or parent with input');
  }
  if (op.name !== undefined && op.stack === undefined) throw new OpError('name goes with stack "new"; to name a stack, use nameStack');
  if (op.stack !== undefined) return startStack(ws, block, op, ctx);
  if (op.after !== undefined) {
    const anchor = blockById(ws, op.after, 'after', ctx);
    const reason = answeringPlaceReason(anchor, 'after');
    if (reason) throw new OpError(reason);
    if (!anchor.nextConnection) throw new OpError(`nothing can follow ${label(anchor)}`);
    return connectStatement(anchor.nextConnection, block, `after ${anchor.id}`);
  }
  if (op.before !== undefined) {
    const anchor = blockById(ws, op.before, 'before', ctx);
    const reason = answeringPlaceReason(anchor, 'before');
    if (reason) throw new OpError(reason);
    if (!anchor.previousConnection) throw new OpError(`${label(anchor)} is a value block; use parent and input instead`);
    const above = anchor.previousConnection.targetConnection;
    if (above) return connectStatement(above, block, `before ${anchor.id}`);
    // Before the first block of a stack: the new block becomes the stack's top.
    if (!block.nextConnection) throw new OpError(`nothing can follow ${label(block)}`);
    const xy = anchor.getRelativeToSurfaceXY();
    block.moveBy(xy.x - block.getRelativeToSurfaceXY().x, xy.y - block.getRelativeToSurfaceXY().y);
    if (lastInChain(block).nextConnection.connect(anchor.previousConnection) === false) {
      throw new OpError(`${label(anchor)} can't follow ${label(block)}`);
    }
    return;
  }
  const parent = blockById(ws, op.parent, 'parent', ctx);
  guardLearnerWork(parent);
  const input = inputOf(parent, op.input);
  if (input.type === Blockly.inputs.inputTypes.STATEMENT) {
    // Into a statement input means at its end; "before" its first block puts it first.
    const first = input.connection.targetBlock();
    const last = first && lastInChain(first);
    const reason = last ? answeringPlaceReason(last, 'after') : null;
    if (reason) throw new OpError(reason);
    if (last && !last.nextConnection) throw new OpError(`nothing can follow ${label(last)}, the last block in ${op.input} of ${parent.id}`);
    return connectStatement(last ? last.nextConnection : input.connection, block, `in ${op.input} of ${parent.id}`);
  }
  if (!block.outputConnection) throw new OpError(`${label(block)} is a statement block; it can't go in value input ${op.input}`);
  const old = input.connection.targetBlock();
  if (old) {
    guardLearnerWork(old);
    if (hasLearnerWork(old)) throw new OpError(`${old.id} holds a question or a learner's answer; it can't be replaced`);
  }
  if (old && !old.isShadow()) {
    noteRemoved(old.getDescendants(false), `replaced by the new block in ${op.input} of ${parent.id}`, ctx);
    old.dispose(false);
  }
  if (input.connection.connect(block.outputConnection) === false) {
    throw new OpError(`${label(block)} can't go in input ${op.input} of ${parent.id}`);
  }
}

/** A block and what's plugged into it, without the blocks below it (getDescendants includes those). */
function ownBlocks(block) {
  const below = new Set(block.getNextBlock()?.getDescendants(false) || []);
  return block.getDescendants(false).filter((b) => !below.has(b));
}

function hasLearnerWork(block) {
  return ownBlocks(block).some(isLearnerWork);
}

const OPS = {
  setField(ws, op, ctx) {
    const block = blockById(ws, op.block, 'block', ctx);
    guardLearnerWork(block);
    setFieldValue(block, op.field, op.value);
    return block.id;
  },

  insert(ws, op, ctx) {
    const block = build(ws, op.block, ctx);
    try {
      place(ws, block, op, ctx);
    } catch (e) {
      block.dispose(false);
      throw e;
    }
    return block.id;
  },

  move(ws, op, ctx) {
    const block = blockById(ws, op.block, 'block', ctx);
    guardLearnerWork(block);
    if (hasLearnerWork(block)) throw new OpError(`${block.id} holds a question or a learner's answer; it can't be moved`);
    for (const key of ['after', 'before', 'parent']) {
      const target = op[key] && ws.getBlockById(op[key]);
      if (target && ownBlocks(block).includes(target)) throw new OpError(`can't move ${block.id} into itself`);
    }
    block.unplug(/* healStack= */ true);
    place(ws, block, op, ctx);
    return block.id;
  },

  delete(ws, op, ctx) {
    const block = blockById(ws, op.block, 'block', ctx);
    guardLearnerWork(block);
    if (hasLearnerWork(block)) throw new OpError(`${block.id} holds a question or a learner's answer; it can't be deleted`);
    noteRemoved(ownBlocks(block), 'deleted', ctx);
    // The cursor goes to the block that takes its place, else the one before it, else its parent.
    const above = block.previousConnection?.targetBlock();
    const focus = block.getNextBlock() || (above && above.getNextBlock() === block ? above : null) || block.getParent();
    // A statement's blocks below move up; a value goes with what's plugged into it.
    block.dispose(/* healStack= */ !!block.previousConnection);
    return focus?.id ?? null;
  },

  addBranch(ws, op, ctx) {
    const block = blockById(ws, op.block, 'block', ctx);
    guardLearnerWork(block);
    if (block.type !== 'controls_if') throw new OpError(`addBranch works on if blocks; ${label(block)} is not one`);
    const state = block.saveExtraState?.() || {};
    const next = {elseIfCount: state.elseIfCount || 0, hasElse: !!state.hasElse};
    if (op.branch === 'elseif') next.elseIfCount++;
    else if (op.branch === 'else' && !next.hasElse) next.hasElse = true;
    else throw new OpError(op.branch === 'else' ? `${block.id} already has an else` : 'branch must be elseif or else');

    // Reshaping drops what's plugged in, so unplug it first and put it back by input name.
    const plugged = block.inputList.filter((i) => i.connection?.targetBlock()).map((i) => [i.name, i.connection.targetBlock()]);
    for (const [, child] of plugged) child.unplug(false);
    const before = Blockly.Events.BlockChange.getExtraBlockState_(/** @type {*} */ (block));
    block.loadExtraState(next);
    const after = Blockly.Events.BlockChange.getExtraBlockState_(/** @type {*} */ (block));
    if (Blockly.Events.isEnabled()) Blockly.Events.fire(new Blockly.Events.BlockChange(block, 'mutation', null, before, after));
    for (const [name, child] of plugged) block.getInput(name).connection.connect(child.outputConnection || child.previousConnection);
    /** @type {*} */ (block).queueRender?.();
    return block.id;
  },

  nameStack(ws, op, ctx) {
    const block = blockById(ws, op.block, 'block', ctx);
    guardLearnerWork(block);
    const problem = stackNameProblem(op.name);
    if (problem) throw new OpError(problem);
    setStackName(block, op.name);
    let top = block;
    while (top.getParent()) top = top.getParent();
    return top.id;
  },
};

/**
 * Applies one op. Throws OpError when it can't.
 * @param {!Blockly.Workspace} ws
 * @param {!Object} op
 * @param {OpContext=} ctx
 * @returns {?string} The block the cursor goes to after it.
 */
export function applyOp(ws, op, ctx = {}) {
  if (!op || typeof op !== 'object') throw new OpError('an op must be an object');
  const fn = OPS[op.op];
  if (!fn) throw new OpError(`unknown op ${op.op}; ops: ${OP_NAMES.join(', ')}`);
  return fn(ws, op, ctx);
}
