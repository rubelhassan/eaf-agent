/**
 * Suggested blocks, marked in place: for beginners, while the keyboard
 * marker (or the cursor) is on a question's spot, its intended block types are
 * "suggested". The toolbox is never restructured; speech notes and a star in the
 * flyout mark them. Other learner levels get no suggestions.
 */

import * as Blockly from 'blockly/core';
import {LearnerLevel, getPolicy} from '../policy.js';
import {ANSWER_INPUT} from './model.js';
import {isQuestion} from './rules.js';

/** Must match Navigation.MARKER_NAME (src/navigation.js). */
const MARKER_NAME = 'local_marker_1';
const STAR_CLASS = 'eaf-suggested-star';

/** @returns {?Blockly.Block} The question a connection belongs to or leads into. */
function questionAtConnection(connection) {
  const owner = connection.getSourceBlock();
  // The question's own slot, top connection, or output.
  if (isQuestion(owner)) {
    const own = [owner.getInput(ANSWER_INPUT)?.connection, owner.previousConnection, owner.outputConnection];
    if (own.includes(connection)) return owner;
  }
  // The socket holding a value question, or the connection right above a statement question.
  const target = connection.isSuperior() ? connection.targetBlock() : null;
  return isQuestion(target) ? target : null;
}

/**
 * @param {!Blockly.Workspace} workspace  The main workspace or its flyout workspace.
 * @returns {!Array<string>} Block types suggested right now (may be empty).
 */
export function suggestedTypes(workspace) {
  const ws = workspace?.targetWorkspace || workspace;
  if (!ws || getPolicy(ws).learnerLevel !== LearnerLevel.BEGINNER) return [];
  const node = ws?.getMarker?.(MARKER_NAME)?.getCurNode?.() || ws?.getCursor?.()?.getCurNode?.();
  if (!node) return [];
  let question = null;
  if (node.isConnection()) {
    question = questionAtConnection(node.getLocation());
  } else if (node.getType() === Blockly.ASTNode.types.BLOCK) {
    const block = node.getSourceBlock();
    question = isQuestion(block) ? block : null;
  }
  return question ? question.getQuestionConfig().intendedTypes : [];
}

/** @returns {?string} Spoken note for a flyout block, e.g. "suggested". */
export function flyoutNote(block) {
  return suggestedTypes(block.workspace).includes(block.type) ? 'suggested' : null;
}

/** @returns {?string} Spoken note for a toolbox category that holds suggested blocks. */
export function categoryNote(category, workspace) {
  const types = suggestedTypes(workspace);
  if (!types.length || typeof category?.getContents !== 'function') return null;
  const contents = category.getContents();
  const has = Array.isArray(contents) && contents.some((item) => types.includes(item.type));
  return has ? 'has suggested blocks' : null;
}

/** Draws a star on suggested blocks whenever a flyout opens. */
export class SuggestionStars {
  /** @param {!Blockly.WorkspaceSvg} workspace */
  constructor(workspace) {
    this.workspace = workspace;
    this.listener_ = (event) => {
      if (event.workspaceId !== workspace.id || event.type !== Blockly.Events.TOOLBOX_ITEM_SELECT) return;
      setTimeout(() => this.update(), 0);
    };
  }

  /** @returns {!SuggestionStars} */
  attach() {
    this.workspace.addChangeListener(this.listener_);
    return this;
  }

  dispose() {
    this.workspace.removeChangeListener(this.listener_);
  }

  update() {
    const flyout = this.workspace.getFlyout?.();
    if (!flyout?.isVisible?.()) return;
    const types = suggestedTypes(this.workspace);
    for (const block of flyout.getWorkspace().getTopBlocks(false)) {
      const root = block.getSvgRoot();
      root.querySelector(`:scope > .${STAR_CLASS}`)?.remove();
      if (types.includes(block.type)) root.appendChild(createStar(block.width));
    }
  }
}

function createStar(blockWidth) {
  const NS = Blockly.utils.dom.SVG_NS;
  const star = document.createElementNS(NS, 'polygon');
  star.classList.add(STAR_CLASS);
  star.setAttribute('aria-hidden', 'true');
  const cx = blockWidth + 4;
  const cy = 0;
  const points = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 3.5 : 8;
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    points.push(`${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`);
  }
  star.setAttribute('points', points.join(' '));
  star.setAttribute('fill', '#EAC452');
  star.setAttribute('stroke', '#7A5C0E');
  star.setAttribute('stroke-width', '1.5');
  return star;
}
