/**
 * Choices for the interactive hint: real blocks the learner can pick, built from
 * the question's hidden reference. A value gets the reference plus two wrong
 * variants; a control structure gets empty variants of its family; a statement or
 * sequence gets the next block kind it needs plus two other kinds. The same
 * program state always gives the same choices in the same order.
 */

import * as Blockly from 'blockly/core';
import {Activity, getPolicy} from '../policy.js';
import {Expects} from './model.js';
import {isAttempted} from './session.js';

export const CHOICE_COUNT = 3;

/** Control structures and their siblings, as toolbox items (empty: no condition, no body). */
const CONTROL_FAMILIES = [
  [
    {kind: 'block', type: 'controls_if'},
    {kind: 'block', type: 'controls_if', extraState: {hasElse: true}},
    {kind: 'block', type: 'controls_if', extraState: {elseIfCount: 1, hasElse: true}},
  ],
  [
    {kind: 'block', type: 'controls_repeat_ext'},
    {kind: 'block', type: 'controls_whileUntil', fields: {MODE: 'WHILE'}},
    {kind: 'block', type: 'controls_whileUntil', fields: {MODE: 'UNTIL'}},
    {kind: 'block', type: 'controls_for'},
    {kind: 'block', type: 'controls_forEach'},
  ],
];

const FLIPS = {
  logic_compare: {OP: {EQ: 'NEQ', NEQ: 'EQ', LT: 'GT', GT: 'LT', LTE: 'GTE', GTE: 'LTE'}},
  logic_boolean: {BOOL: {TRUE: 'FALSE', FALSE: 'TRUE'}},
  logic_operation: {OP: {AND: 'OR', OR: 'AND'}},
  math_arithmetic: {OP: {ADD: 'MINUS', MINUS: 'ADD', MULTIPLY: 'DIVIDE', DIVIDE: 'MULTIPLY', POWER: 'MULTIPLY'}},
};

/**
 * Wrong-value rules, in order. Each returns a changed copy of the state, or null.
 * @type {!Array<function(!Object, !Object): ?Object>}
 */
const VALUE_RULES = [
  (state) => flipField(state, 'logic_compare'),
  (state) => editFirst(state, (b) => b.type === 'math_number', (b) => {
    const n = Number(b.fields.NUM);
    const next = n !== 0 && Number.isInteger(n / 10) ? n / 10 : n !== 0 ? n * 10 : 1;
    b.fields.NUM = next;
  }),
  (state) => flipField(state, 'logic_boolean'),
  (state) => flipField(state, 'logic_operation'),
  (state) => flipField(state, 'math_arithmetic'),
  (state, {variables}) => editFirst(state, (b) => b.type === 'variables_get', (b) => {
    const other = variables.find((v) => v.id !== b.fields.VAR?.id);
    if (!other) return false;
    b.fields.VAR = {id: other.id, name: other.name, type: other.type || ''};
  }),
];

function flipField(state, type) {
  const [[field, map]] = Object.entries(FLIPS[type]);
  return editFirst(state, (b) => b.type === type && map[b.fields?.[field]], (b) => {
    b.fields[field] = map[b.fields[field]];
  });
}

/** Copies the state and applies `change` to the first matching block (depth first). */
function editFirst(state, matches, change) {
  const copy = structuredClone(state);
  const visit = (block) => {
    if (!block) return false;
    if (matches(block) && change(block) !== false) return true;
    for (const input of Object.values(block.inputs || {})) if (visit(input.block)) return true;
    return visit(block.next?.block);
  };
  return visit(copy) ? copy : null;
}

/** Block state without ids or coordinates, as a toolbox item. */
function toItem(state) {
  const strip = (block) => {
    if (!block) return;
    delete block.id;
    delete block.x;
    delete block.y;
    Object.values(block.inputs || {}).forEach((input) => {
      strip(input.block);
      strip(input.shadow);
    });
    strip(block.next?.block);
  };
  const copy = structuredClone(state);
  strip(copy);
  return {kind: 'block', ...copy};
}

const sameBlock = (a, b) => JSON.stringify(toItem(a)) === JSON.stringify(toItem(b));

/** Deterministic shuffle seeded by a string. */
function shuffled(items, seed) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** @type {!Map<string, {statement: boolean, output: ?Array<string>}>} */
const shapeCache = new Map();

function shapeOf(type) {
  if (!shapeCache.has(type)) {
    const scratch = new Blockly.Workspace();
    try {
      const block = scratch.newBlock(type);
      shapeCache.set(type, {
        statement: !!block.previousConnection && !block.outputConnection,
        output: block.outputConnection ? block.outputConnection.getCheck() : undefined,
      });
    } catch (e) {
      shapeCache.set(type, {statement: false, output: undefined});
    } finally {
      scratch.dispose();
    }
  }
  return shapeCache.get(type);
}

/** An untyped value (e.g. a variable) accepts any value block as a stand-in. */
const sameOutput = (a, b) => b === null || JSON.stringify(a ?? null) === JSON.stringify(b);

/** The toolbox item for a type (with its default shadows), or a bare block. */
function catalogItem(catalog, type) {
  for (const category of catalog) {
    const item = category.items.find((i) => i.type === type);
    if (item) return structuredClone(item);
  }
  return {kind: 'block', type};
}

/** Other statement kinds from the toolbox, same category first. */
function otherStatementKinds(catalog, type, count) {
  const home = catalog.find((c) => c.items.some((i) => i.type === type));
  const ordered = [...(home ? [home] : []), ...catalog.filter((c) => c !== home)];
  const seen = new Set([type]);
  const out = [];
  for (const category of ordered) {
    for (const item of category.items) {
      if (out.length >= count) return out;
      if (seen.has(item.type) || !shapeOf(item.type).statement || CONTROL_FAMILIES.flat().some((c) => c.type === item.type)) continue;
      seen.add(item.type);
      out.push(structuredClone(item));
    }
  }
  return out;
}

function controlFamily(reference) {
  for (const family of CONTROL_FAMILIES) {
    const index = family.findIndex((item) => item.type === reference.type &&
      (!item.fields || item.fields.MODE === reference.fields?.MODE) &&
      (reference.type !== 'controls_if' || JSON.stringify(item.extraState || {}) === JSON.stringify(ifShape(reference))));
    if (index >= 0) return {family, index};
  }
  return null;
}

function ifShape(reference) {
  const {elseIfCount = 0, hasElse = false} = reference.extraState || {};
  if (elseIfCount) return {elseIfCount: 1, hasElse: true};
  return hasElse ? {hasElse: true} : {};
}

function valueChoices(reference, context) {
  const wrong = [];
  for (const rule of VALUE_RULES) {
    if (wrong.length >= CHOICE_COUNT - 1) break;
    const variant = rule(reference, context);
    if (variant && !sameBlock(variant, reference) && !wrong.some((w) => sameBlock(w, variant))) wrong.push(variant);
  }
  const output = shapeOf(reference.type).output;
  for (const category of context.catalog) {
    for (const item of category.items) {
      if (wrong.length >= CHOICE_COUNT - 1) break;
      const shape = shapeOf(item.type);
      if (item.type !== reference.type && shape.output !== undefined && sameOutput(shape.output, output)) {
        wrong.push(structuredClone(item));
      }
    }
  }
  return [reference, ...wrong].map(toItem);
}

function kindChoices(type, context) {
  return [catalogItem(context.catalog, type), ...otherStatementKinds(context.catalog, type, CHOICE_COUNT - 1)];
}

/**
 * @param {!Object} reference  The question's reference (block state).
 * @param {!Array<!Blockly.Block>} members  The learner's current top-level answer blocks.
 * @param {string} expects
 * @returns {?Object} Reference block state of the next block the answer lacks.
 */
function nextMissing(reference, members, expects) {
  const chain = [];
  for (let b = reference; b; b = b.next?.block) chain.push(b);
  if (expects !== Expects.SEQUENCE) return chain[0];
  let i = 0;
  while (i < chain.length && i < members.length && members[i].type === chain[i].type) i++;
  return chain[i] || null;
}

/**
 * @param {{gap: string, config: !Object, members: !Array<!Blockly.Block>}} question
 * @param {{catalog: !Array<{items: !Array<!Object>}>, variables: !Array<{id: string, name: string, type: string}>}} context
 *     The toolbox catalog (toolboxCatalog in ui/snapshots.js) and the workspace's variables.
 * @returns {!Array<!Object>} Toolbox items to show, in a stable order (empty if none).
 */
export function choicesFor(question, context) {
  const {config, members, gap} = question;
  if (!config.reference) return [];
  let items;
  if (config.expects === Expects.VALUE) {
    items = valueChoices(config.reference, context);
  } else {
    const next = nextMissing(config.reference, members, config.expects);
    if (!next) return [];
    const control = config.expects !== Expects.SEQUENCE && controlFamily(next);
    items = control ?
      [control.family[control.index], ...control.family.filter((_, i) => i !== control.index).slice(0, CHOICE_COUNT - 1)]
          .map((item) => structuredClone(item)) :
      kindChoices(next.type, context);
  }
  return shuffled(items, `${gap}:${members.length}`);
}

/**
 * Whether the learner may open choices now: a reference exists, the teacher left
 * them on, it isn't a quiz, and the learner has tried once.
 */
export function offersChoices(workspace, question) {
  const {config, gap} = question;
  return !!config.reference && config.offerChoices &&
    getPolicy(workspace).activity !== Activity.QUIZ && isAttempted(workspace, gap);
}
