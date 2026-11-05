/**
 * The question block's two fixed shapes:
 *   value     ( [?] [ slot ] )             fits value sockets
 *   statement [ [?]  { slot } ]            fits stacks, statement and sequence
 * The slot is where the learner puts their answer; the question then vanishes and
 * the answer docks in its place (tracker.js).
 */

import * as Blockly from 'blockly/core';
import {ANSWER_INPUT, Expects} from './model.js';

/** Gold from documentation/rough_idea.png: one colour for every question block. */
export const QUESTION_COLOUR = '#EAC452';

/** Blue "?" from the sketch; about 7:1 on the white chip. */
const CHIP_MARK_COLOUR = '#2854C5';

const CHIP_SIZE = 20;

/** Called when the "?" chip is clicked (set by index.js: opens the question popover). */
let chipClickHandler = null;
export function setChipClickHandler(handler) {
  chipClickHandler = handler;
}

/**
 * A round white chip with a "?".
 * @param {string=} colour  Hex colour for the "?".
 * @returns {string} data: URI of an SVG image.
 */
export function chipImage(colour = CHIP_MARK_COLOUR) {
  const r = CHIP_SIZE / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CHIP_SIZE}" height="${CHIP_SIZE}" viewBox="0 0 ${CHIP_SIZE} ${CHIP_SIZE}">` +
    `<circle cx="${r}" cy="${r}" r="${r - 0.5}" fill="#FFFFFF"/>` +
    `<text x="${r}" y="${r + 5}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" ` +
    `font-size="14" font-weight="700" fill="${colour}">?</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** @returns {boolean} True if the block currently has statement shape. */
export function hasStatementShape(block) {
  return !!block.previousConnection;
}

/** @returns {boolean} True if the block already renders the shape `expects` needs. */
export function hasShapeFor(block, expects) {
  if (!block.getInput(ANSWER_INPUT)) return false;
  return (expects !== Expects.VALUE) === hasStatementShape(block);
}

/** A block can only change shape while nothing is attached to it or in its slot. */
export function canReshape(block) {
  return [block.outputConnection, block.previousConnection, block.nextConnection,
    block.getInput(ANSWER_INPUT)?.connection]
      .every((connection) => !connection || !connection.isConnected());
}

/**
 * Gives the block the shape and style for `expects`. No-op if it already has it.
 * The shape is set once (from the toolbox entry or saved state); it is not a
 * learner-facing toggle.
 * @param {!Blockly.Block} block
 * @param {string} expects  One of Expects.
 * @returns {boolean} False if the block is attached to something and cannot change.
 */
export function applyShape(block, expects) {
  if (hasShapeFor(block, expects)) return true;
  if (!canReshape(block)) return false;

  const statement = expects !== Expects.VALUE;
  if (block.getInput(ANSWER_INPUT)) block.removeInput(ANSWER_INPUT);

  if (statement) {
    block.setOutput(false);
    block.setPreviousStatement(true, null);
    block.setNextStatement(true, null);
  } else {
    block.setPreviousStatement(false);
    block.setNextStatement(false);
    block.setOutput(true, null);
  }
  block.setColour(QUESTION_COLOUR);

  const chip = new Blockly.FieldImage(chipImage(), CHIP_SIZE, CHIP_SIZE, 'question',
      (field) => chipClickHandler?.(field.getSourceBlock()));
  const input = statement ? block.appendStatementInput(ANSWER_INPUT) : block.appendValueInput(ANSWER_INPUT);
  input.appendField(chip);
  block.setInputsInline(!statement);
  return true;
}
