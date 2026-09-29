/**
 * Spoken location of a block, using the labels learners already hear:
 * "stack A, block 2". A block without its own number (e.g. inside an if block)
 * is placed by the nearest numbered block around it: "inside block 2 of stack A".
 */

import {getStackLabelManager} from './stack_labels.js';
import {getBlockNumberManager} from './block_numbers.js';

/**
 * @param {!Blockly.Block} block
 * @returns {string} e.g. "stack A, block 2", or '' when labels are unavailable.
 */
export function describeBlockLocation(block) {
  const workspace = block?.workspace;
  if (!workspace) return '';
  let top = block;
  while (top.getParent()) top = top.getParent();
  const letter = getStackLabelManager(workspace)?.stackLetters()?.get(top.id) || '';

  const numbers = getBlockNumberManager();
  let number;
  let own = true;
  for (let b = block; b && number === undefined; b = b.getParent()) {
    number = numbers?.getBlockNumber(b.id);
    if (number === undefined) own = false;
  }

  const stack = letter ? `stack ${letter}` : '';
  if (number === undefined) return stack;
  if (own) return stack ? `${stack}, block ${number}` : `block ${number}`;
  return stack ? `inside block ${number} of ${stack}` : `inside block ${number}`;
}
