/**
 * Marker on blocks that answer a question: the question's "?" chip (white circle,
 * "?" in the block's colour) at the block's top-right corner, with a hover tooltip
 * showing the question. In practice, an answer that doesn't fit yet gets an orange
 * "!" chip instead (a quiz never reveals fit). Same overlay approach as block
 * numbers and stack labels. Speech for answers comes from the registry decorator.
 */

import * as Blockly from 'blockly/core';
import {onPolicyChange} from '../policy.js';
import {getBinding} from './binding.js';
import {gapOf, isMisfit} from './rules.js';
import {misfitReason, revealsFit} from './speech.js';

const BADGE_CLASS = 'eaf-question-answer-badge';
const RADIUS = 8;
const MISFIT_COLOUR = '#C2410C';

export class AnswerBadges {
  /** @param {!Blockly.WorkspaceSvg} workspace */
  constructor(workspace) {
    this.workspace = workspace;
    /** @type {!Map<string, !SVGElement>} */
    this.badges_ = new Map();
    this.scheduled_ = false;
    this.listener_ = (event) => {
      if (event.workspaceId === this.workspace.id && !event.isUiEvent) this.schedule_();
    };
  }

  /** @returns {!AnswerBadges} */
  attach() {
    this.workspace.addChangeListener(this.listener_);
    this.offPolicy_ = onPolicyChange(this.workspace, () => this.schedule_());
    this.update();
    return this;
  }

  dispose() {
    this.workspace.removeChangeListener(this.listener_);
    this.offPolicy_?.();
    for (const badge of this.badges_.values()) badge.remove();
    this.badges_.clear();
  }

  schedule_() {
    if (this.scheduled_) return;
    this.scheduled_ = true;
    // After the gap tracker (also deferred) has bound or unbound blocks.
    setTimeout(() => {
      this.scheduled_ = false;
      this.update();
    }, 0);
  }

  /** Redraws badges for every bound block. */
  update() {
    const bound = new Set();
    for (const block of this.workspace.getAllBlocks(false)) {
      const binding = getBinding(block);
      if (!binding || !block.rendered || block.isInsertionMarker()) continue;
      bound.add(block.id);
      this.draw_(block, binding);
    }
    for (const [id, badge] of this.badges_) {
      if (!bound.has(id)) {
        badge.remove();
        this.badges_.delete(id);
      }
    }
  }

  draw_(block, binding) {
    let badge = this.badges_.get(block.id);
    const root = block.getSvgRoot();
    const gap = gapOf(block);
    const misfit = revealsFit(this.workspace) && !!gap && isMisfit(gap.state);
    const colour = misfit ? MISFIT_COLOUR : block.getColour();
    const mark = misfit ? '!' : '?';
    if (!badge || badge.parentNode !== root || badge.dataset.colour !== colour || badge.dataset.mark !== mark) {
      badge?.remove();
      badge = createBadge(colour, mark);
      root.appendChild(badge);
      this.badges_.set(block.id, badge);
    }
    const {prompt} = binding.config;
    const question = prompt ? `Question: ${prompt}` : 'Answers a question';
    badge.querySelector('title').textContent = misfit ? `Doesn't fit yet. ${misfitReason(gap)} ${question}` : question;
    badge.setAttribute('transform', `translate(${block.width - RADIUS}, ${-RADIUS + 1})`);
  }
}

/** A white chip ("?" or "!") in the given colour, matching the question block's chip. */
function createBadge(colour, mark) {
  const NS = Blockly.utils.dom.SVG_NS;
  const g = document.createElementNS(NS, 'g');
  g.classList.add(BADGE_CLASS);
  g.dataset.colour = colour;
  g.dataset.mark = mark;
  const title = document.createElementNS(NS, 'title');
  g.appendChild(title);
  const circle = document.createElementNS(NS, 'circle');
  circle.setAttribute('cx', String(RADIUS));
  circle.setAttribute('cy', String(RADIUS));
  circle.setAttribute('r', String(RADIUS));
  circle.setAttribute('fill', '#FFFFFF');
  circle.setAttribute('stroke', colour);
  circle.setAttribute('stroke-width', '1.5');
  g.appendChild(circle);
  const text = document.createElementNS(NS, 'text');
  text.setAttribute('x', String(RADIUS));
  text.setAttribute('y', String(RADIUS + 4));
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('font-family', 'Arial, Helvetica, sans-serif');
  text.setAttribute('font-size', '11');
  text.setAttribute('font-weight', 'bold');
  text.setAttribute('fill', colour);
  text.textContent = mark;
  g.appendChild(text);
  return g;
}
