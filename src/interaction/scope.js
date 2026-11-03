// @ts-check
// Scope of a request: the cursor's level, widened by clear words.

import * as Blockly from 'blockly/core';
import {inQuestionSlot} from '../agent/guardrails/learner_work.js';

const PROGRAM = /\b(program|whole thing|everything|all of it|my code|the code)\b/;
const STACK = /\b(stack|this part|this section)\b/;

/**
 * @param {!Blockly.Workspace} ws
 * @param {{block: ?string, field?: ?string}} cursor
 * @param {string} words
 * @returns {string} field | block | statement | stack | program
 */
export function scopeFor(ws, cursor, words) {
  const text = String(words).toLowerCase();
  const block = cursor.block && ws.getBlockById(cursor.block);
  if (PROGRAM.test(text) || !block) return 'program';
  if (STACK.test(text)) return 'stack';
  if (inQuestionSlot(block)) return 'block';
  if (cursor.field && block.getField(cursor.field)) return 'field';
  // A value block, or a container like repeat, is explained as a block; a plain statement with its values.
  const container = block.inputList.some((i) => i.type === Blockly.inputs.inputTypes.STATEMENT);
  return block.outputConnection || container ? 'block' : 'statement';
}
