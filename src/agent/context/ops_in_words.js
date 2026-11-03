// @ts-check
// Plan steps in plain words with structural places, for the task context. Each step is described against the
// program as it will be when that step runs (the steps are applied one by one on a copy), so a later step can
// name a block an earlier one adds.

import * as Blockly from 'blockly/core';
import {applyOp} from '../editor/ops.js';
import {cloneWorkspace} from '../editor/plan.js';
import {blockPositions} from './snapshot.js';
import {blockName} from '../../blocks/block_names.js';

/** "stack A, block 4" -> "block 4 of stack A"; "inside block 3 of stack A" stays. */
const spokenPlace = (place) => place.replace(/^stack (\w+), block (\d+)$/, 'block $2 of stack $1');

/** The statement a value block sits in (or the block itself). */
function statementOf(block) {
  let b = block;
  while (b.outputConnection && b.getParent()) b = b.getParent();
  return b;
}

const LITERALS = ['math_number', 'text'];
const PROGRAM_WORD_LIMIT = 15;

/** Program content is read as written; shorten only the spoken copy. */
function programWords(value) {
  const text = String(value);
  const words = [...text.matchAll(/\S+/g)];
  if (words.length <= PROGRAM_WORD_LIMIT) return text;
  const last = words[PROGRAM_WORD_LIMIT - 1];
  return `${text.slice(0, last.index + last[0].length)} and ${words.length - PROGRAM_WORD_LIMIT} more words`;
}

export function fieldWord(field) {
  if (field instanceof Blockly.FieldNumber) return 'number';
  if (field instanceof Blockly.FieldVariable) return 'variable';
  if (field instanceof Blockly.FieldDropdown) return field.name === 'OP' ? 'operator' : 'choice';
  return 'text';
}

export function valueWords(field, value) {
  if (field instanceof Blockly.FieldNumber) return String(value);
  if (field instanceof Blockly.FieldVariable) return `"${programWords(value)}"`;
  if (field instanceof Blockly.FieldDropdown) return String(value).toLowerCase().replace(/_/g, ' ');
  return `"${programWords(value)}"`;
}

function newBlockShape(ws, spec) {
  let block;
  Blockly.Events.disable();
  try {
    block = ws.newBlock(spec.type);
    if (spec.extraState && block.loadExtraState) block.loadExtraState(spec.extraState);
    const statements = block.inputList.filter((input) => input.type === Blockly.inputs.inputTypes.STATEMENT)
        .map((input) => input.name);
    const kind = blockName(block);
    return {statements, kind};
  } finally {
    block?.dispose(false);
    Blockly.Events.enable();
  }
}

/** A new block's kind, signature and whether its statement parts are empty. */
function newBlockWords(ws, spec) {
  const {statements, kind: base} = newBlockShape(ws, spec);
  const empty = statements.length && !statements.some((name) => spec.inputs?.[name]);
  let kind = base;
  if (spec.inputs?.TIMES?.fields?.NUM !== undefined) kind = `repeat ${spec.inputs.TIMES.fields.NUM} times`;
  const condition = spec.inputs?.IF0 || spec.inputs?.BOOL;
  if (condition?.type === 'logic_boolean') kind += ` ${String(condition.fields?.BOOL ?? 'TRUE').toLowerCase()}`;
  const name = empty ? `an empty ${kind} block` : `${/^[aeiou]/i.test(kind) ? 'an' : 'a'} ${kind} block`;
  if (spec?.fields?.VAR) return `${name} for "${programWords(spec.fields.VAR)}"`;
  const fields = [spec?.fields || {}, ...Object.entries(spec?.inputs || {}).filter(([name]) => !statements.includes(name))
      .map(([, child]) => child?.fields || {})];
  const text = fields.find((f) => typeof f.TEXT === 'string' && f.TEXT.trim());
  if (text) return `${name} saying "${programWords(text.TEXT)}"`;
  if (spec?.fields?.NUM !== undefined) return `${name} ${spec.fields.NUM}`;
  return name;
}

function inputPart(parent, name) {
  const input = parent.getInput(name);
  if (input?.type === Blockly.inputs.inputTypes.STATEMENT) {
    if (name === 'ELSE') return 'else part';
    if (/^DO[1-9]\d*$/.test(name)) return 'else if part';
    if (['DO', 'DO0', 'STACK'].includes(name)) return 'do part';
  }
  const composite = parent.inputList.some((entry) => entry.type === Blockly.inputs.inputTypes.STATEMENT);
  if (composite && (/^IF\d*$/.test(name) || name === 'BOOL')) return 'condition';
  if (composite && name === 'TIMES') return 'times';
  return String(name).toLowerCase();
}

function opWords(ws, op, letters) {
  const places = blockPositions(ws, letters);
  const mentioned = new Map();
  const inline = new Set();
  const where = (id) => spokenPlace(places.get(id) || 'on its own');
  const named = (id) => {
    const block = ws.getBlockById(id);
    if (!block) return 'a block';
    mentioned.set(id, where(id));
    return `the ${blockName(block)} block`;
  };
  // A top-level place is enough ("after block 4 of stack A"); a nested one needs the block's name too.
  const near = (id) => {
    inline.add(id);
    return (places.get(id) || '').startsWith('inside') ? `${named(id)}, ${where(id)}` : where(id);
  };
  const placeWords = (o) => (o.after ? `after ${near(o.after)}` : o.before ? `before ${near(o.before)}` :
    o.parent ? `into the ${inputPart(ws.getBlockById(o.parent), o.input)} of ${named(o.parent)}` :
    o.stack === 'new' ? `in a new stack${o.name ? ` named "${programWords(o.name)}"` : ''}` :
    'on its own');

  let action;
  switch (op?.op) {
    case 'setField': {
      const block = ws.getBlockById(op.block);
      const field = block?.getField(op.field);
      if (!block || !field) {
        action = 'Change a value.';
        break;
      }
      const owner = statementOf(block);
      // "the operator of the arithmetic block in the set variable block, ..."; a plain number or text needs no name.
      const of = block === owner || LITERALS.includes(block.type) ? '' : ` of the ${blockName(block)} block`;
      action = `Change the ${fieldWord(field)}${of} in ${named(owner.id)} to ${valueWords(field, op.value)}.`;
      break;
    }
    case 'insert':
      action = `${op.parent ? 'Put' : 'Add'} ${newBlockWords(ws, op.block)} ${placeWords(op)}.`;
      break;
    case 'move':
      action = `Move ${named(op.block)} ${placeWords(op)}.`;
      break;
    case 'delete': {
      const block = ws.getBlockById(op.block);
      const plugged = block?.getChildren(false).some((c) => c !== block.getNextBlock() && !c.isShadow());
      action = `Remove ${named(op.block)}${plugged ? ', and what is plugged into it' : ''}.`;
      break;
    }
    case 'addBranch':
      action = `Add ${op.branch === 'elseif' ? 'an else if' : 'an else'} branch to ${named(op.block)}.`;
      break;
    case 'nameStack': {
      const stack = (places.get(op.block) || '').match(/stack (\w+)/)?.[0] || 'the stack';
      action = op.name ? `Name ${stack} "${programWords(op.name)}".` : `Remove the name of ${stack}.`;
      break;
    }
    default:
      action = 'Make a change.';
  }
  return {action, mentioned, inline};
}

/**
 * @param {!Blockly.Workspace} ws
 * @param {!Array<{title?: string, ops: !Array<!Object>}>} steps  Ops with real block ids.
 * @param {{stackLetters?: ?Map<string, string>}=} options
 * @returns {!Array<string>} Full sentences per step, with each block's place said once per call.
 */
export function opsInWords(ws, steps, {stackLetters = null} = {}) {
  const copy = cloneWorkspace(ws);
  const ctx = {removed: new Map()};
  const said = new Set();
  try {
    return steps.map((step) => {
      const parts = [];
      const mentioned = new Map();
      for (const op of Array.isArray(step?.ops) ? step.ops : []) {
        const words = opWords(copy, op, stackLetters);
        parts.push(words.action);
        for (const [id, place] of words.mentioned) if (!mentioned.has(id)) mentioned.set(id, place);
        for (const id of words.inline) said.add(id);
        try {
          Blockly.Events.disable();
          applyOp(copy, op, ctx);
        } catch (e) {
          // A plan is checked before it is offered; if an op fails here, later words may name places loosely.
        } finally {
          Blockly.Events.enable();
        }
      }
      const locations = new Set();
      for (const [id, place] of mentioned) {
        if (!said.has(id)) locations.add(place);
        said.add(id);
      }
      parts.push(...[...locations].map((place) => `It's ${place}.`));
      return parts.join(' ') || 'Make a change.';
    });
  } finally {
    copy.dispose();
  }
}
