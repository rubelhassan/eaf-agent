/**
 * Code generation for the question block. A question normally holds nothing (an
 * answer put in its slot replaces it at once), so it emits a neutral placeholder.
 * If an answer is still in the slot (e.g. teacher mode), the question is
 * transparent and emits exactly the answer's code.
 */

import {ANSWER_INPUT} from './model.js';

/** ATOMIC precedence is 0 in every Blockly code generator. */
const ORDER_ATOMIC = 0;

const PLACEHOLDERS = {
  javascript: {value: 'null', comment: '//'},
  python: {value: 'None', comment: '#'},
  php: {value: 'null', comment: '//'},
  lua: {value: 'nil', comment: '--'},
  dart: {value: 'null', comment: '//'},
};

/** Marker emitted for the question an AI hint is about (see ai_hints.js). */
export const QUESTION_MARKER = '/* QUESTION */';

/**
 * @param {!Blockly.Block} block
 * @param {!Blockly.CodeGenerator} generator  `eafMarkQuestion` = a question id to mark.
 * @param {string} language
 * @returns {string|!Array}
 */
export function generateQuestion(block, generator, language) {
  const placeholder = PLACEHOLDERS[language] || PLACEHOLDERS.javascript;
  if (generator.eafMarkQuestion === block.id) {
    return block.outputConnection ? [QUESTION_MARKER, ORDER_ATOMIC] : `${QUESTION_MARKER}\n`;
  }
  const answer = block.getInputTargetBlock(ANSWER_INPUT);

  if (block.outputConnection) {
    const code = answer ? generator.blockToCode(answer) : null;
    return Array.isArray(code) ? code : [placeholder.value, ORDER_ATOMIC];
  }
  if (!answer) return `${placeholder.comment} question not answered yet\n`;
  // blockToCode on the first answer block also emits the blocks after it.
  const code = generator.blockToCode(answer);
  return typeof code === 'string' ? code : '';
}
