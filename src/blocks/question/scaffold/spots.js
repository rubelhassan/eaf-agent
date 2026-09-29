/**
 * Where a scaffold may put questions, and how many. A spot is a part of the
 * program that one question can replace: a value, a single statement, a control
 * structure, or a run of 2 to 3 statements.
 */

import {LearnerLevel} from '../../policy.js';
import {blockTypes} from '../../registry.js';
import {isQuestion} from '../rules.js';

export const SpotKind = Object.freeze({
  VALUE: 'value',
  STATEMENT: 'statement',
  CONTROL: 'control',
  SEQUENCE: 'sequence',
});

export const CONCEPTS = ['variables', 'input-output', 'conditionals', 'loops', 'lists', 'text', 'math', 'functions'];

const CONTROL_TYPES = new Set(['controls_if', 'controls_repeat_ext', 'controls_repeat', 'controls_whileUntil',
  'controls_for', 'controls_forEach']);

const LEVELS = {
  [LearnerLevel.BEGINNER]: {per: 8, min: 1, max: 2, kinds: [SpotKind.VALUE, SpotKind.STATEMENT]},
  [LearnerLevel.INTERMEDIATE]: {per: 5, min: 1, max: 4, kinds: [SpotKind.VALUE, SpotKind.STATEMENT, SpotKind.CONTROL]},
  [LearnerLevel.ADVANCED]: {per: 3, min: 2, max: 6, kinds: Object.values(SpotKind)},
};

/** @returns {?string} The concept a block type belongs to. */
export function conceptOf(type) {
  if (CONTROL_TYPES.has(type) && type !== 'controls_if') return 'loops';
  if (type === 'controls_flow_statements') return 'loops';
  if (type === 'controls_if' || type.startsWith('logic_')) return 'conditionals';
  if (type.startsWith('variables_') || type === 'math_change') return 'variables';
  if (type === 'text_print' || type.startsWith('text_prompt')) return 'input-output';
  if (type.startsWith('lists_')) return 'lists';
  if (type.startsWith('text')) return 'text';
  if (type.startsWith('math_')) return 'math';
  if (type.startsWith('procedures_')) return 'functions';
  return null;
}

const isStatement = (b) => !!b.previousConnection && !b.outputConnection;
const isProcedureDef = (b) => b.type.startsWith('procedures_def');

/**
 * @typedef {Object} Spot
 * @property {string} id
 * @property {string} kind  One of SpotKind.
 * @property {!Array<!Blockly.Block>} blocks  Top-level blocks of the spot (one, or a run).
 * @property {!Set<string>} covers  Ids of every block inside the spot.
 * @property {!Array<string>} concepts
 * @property {string} code
 */

function codeOf(blocks) {
  const generator = blockTypes.generator('javascript');
  if (!generator) return '';
  try {
    generator.init(blocks[0].workspace);
    return blocks.map((b) => {
      const code = generator.blockToCode(b, /* thisOnly= */ true);
      return (Array.isArray(code) ? code[0] : code).trim();
    }).join('\n');
  } catch (e) {
    return '';
  }
}

function makeSpot(id, kind, blocks) {
  // Everything under the first block, except what follows the last one.
  const after = new Set((blocks[blocks.length - 1].getNextBlock()?.getDescendants(false) || []).map((b) => b.id));
  const inside = blocks[0].getDescendants(false).filter((b) => !after.has(b.id));
  const concepts = [...new Set(inside.map((b) => conceptOf(b.type)).filter(Boolean))];
  return {id, kind, blocks, covers: new Set(inside.map((b) => b.id)), concepts, code: codeOf(blocks)};
}

/**
 * Every spot in the program, in program order. Shadows, question blocks,
 * procedure definitions and the program's very first statement (with its values)
 * are never spots: that is usually routine setup.
 * @param {!Blockly.Workspace} workspace
 * @returns {!Array<!Spot>}
 */
export function findSpots(workspace) {
  const spots = [];
  const tops = workspace.getTopBlocks(true);
  const first = tops.find(isStatement);
  for (const top of tops) {
    for (const block of top.getDescendants(true)) {
      if (block.isShadow() || block.isInsertionMarker?.() || isQuestion(block) || isProcedureDef(block)) continue;
      if (block.getParent() && isQuestion(block.getParent())) continue;
      if (block.outputConnection) {
        const parent = block.getParent();
        // Only a whole value plugged into a statement (not a piece of a bigger value).
        if (parent && parent !== first && !parent.outputConnection && !isQuestion(parent)) {
          spots.push(makeSpot(`v:${block.id}`, SpotKind.VALUE, [block]));
        }
        continue;
      }
      if (!isStatement(block) || block === first) continue;
      const kind = CONTROL_TYPES.has(block.type) ? SpotKind.CONTROL : SpotKind.STATEMENT;
      spots.push(makeSpot(`${kind === SpotKind.CONTROL ? 'c' : 's'}:${block.id}`, kind, [block]));
      // Runs of 2 and 3 statements starting here, within the same stack.
      const run = [block];
      for (let next = block.getNextBlock(); next && run.length < 3 && !isQuestion(next); next = next.getNextBlock()) {
        run.push(next);
        spots.push(makeSpot(`q:${block.id}:${run.length}`, SpotKind.SEQUENCE, [...run]));
      }
    }
  }
  return spots;
}

/** Number of statement blocks in the program (its "length"). */
export function programLength(workspace) {
  return workspace.getAllBlocks(false).filter((b) => isStatement(b) && !b.isShadow() && !isQuestion(b)).length;
}

/**
 * How many gaps a level gets for a program, and which spot kinds it allows.
 * @returns {{min: number, max: number, kinds: !Array<string>}}
 */
export function gapPlan(level, length, available) {
  const rule = LEVELS[level] || LEVELS[LearnerLevel.BEGINNER];
  const wanted = Math.min(rule.max, Math.max(rule.min, Math.round(length / rule.per)));
  const max = Math.min(wanted, available);
  return {min: Math.min(rule.min, max), max, kinds: rule.kinds};
}

/** @returns {boolean} True if two spots share or nest any block. */
export function overlaps(a, b) {
  for (const id of a.covers) if (b.covers.has(id)) return true;
  return false;
}

const LITERALS = new Set(['math_number', 'text', 'logic_boolean', 'logic_null']);

/**
 * Most important spots first: spots with the concept (best when the spot's own
 * block is the concept, e.g. the arithmetic itself, not the set block holding it),
 * then parts nested inside loops and ifs, then anything more than a plain literal.
 * Ties keep program order.
 * @returns {!Array<!Spot>}
 */
export function rankSpots(spots, concept) {
  const score = (spot) => {
    const top = spot.blocks[0];
    let depth = 0;
    for (let p = top.getSurroundParent(); p; p = p.getSurroundParent()) if (CONTROL_TYPES.has(p.type)) depth++;
    const literal = spot.kind === SpotKind.VALUE && LITERALS.has(top.type) && !top.getChildren(false).length;
    const matches = concept !== 'auto' && spot.concepts.includes(concept);
    const own = concept !== 'auto' && conceptOf(top.type) === concept;
    return (matches ? 10 : 0) + (own ? 3 : 0) + Math.min(depth, 3) * 2 + (literal ? 0 : 1);
  };
  return spots.map((spot, i) => ({spot, i, s: score(spot)}))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map(({spot}) => spot);
}
