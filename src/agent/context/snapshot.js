// @ts-check
// Program view for the model: short ids (b1..), stack letters, block numbers. Hidden references are never shown.

import * as Blockly from 'blockly/core';
import {ANSWER_INPUT, QUESTION_TYPE} from '../../blocks/question/model.js';
import {getBinding} from '../../blocks/question/binding.js';
import {inQuestionSlot} from '../guardrails/learner_work.js';
import {stackName} from '../../labels_and_comments/stack_name.js';

const STATEMENT = () => Blockly.inputs.inputTypes.STATEMENT;

function fieldText(field) {
  if (field instanceof Blockly.FieldVariable) return field.getVariable()?.name ?? '';
  const value = field.getValue();
  if (field instanceof Blockly.FieldNumber || typeof value === 'number') return String(value);
  if (field instanceof Blockly.FieldDropdown || field instanceof Blockly.FieldCheckbox) return String(value);
  return JSON.stringify(String(value ?? ''));
}

function fields(block) {
  return block.inputList.flatMap((i) => i.fieldRow).filter((f) => f.name && f.EDITABLE).map((f) => `${f.name}=${fieldText(f)}`);
}

// What the gap is for and what kind fits; never its reference or intended blocks.
const NEEDS = {value: 'a value block', statement: 'one statement block', sequence: 'one or more statement blocks'};
const gap = (config) => `${config.prompt ? `${JSON.stringify(config.prompt)}, ` : ''}needs ${NEEDS[config.expects] || 'a block'}`;

function notes(block) {
  const out = [];
  const binding = getBinding(block);
  if (binding) out.push(`(learner's answer to a question: ${gap(binding.config)})`);
  if (!block.isEnabled()) out.push('(disabled)');
  return out;
}

/** Procedure parameters on definitions, and the called name on calls (both live outside fields). */
function procedure(block) {
  const b = /** @type {*} */ (block);
  if (typeof b.getProcedureCall === 'function') return {head: [`CALLS=${b.getProcedureCall()}`], args: b.getVars?.() || []};
  if (typeof b.getProcedureDef === 'function') return {head: [`PARAMS=(${(b.getVars?.() || []).join(', ')})`], args: []};
  return {head: [], args: []};
}

/** One block on one line; value inputs nested in parentheses. */
function inline(block, id) {
  if (block.type === QUESTION_TYPE) {
    const config = /** @type {*} */ (block).getQuestionConfig?.();
    const empty = block.getInputTargetBlock(ANSWER_INPUT) ? '' : 'empty, ';
    return `[${id(block)}] question (${empty}for the learner to answer${config ? `: ${gap(config)}` : ''})`;
  }
  const head = `[${id(block)}]`;
  const proc = procedure(block);
  const values = block.inputList
      .filter((i) => i.connection && i.type !== STATEMENT())
      .map((i) => {
        const child = i.connection.targetBlock();
        const arg = proc.args[Number(i.name.match(/^ARG(\d+)$/)?.[1])];
        return `${i.name}${arg ? ` ${arg}` : ''}=(${child ? inline(child, id) : ''})`;
      });
  return [head, block.type, ...fields(block), ...proc.head, ...values, ...notes(block)].join(' ');
}

/** A, B, ... Z, AA, AB, ... as the stack label manager counts. */
function letterAt(index) {
  let label = '';
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) label = String.fromCharCode(65 + (n % 26)) + label;
  return label;
}

/**
 * Stack letters as the app shows them (its stack label manager's map, passed in
 * so this stays headless), or by position when there are none. A stack the app
 * hasn't labelled yet gets the first free letter, as the manager will give it.
 */
function stackLetters(tops, shown) {
  const letters = new Map();
  if (!shown) {
    tops.forEach((top, i) => letters.set(top.id, String.fromCharCode(65 + (i % 26))));
    return letters;
  }
  const used = new Set(tops.map((top) => shown.get(top.id)).filter(Boolean));
  let next = 0;
  for (const top of tops) {
    let letter = shown.get(top.id);
    if (!letter) {
      while (used.has(letterAt(next))) next++;
      letter = letterAt(next);
      used.add(letter);
    }
    letters.set(top.id, letter);
  }
  return letters;
}

/** The letters the next `count` new stacks will get. */
export function newStackLetters(ws, shownLetters = null, count = 1) {
  const tops = ws.getTopBlocks(true);
  const used = new Set(stackLetters(tops, shownLetters).values());
  const letters = [];
  for (let i = shownLetters ? 0 : tops.length; letters.length < count; i++) {
    const letter = shownLetters ? letterAt(i) : String.fromCharCode(65 + (i % 26));
    if (!used.has(letter)) letters.push(letter);
  }
  return letters;
}

/** How many blocks each stack has along it, by letter. */
export function stackSizes(ws, shownLetters = null) {
  const tops = ws.getTopBlocks(true);
  const letters = stackLetters(tops, shownLetters);
  const sizes = new Map();
  for (const top of tops) {
    let n = 0;
    for (let b = top; b; b = b.getNextBlock()) n++;
    sizes.set(letters.get(top.id), n);
  }
  return sizes;
}

/**
 * Where each block is, in the words learners hear: "stack A, block 2" or
 * "inside block 3 of stack A" (only blocks along a stack are numbered).
 * @param {!Blockly.Workspace} ws
 * @param {?Map<string, string>=} shownLetters  top block id -> letter, from the app's labels
 * @returns {!Map<string, string>}
 */
export function blockPositions(ws, shownLetters = null) {
  const tops = ws.getTopBlocks(true);
  const letters = stackLetters(tops, shownLetters);
  const positions = new Map();
  for (const top of tops) {
    const stack = `stack ${letters.get(top.id)}`;
    let n = 0;
    for (let b = top; b; b = b.getNextBlock()) {
      n++;
      positions.set(b.id, `${stack}, block ${n}`);
      const below = new Set(b.getNextBlock()?.getDescendants(false) || []);
      for (const inner of b.getDescendants(false)) {
        if (inner !== b && !below.has(inner)) positions.set(inner.id, `inside block ${n} of ${stack}`);
      }
    }
  }
  return positions;
}

/**
 * @param {!Blockly.Workspace} ws
 * @param {{cursor?: ?string, field?: ?string, onWorkspace?: boolean, allowedTypes?: ?Array<string>,
 *     stackLetters?: ?Map<string, string>}=} options
 *     field: the field the cursor is on, when it is on one; onWorkspace: the cursor is on empty workspace
 * @returns {{text: string, toShort: !Map<string, string>, toReal: !Map<string, string>}}
 */
export function snapshot(ws, {cursor = null, field = null, onWorkspace = false, allowedTypes = null,
  stackLetters: shown = null} = {}) {
  const tops = ws.getTopBlocks(true);
  const letters = stackLetters(tops, shown);
  const toShort = new Map();
  const toReal = new Map();
  const id = (block) => {
    if (!toShort.has(block.id)) {
      const short = `b${toShort.size + 1}`;
      toShort.set(block.id, short);
      toReal.set(short, block.id);
    }
    return toShort.get(block.id);
  };
  const lines = [];
  const statements = (block, depth) => {
    if (block.type === QUESTION_TYPE) return;
    for (const input of block.inputList) {
      if (input.type !== STATEMENT() || !input.connection) continue;
      const first = input.connection.targetBlock();
      lines.push(`${'  '.repeat(depth)}${input.name}:${first ? '' : ' (empty)'}`);
      for (let b = first; b; b = b.getNextBlock()) {
        lines.push(`${'  '.repeat(depth + 1)}${inline(b, id)}`);
        statements(b, depth + 2);
      }
    }
  };
  for (const top of tops) {
    const name = stackName(top);
    lines.push(`Stack ${letters.get(top.id)}${name ? `: ${name}` : ''}`);
    let n = 0;
    for (let b = top; b; b = b.getNextBlock()) {
      lines.push(`${++n}. ${inline(b, id)}`);
      statements(b, 1);
    }
  }
  if (!tops.length) lines.push('(the workspace is empty)');

  const cursorBlock = cursor && ws.getBlockById(cursor);
  const question = inQuestionSlot(cursorBlock);
  const focused = question || cursorBlock;
  const onField = !question && field && focused?.getField(field) ? ` field ${field}` : '';
  if (focused) lines.push('', `Cursor: [${toShort.get(focused.id)}]${onField}, ${blockPositions(ws, shown).get(focused.id)}`);
  else if (onWorkspace) lines.push('', 'Cursor: on empty workspace, not on a block');
  const variables = ws.getAllVariables().map((v) => v.name);
  if (variables.length) lines.push(`Variables: ${variables.join(', ')}`);
  if (allowedTypes?.length) lines.push(`Toolbox block types: ${allowedTypes.filter((t) => t !== QUESTION_TYPE).join(', ')}`);
  return {text: lines.join('\n'), toShort, toReal};
}
