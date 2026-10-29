// @ts-check
// Plan steps in plain words with structural places, for the task context. Each step is described against the
// program as it will be when that step runs (the steps are applied one by one on a copy), so a later step can
// name a block an earlier one adds.

import * as Blockly from 'blockly/core';
import {applyOp} from '../editor/ops.js';
import {cloneWorkspace} from '../editor/plan.js';
import {blockPositions} from './snapshot.js';
import {blockTypeName} from '../../blocks/block_names.js';

/** "stack A, block 4" -> "block 4 of stack A"; "inside block 3 of stack A" stays. */
const spokenPlace = (place) => place.replace(/^stack (\w+), block (\d+)$/, 'block $2 of stack $1');

/** The statement a value block sits in (or the block itself). */
function statementOf(block) {
  let b = block;
  while (b.outputConnection && b.getParent()) b = b.getParent();
  return b;
}

const LITERALS = ['math_number', 'text'];

function fieldWord(field) {
  if (field instanceof Blockly.FieldNumber) return 'number';
  if (field instanceof Blockly.FieldVariable) return 'variable';
  if (field instanceof Blockly.FieldDropdown) return field.name === 'OP' ? 'operator' : 'choice';
  return 'text';
}

function valueWords(field, value) {
  if (field instanceof Blockly.FieldNumber) return String(value);
  if (field instanceof Blockly.FieldDropdown) return String(value).toLowerCase().replace(/_/g, ' ');
  return `"${value}"`;
}

/** A new block in words: "a print block saying "Done!"", "a number block 2", "a set variable block for score". */
function newBlockWords(spec) {
  const kind = blockTypeName(spec?.type);
  const name = `${/^[aeiou]/i.test(kind) ? 'an' : 'a'} ${kind} block`;
  if (spec?.fields?.VAR) return `${name} for ${spec.fields.VAR}`;
  const fields = [spec?.fields || {}, ...Object.values(spec?.inputs || {}).map((s) => s?.fields || {})];
  const text = fields.find((f) => typeof f.TEXT === 'string' && f.TEXT.trim());
  if (text) return `${name} saying "${text.TEXT}"`;
  if (spec?.fields?.NUM !== undefined) return `${name} ${spec.fields.NUM}`;
  return name;
}

function opWords(ws, op, letters) {
  const places = blockPositions(ws, letters);
  const where = (id) => spokenPlace(places.get(id) || 'on its own');
  const named = (id) => {
    const block = ws.getBlockById(id);
    return block ? `the ${blockTypeName(block.type)} block, ${where(id)}` : 'a block';
  };
  // A top-level place is enough ("after block 4 of stack A"); a nested one needs the block's name too.
  const near = (id) => ((places.get(id) || '').startsWith('inside') ? named(id) : where(id));
  const placeWords = (o) => (o.after ? `after ${near(o.after)}` : o.before ? `before ${near(o.before)}` :
    o.parent ? `into ${named(o.parent)}` : o.stack === 'new' ? `in a new stack${o.name ? ` named "${o.name}"` : ''}` :
    'on its own');

  switch (op?.op) {
    case 'setField': {
      const block = ws.getBlockById(op.block);
      const field = block?.getField(op.field);
      if (!block || !field) return 'change a value';
      const owner = statementOf(block);
      // "the operator of the arithmetic block in the set variable block, ..."; a plain number or text needs no name.
      const of = block === owner || LITERALS.includes(block.type) ? '' : ` of the ${blockTypeName(block.type)} block`;
      return `set the ${fieldWord(field)}${of} in ${named(owner.id)}, to ${valueWords(field, op.value)}`;
    }
    case 'insert':
      return op.parent ? `put ${newBlockWords(op.block)} ${placeWords(op)}` : `add ${newBlockWords(op.block)} ${placeWords(op)}`;
    case 'move':
      return `move ${named(op.block)}, ${op.parent ? '' : 'to '}${placeWords(op)}`;
    case 'delete': {
      const block = ws.getBlockById(op.block);
      const plugged = block?.getChildren(false).some((c) => c !== block.getNextBlock() && !c.isShadow());
      return `remove ${named(op.block)}${plugged ? ', and what is plugged into it' : ''}`;
    }
    case 'addBranch':
      return `add ${op.branch === 'elseif' ? 'an else if' : 'an else'} branch to ${named(op.block)}`;
    case 'nameStack': {
      const stack = (places.get(op.block) || '').match(/stack (\w+)/)?.[0] || 'the stack';
      return op.name ? `name ${stack} "${op.name}"` : `remove the name of ${stack}`;
    }
  }
  return 'make a change';
}

/**
 * @param {!Blockly.Workspace} ws
 * @param {!Array<{title?: string, ops: !Array<!Object>}>} steps  Ops with real block ids.
 * @param {{stackLetters?: ?Map<string, string>}=} options
 * @returns {!Array<string>} One sentence per step.
 */
export function opsInWords(ws, steps, {stackLetters = null} = {}) {
  const copy = cloneWorkspace(ws);
  const ctx = {removed: new Map()};
  try {
    return steps.map((step) => {
      const parts = [];
      for (const op of Array.isArray(step?.ops) ? step.ops : []) {
        parts.push(opWords(copy, op, stackLetters));
        try {
          Blockly.Events.disable();
          applyOp(copy, op, ctx);
        } catch (e) {
          // A plan is checked before it is offered; if an op fails here, later words may name places loosely.
        } finally {
          Blockly.Events.enable();
        }
      }
      return parts.join(', then ') || 'make a change';
    });
  } finally {
    copy.dispose();
  }
}
