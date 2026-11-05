/**
 * Blockly definition of the question block: a wrapper with a "?" chip and one
 * answer slot, in a fixed value or statement shape.
 * Its configuration travels as extra state (JSON, copy/paste, undo, toolbox
 * `extraState`) and as a readable <mutation> element in XML (see xml.js).
 */

import * as Blockly from 'blockly/core';
import {QUESTION_TYPE, defaultConfig, normalizeConfig} from './model.js';
import {applyShape} from './shapes.js';
import {configFromDom, configToDom} from './xml.js';

/** CSS class on the question block's SVG group. */
export const QUESTION_CSS_CLASS = 'eaf-question-block';

/** Added while a learner's keyboard Edit mode is on the question (it is replaced as a whole). */
export const QUESTION_EDITING_CLASS = 'eaf-question-editing';

/** Dark dashed outline marks the block as a placeholder to fill (visible on the fill and the workspace). */
const QUESTION_CSS = `
  .${QUESTION_CSS_CLASS} > .blocklyPath {
    stroke: #7A5C0E;
    stroke-width: 2px;
    stroke-dasharray: 6 3;
  }
  .${QUESTION_CSS_CLASS}.blocklyInsertionMarker > .blocklyPath {
    stroke-dasharray: none;
  }
  /* Same colour and rhythm as the Edit-mode connection indicator. */
  .${QUESTION_CSS_CLASS}.${QUESTION_EDITING_CLASS} > .blocklyPath {
    stroke: #FF5722;
    stroke-width: 3px;
    animation: eaf-question-edit-blink 1.5s steps(1) infinite;
  }
  @keyframes eaf-question-edit-blink {
    0%, 49% { stroke-opacity: 1; }
    50%, 100% { stroke-opacity: 0.15; }
  }
`;

/**
 * Changes a question's configuration as one undoable step.
 * @param {!Blockly.Block} block
 * @param {!Object} changes  Partial config merged into the current one.
 * @returns {boolean} False if a shape change was requested but the block is attached.
 */
export function updateQuestionConfig(block, changes) {
  const before = JSON.stringify(block.saveExtraState());
  const ok = block.setQuestionConfig({...block.getQuestionConfig(), ...changes});
  const after = JSON.stringify(block.saveExtraState());
  if (before !== after && Blockly.Events.isEnabled()) {
    const BlockChange = Blockly.Events.get(Blockly.Events.BLOCK_CHANGE);
    Blockly.Events.fire(new BlockChange(block, 'mutation', null, before, after));
  }
  return ok;
}

const questionBlock = {
  init() {
    /** @private */
    this.questionConfig_ = defaultConfig();
    applyShape(this, this.questionConfig_.expects);
    this.setTooltip(() => {
      const {prompt} = this.questionConfig_;
      return prompt ? `Question: ${prompt}` : 'Question: put a block in its slot to answer it.';
    });
    // Rendered blocks only (BlockSvg creates its SVG group before init runs).
    const root = this.getSvgRoot?.();
    if (root) Blockly.utils.dom.addClass(root, QUESTION_CSS_CLASS);
  },

  /** @returns {!import('./model.js').QuestionConfig} A copy of the configuration. */
  getQuestionConfig() {
    return structuredClone(this.questionConfig_);
  },

  /**
   * Replaces the configuration (normalized) and applies its shape.
   * Does not fire events; use updateQuestionConfig for user-initiated changes.
   * @param {*} raw
   * @returns {boolean} False if the requested shape could not be applied (the old shape is kept).
   */
  setQuestionConfig(raw) {
    const next = normalizeConfig(raw);
    const shaped = applyShape(this, next.expects);
    // The shape always matches `expects`, so when it cannot change, the old value still holds.
    if (!shaped) next.expects = this.questionConfig_.expects;
    this.questionConfig_ = next;
    return shaped;
  },

  saveExtraState() {
    return this.getQuestionConfig();
  },

  loadExtraState(state) {
    this.setQuestionConfig(state);
  },

  /** XML form (Blockly's XML serializer does not use extra state). */
  mutationToDom() {
    return configToDom(this.questionConfig_);
  },

  domToMutation(mutation) {
    this.setQuestionConfig(configFromDom(mutation));
  },
};

/** Registers the block definition (and its CSS) with Blockly. */
export function defineQuestionBlock() {
  Blockly.Css.register(QUESTION_CSS);
  Blockly.Blocks[QUESTION_TYPE] = questionBlock;
}
