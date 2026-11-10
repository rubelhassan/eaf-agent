// @ts-check
// Assistant-made blocks get the assistant's face (the panel's small logo) in a chip beside the question badge.

import * as Blockly from 'blockly/core';
import {getOutputManager} from '../output/active.js';
import {Creator, creatorOf} from './authorship.js';
import {getBinding} from './question/binding.js';

const MARK_CLASS = 'eaf-assistant-made-mark';
const RADIUS = 8;
const GAP = 2;
// A value block starting this close to its parent's top is on the parent's first row.
const TOP_ROW_PX = 10;
// The logo's face: a dark screen with two light eyes.
const SCREEN = '#1f2a44';
const EYES = '#8ff0b4';

/** @returns {string} */
export function assistantNameNow() {
  return getOutputManager()?.aiName?.() || 'Neon';
}

/** @param {?Blockly.Block} block @returns {string} */
export function madeByWords(block) {
  return creatorOf(block) === Creator.ASSISTANT ? `made by ${assistantNameNow()}` : '';
}

export class AuthorshipMarks {
  /** @param {!Blockly.WorkspaceSvg} workspace */
  constructor(workspace) {
    this.workspace = workspace;
    this.marks_ = new Map();
    this.timer_ = null;
    this.disposed_ = false;
    this.listener_ = (event) => {
      if (event.workspaceId === workspace.id && !event.isUiEvent) this.schedule_();
    };
  }

  /** @returns {!AuthorshipMarks} */
  attach() {
    this.workspace.addChangeListener(this.listener_);
    this.update();
    return this;
  }

  dispose() {
    this.disposed_ = true;
    clearTimeout(this.timer_);
    this.timer_ = null;
    this.workspace.removeChangeListener(this.listener_);
    for (const mark of this.marks_.values()) mark.remove();
    this.marks_.clear();
  }

  schedule_() {
    if (this.disposed_ || this.timer_ !== null) return;
    this.timer_ = setTimeout(async () => {
      await Blockly.renderManagement.finishQueuedRenders();
      this.timer_ = null;
      this.update();
    }, 0);
  }

  update() {
    if (this.disposed_) return;
    const marked = new Set();
    for (const block of this.workspace.getAllBlocks(false)) {
      if (block.isShadow() || creatorOf(block) !== Creator.ASSISTANT || !block.rendered || block.isInsertionMarker()) continue;
      // One mark per change: a value block made with its parent shares the parent's mark.
      if (block.outputConnection && creatorOf(block.getParent()) === Creator.ASSISTANT) continue;
      marked.add(block.id);
      this.draw_(block);
    }
    for (const [id, mark] of this.marks_) {
      if (!marked.has(id)) {
        mark.remove();
        this.marks_.delete(id);
      }
    }
  }

  draw_(block) {
    const root = block.getSvgRoot();
    const colour = block.getColour();
    let mark = this.marks_.get(block.id);
    if (!mark || mark.parentNode !== root || mark.dataset.colour !== colour) {
      mark?.remove();
      mark = createMark(colour);
      root.appendChild(mark);
      this.marks_.set(block.id, mark);
    }
    mark.querySelector('title').textContent = `Made by ${assistantNameNow()}`;
    // The top-right corner of the whole block, left of a question badge.
    const offset = getBinding(block) ? 2 * RADIUS + GAP : 0;
    mark.setAttribute('transform', `translate(${topRight(block) - RADIUS - offset}, ${-RADIUS + 1})`);
  }
}

/**
 * Where the block's top row ends, with the value blocks plugged into that row; a C-block's body can be wider than
 * its top row, so the block's width alone puts the chip too far right.
 */
function topRight(block) {
  const path = block.pathObject?.svgPath;
  if (typeof path?.getTotalLength !== 'function') return block.width;
  let right = 0;
  const length = path.getTotalLength();
  for (let at = 0; at <= length; at += 2) {
    const point = path.getPointAtLength(at);
    if (Math.abs(point.y) < 1) right = Math.max(right, point.x);
  }
  const origin = block.getRelativeToSurfaceXY();
  for (const input of block.inputList) {
    const child = input.connection?.targetBlock();
    if (!child?.outputConnection) continue;
    const at = child.getRelativeToSurfaceXY();
    if (at.y - origin.y < TOP_ROW_PX) right = Math.max(right, at.x - origin.x + topRight(child));
  }
  return right || block.width;
}

function createMark(colour) {
  const make = (tag, attributes) => {
    const element = document.createElementNS(Blockly.utils.dom.SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
    return element;
  };
  const mark = make('g', {class: MARK_CLASS, 'data-colour': colour, 'aria-hidden': 'true'});
  mark.appendChild(make('title', {}));
  mark.appendChild(make('circle', {cx: RADIUS, cy: RADIUS, r: RADIUS, fill: '#FFFFFF', stroke: colour, 'stroke-width': 1.5}));
  mark.appendChild(make('rect', {class: `${MARK_CLASS}-screen`, x: RADIUS - 5.5, y: RADIUS - 4, width: 11, height: 8, rx: 3, fill: SCREEN}));
  for (const dx of [-2.5, 2.5]) {
    mark.appendChild(make('circle', {class: `${MARK_CLASS}-eye`, cx: RADIUS + dx, cy: RADIUS - 0.6, r: 1.3, fill: EYES}));
  }
  return mark;
}
