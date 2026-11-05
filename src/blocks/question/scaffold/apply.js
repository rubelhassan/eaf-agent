/**
 * Turns chosen spots into questions for the teacher: each question takes the
 * spot's place and holds the spot's blocks in its slot, which makes them the
 * reference answer (hidden from learners on export).
 */

import {withConnectionRulesSuspended} from '../../connection_checker.js';
import {ANSWER_INPUT, AiHintLevel, Expects, QUESTION_TYPE} from '../model.js';
import {SpotKind} from './spots.js';

function newQuestion(workspace, config) {
  const question = workspace.newBlock(QUESTION_TYPE);
  question.setQuestionConfig(config);
  if (question.initSvg) {
    question.initSvg();
    question.render();
  }
  return question;
}

function configFor(gap) {
  const {spot} = gap;
  const expects = spot.kind === SpotKind.VALUE ? Expects.VALUE :
    spot.kind === SpotKind.SEQUENCE ? Expects.SEQUENCE : Expects.STATEMENT;
  return {
    expects,
    minBlocks: spot.kind === SpotKind.SEQUENCE ? spot.blocks.length : 1,
    intendedTypes: [...new Set(spot.blocks.map((b) => b.type))],
    prompt: gap.prompt,
    instruction: gap.instruction,
    hints: gap.hints,
    ai: {level: AiHintLevel.POINT, count: 2},
    offerChoices: true,
  };
}

function wrapValue(block, config) {
  const socket = block.outputConnection.targetConnection;
  block.unplug(false);
  const question = newQuestion(block.workspace, config);
  socket.connect(question.outputConnection);
  question.getInput(ANSWER_INPUT).connection.connect(block.outputConnection);
  return question;
}

function wrapStatements(blocks, config) {
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  const above = first.previousConnection.targetConnection;
  const below = last.getNextBlock();
  const position = first.getRelativeToSurfaceXY();
  below?.unplug(false);
  first.unplug(false);
  const question = newQuestion(first.workspace, config);
  if (above) {
    above.connect(question.previousConnection);
  } else {
    question.moveBy(position.x, position.y);
  }
  question.getInput(ANSWER_INPUT).connection.connect(first.previousConnection);
  if (below) question.nextConnection.connect(below.previousConnection);
  return question;
}

/**
 * Wraps each gap's spot in a question, in the caller's event group.
 * @param {!Array<{spot: !Object, prompt: string, instruction: string, hints: !Array<string>}>} gaps
 * @returns {!Array<!Blockly.Block>} The new questions, in program order.
 */
export function wrapGaps(gaps) {
  return withConnectionRulesSuspended(() => gaps.map((gap) => {
    const config = configFor(gap);
    return gap.spot.kind === SpotKind.VALUE ?
      wrapValue(gap.spot.blocks[0], config) :
      wrapStatements(gap.spot.blocks, config);
  }));
}
