/**
 * Question popover: opened by Enter or a click on a question block or
 * on a block that answers one. Keyboard focus moves into it; keys follow the
 * workspace model (popover_model.js). Non-modal dialog with real buttons and a
 * polite live region; its keys never reach the workspace shortcuts.
 */

import * as Blockly from 'blockly/core';
import {Activity, getPolicy} from '../../policy.js';
import {blockTypes} from '../../registry.js';
import {aiHintLevels} from '../ai_hints.js';
import {getBinding} from '../binding.js';
import {choicesFor, offersChoices} from '../choices.js';
import {ANSWER_INPUT, Expects, QUESTION_TYPE} from '../model.js';
import {blockTypeName} from '../../block_names.js';
import {gapOf, isMisfit, isQuestion} from '../rules.js';
import {addAiHint, aiHintsGiven, isAttempted, revealNextHint, revealedHints, setPendingChoice} from '../session.js';
import {chipImage} from '../shapes.js';
import {detailsText, misfitReason, needPhrase, revealsFit} from '../speech.js';
import {toolboxCatalog} from './snapshots.js';
import {systemVoiceOn} from '../../../output/active.js';
import {PopoverAction, PopoverModel} from './popover_model.js';

const CLS = 'eaf-qp';

export const POPOVER_CSS = `
  .${CLS} {
    position: absolute; z-index: 60; width: 300px; box-sizing: border-box;
    background: #fff; color: #1f2328; border: 1px solid #c9d1d9; border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18); padding: 8px 0 10px;
    font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .${CLS}::before {
    content: ""; position: absolute; left: calc(var(--eaf-qp-arrow-x, 28px) - 8px);
    width: 14px; height: 14px; background: #fff; transform: rotate(45deg);
    border: 1px solid #c9d1d9;
  }
  .${CLS}--below::before { top: -8px; border-right: none; border-bottom: none; }
  .${CLS}--above::before { bottom: -8px; border-left: none; border-top: none; }
  .${CLS}-header { display: flex; align-items: center; gap: 8px; padding: 2px 14px 6px; font-weight: 600; }
  .${CLS}-header img { width: 20px; height: 20px; border-radius: 50%; box-shadow: 0 0 0 2px #EAC452; }
  .${CLS}-row { padding: 6px 14px 6px 11px; border-left: 3px solid transparent; outline: none; }
  .${CLS}-row:focus, .${CLS}-row:focus-within { background: #F4F7FD; border-left-color: #2854C5; }
  .${CLS}-label { display: block; font-size: 11px; font-weight: 600; letter-spacing: 0.04em;
    text-transform: uppercase; color: #57606a; }
  .${CLS}-controls { display: flex; gap: 6px; margin-top: 6px; }
  .${CLS}-btn { font: inherit; font-size: 13px; padding: 3px 10px; border: 1px solid #c9d1d9;
    border-radius: 6px; background: #fff; color: #1f2328; cursor: pointer; }
  .${CLS}-btn:hover { background: #f6f8fa; }
  .${CLS}-btn:focus-visible { outline: 3px solid #2854C5; outline-offset: 1px; }
  .${CLS}-btn[aria-disabled="true"] { color: #8c959f; cursor: default; background: #fff; }
  .${CLS}-hints { margin: 6px 0 0; padding-left: 18px; }
  .${CLS}-hints li { padding: 2px 4px; border-radius: 4px; outline: none; }
  .${CLS}-hints li:focus { outline: 2px solid #2854C5; }
  .${CLS}-live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
`;

/** @type {!WeakMap<!Object, !QuestionPopover>} */
const popovers = new WeakMap();

/** @returns {?QuestionPopover} The popover attached to a workspace, if any. */
export function popoverFor(workspace) {
  return popovers.get(workspace) || null;
}

/** @returns {?{gap: string, config: !Object}} The question behind a question or answer block. */
function questionOf(block) {
  if (isQuestion(block)) return {gap: block.id, config: block.getQuestionConfig()};
  const binding = getBinding(block);
  return binding ? {gap: binding.gap, config: binding.config} : null;
}

export class QuestionPopover {
  /**
   * @param {!Blockly.WorkspaceSvg} workspace
   * @param {{announce?: function(string): void, canEdit?: function(!Blockly.Block): boolean,
   *     edit?: function(!Blockly.Block): void, aiHints?: !Object, onEvent?: function(string, !Object): void}=} options
   *     `edit` opens the teacher form; `aiHints` is an AiHintService; `onEvent` gets hint.opened and hint.shown.
   */
  constructor(workspace, options = {}) {
    this.workspace = workspace;
    this.aiHints_ = options.aiHints || null;
    this.onEvent_ = options.onEvent || (() => {});
    this.thinking_ = false;
    this.announce_ = options.announce || (() => {});
    this.canEdit_ = options.canEdit || (() => false);
    this.edit_ = options.edit || (() => {});
    this.block_ = null;
    this.element_ = null;
    this.model_ = null;
    this.hintIndex_ = -1;
    this.returnFocus_ = null;
    this.changeListener_ = (event) => this.onWorkspaceEvent_(event);
    this.outsidePointer_ = (event) => {
      if (this.element_ && !this.element_.contains(event.target)) this.close({restoreFocus: false});
    };
  }

  /** @returns {!QuestionPopover} */
  attach() {
    popovers.set(this.workspace, this);
    this.workspace.addChangeListener(this.changeListener_);
    this.syncHitAreas_();
    return this;
  }

  /**
   * An invisible rectangle under each question block's drawing, so a click
   * anywhere on it, including its empty slot (a hole in the block's shape),
   * counts as a click on the block. Drop targets are unaffected: Blockly finds
   * them by connection position, not by what is under the pointer.
   */
  syncHitAreas_() {
    for (const block of this.workspace.getBlocksByType(QUESTION_TYPE, false)) {
      if (!block.rendered || block.isInsertionMarker()) continue;
      const root = block.getSvgRoot();
      let hit = root.querySelector(`:scope > .${CLS}-hit`);
      if (!hit) {
        hit = document.createElementNS(Blockly.utils.dom.SVG_NS, 'rect');
        hit.classList.add(`${CLS}-hit`);
        hit.setAttribute('fill', 'transparent');
        root.insertBefore(hit, root.firstChild);
      }
      hit.setAttribute('width', String(block.width));
      hit.setAttribute('height', String(block.height));
    }
  }

  dispose() {
    this.close({restoreFocus: false});
    this.workspace.removeChangeListener(this.changeListener_);
    popovers.delete(this.workspace);
  }

  /** @returns {boolean} */
  isOpen() {
    return !!this.element_;
  }

  /**
   * Opens the popover for a question block or a block answering one, and moves
   * keyboard focus into it.
   * @param {!Blockly.BlockSvg} block
   * @returns {boolean} False if the block has no question.
   */
  open(block) {
    const question = questionOf(block);
    if (!question) return false;
    const wasOpen = this.isOpen();
    if (wasOpen) this.close({restoreFocus: false});
    else this.returnFocus_ = document.activeElement;

    this.block_ = block;
    this.question_ = question;
    this.thinking_ = false;
    this.hintIndex_ = this.givenHints_().length - 1;
    this.onEvent_('hint.opened', {questionId: question.gap});

    this.element_ = document.createElement('div');
    this.element_.className = CLS;
    this.element_.setAttribute('role', 'dialog');
    this.element_.setAttribute('aria-label', 'Question');
    this.element_.addEventListener('keydown', (e) => this.onKeyDown_(e));
    this.workspace.getInjectionDiv().appendChild(this.element_);
    document.addEventListener('pointerdown', this.outsidePointer_, true);

    this.model_ = new PopoverModel([]);
    this.render_();
    this.position_();
    this.focusCurrent_();
    return true;
  }

  /** @param {{restoreFocus?: boolean}=} options */
  close({restoreFocus = true} = {}) {
    if (!this.element_) return;
    document.removeEventListener('pointerdown', this.outsidePointer_, true);
    this.element_.remove();
    this.element_ = null;
    this.block_ = null;
    const target = this.returnFocus_;
    this.returnFocus_ = null;
    if (restoreFocus && target?.isConnected && typeof target.focus === 'function') target.focus();
  }

  // ---- Rendering ---------------------------------------------------------

  /** Builds the rows from the question and its session state. */
  rows_() {
    const {config, gap} = this.question_;
    const rows = [{id: 'need', controls: 0, label: 'Needs', text: `${capitalize(needPhrase(config))}.`}];
    // Practice: say plainly when the current answer doesn't fit yet.
    const answer = isQuestion(this.block_) ? null : gapOf(this.block_);
    if (answer && revealsFit(this.workspace) && isMisfit(answer.state)) {
      rows.push({id: 'fit', controls: 0, label: 'Your answer', text: `Doesn't fit yet. ${misfitReason(answer)}`});
    }
    if (config.prompt) rows.push({id: 'prompt', controls: 0, label: 'Prompt', text: config.prompt});
    if (config.instruction) rows.push({id: 'instruction', controls: 0, label: 'Instruction', text: config.instruction});

    const total = this.totalHints_();
    const given = this.givenHints_();
    const choices = this.hasChoices_();
    let hintText;
    if (!total && !choices) hintText = 'This question has no hints.';
    else if (!total) hintText = isAttempted(this.workspace, gap) ?
      'Choose Show choices to pick from a few blocks.' :
      'Hints unlock after your first answer.';
    else if (!isAttempted(this.workspace, gap)) hintText = 'Hints unlock after your first answer.';
    else if (this.thinking_) hintText = 'Thinking of a hint…';
    else if (this.hintIndex_ < 0) hintText = `${total} ${total === 1 ? 'hint is' : 'hints are'} available. Choose Next hint.`;
    else hintText = this.hintLabel_(this.hintIndex_);
    rows.push({id: 'hints', controls: choices ? 3 : 2, details: given.length, label: 'Hints', text: hintText});

    rows.push({id: 'actions', controls: this.canEdit_(this.block_) ? 3 : 2, label: 'Actions', text: ''});
    return rows;
  }

  render_() {
    const rows = this.rows_();
    this.model_.setRows(rows);
    const el = this.element_;
    el.textContent = '';

    const header = document.createElement('div');
    header.className = `${CLS}-header`;
    const chip = document.createElement('img');
    chip.src = chipImage();
    chip.alt = '';
    header.append(chip, 'Question');
    el.appendChild(header);

    rows.forEach((row, index) => el.appendChild(this.renderRow_(row, index)));

    const live = document.createElement('div');
    live.className = `${CLS}-live`;
    live.setAttribute('aria-live', 'polite');
    el.appendChild(live);
    this.live_ = live;
  }

  renderRow_(row, index) {
    const div = document.createElement('div');
    div.className = `${CLS}-row`;
    div.tabIndex = -1;
    div.dataset.row = String(index);
    div.setAttribute('role', 'group');
    div.setAttribute('aria-label', row.text ? `${row.label}. ${row.text}` : row.label);

    const label = document.createElement('span');
    label.className = `${CLS}-label`;
    label.textContent = row.label;
    label.setAttribute('aria-hidden', 'true');
    div.appendChild(label);
    if (row.text) {
      const text = document.createElement('div');
      text.textContent = row.text;
      text.setAttribute('aria-hidden', 'true');
      div.appendChild(text);
    }

    if (row.id === 'hints') {
      const {gap} = this.question_;
      const given = this.givenHints_();
      const canPrev = this.hintIndex_ > 0 && !this.thinking_;
      const canNext = isAttempted(this.workspace, gap) && !this.thinking_ && given.length < this.totalHints_();
      const buttons = [
        this.button_('Previous hint', canPrev, () => this.showHint_(this.hintIndex_ - 1)),
        this.button_('Next hint', canNext, () => this.nextHint_()),
      ];
      if (this.hasChoices_()) {
        buttons.push(this.button_('Show choices', offersChoices(this.workspace, this.question_), () => this.showChoices_()));
      }
      div.appendChild(this.controls_(buttons));
      if (row.details) {
        const list = document.createElement('ol');
        list.className = `${CLS}-hints`;
        list.setAttribute('aria-label', 'Revealed hints');
        given.forEach((hint, i) => {
          const item = document.createElement('li');
          item.tabIndex = -1;
          item.textContent = hint.ai ? `AI hint: ${hint.text}` : hint.text;
          item.setAttribute('aria-label', `${hint.ai ? 'AI hint' : 'Hint'} ${i + 1}: ${hint.text}`);
          list.appendChild(item);
        });
        div.appendChild(list);
      }
    } else if (row.id === 'actions') {
      const buttons = [this.button_('Hear all', true, () => this.announce_(this.fullText_()))];
      if (this.canEdit_(this.block_)) {
        buttons.push(this.button_('Edit question', true, () => {
          const block = this.block_;
          this.close({restoreFocus: false});
          this.edit_(block);
        }));
      }
      buttons.push(this.button_('Close', true, () => this.close()));
      div.appendChild(this.controls_(buttons));
    }
    return div;
  }

  controls_(buttons) {
    const wrap = document.createElement('div');
    wrap.className = `${CLS}-controls`;
    buttons.forEach((b) => wrap.appendChild(b));
    return wrap;
  }

  button_(text, enabled, onActivate) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${CLS}-btn`;
    button.textContent = text;
    // aria-disabled (not disabled) keeps the button reachable with A/D and Tab.
    if (!enabled) button.setAttribute('aria-disabled', 'true');
    button.addEventListener('click', () => {
      if (enabled) onActivate();
    });
    return button;
  }

  fullText_() {
    const hint = this.hintIndex_ >= 0 ? ` ${this.hintLabel_(this.hintIndex_)}` : '';
    return detailsText(this.question_.config) + hint;
  }

  // ---- Choices (interactive hint) ------------------------------------------

  /** Whether this question has choices at all (the button shows, maybe still locked). */
  hasChoices_() {
    const {config} = this.question_;
    return !!config.reference && config.offerChoices && !!blockTypes.navigationHost() &&
      getPolicy(this.workspace).activity !== Activity.QUIZ;
  }

  /** Where a picked block goes, and where keyboard Edit mode starts. */
  choiceTarget_() {
    if (isQuestion(this.block_)) {
      return {target: this.block_.getInput(ANSWER_INPUT).connection, anchor: this.block_, members: []};
    }
    const {members} = gapOf(this.block_);
    const last = members[members.length - 1];
    // A value answer is replaced; statements are added after the answer so far.
    return last.outputConnection ?
      {target: last.outputConnection.targetConnection, anchor: last, members} :
      {target: last.nextConnection, anchor: last, members};
  }

  /**
   * The answer blocks a picked choice replaces: a value answer; statements that
   * aren't intended; in a sequence, everything from the first step that differs
   * from the reference.
   */
  wrongAnswerBlocks_(members) {
    const {config} = this.question_;
    if (!members.length) return [];
    if (config.expects === Expects.VALUE) return members;
    if (config.expects === Expects.STATEMENT) return members.filter((b) => !config.intendedTypes.includes(b.type));
    const chain = [];
    for (let b = config.reference; b; b = b.next?.block) chain.push(b.type);
    const firstWrong = members.findIndex((b, i) => b.type !== chain[i]);
    return firstWrong < 0 ? [] : members.slice(firstWrong);
  }

  showChoices_() {
    const {target, anchor, members} = this.choiceTarget_();
    const variables = this.workspace.getAllVariables().map((v) => ({id: v.getId(), name: v.name, type: v.type}));
    const items = choicesFor({...this.question_, members}, {catalog: toolboxCatalog(this.workspace), variables});
    if (!items.length || !target) {
      this.announce_('There are no choices for this question right now.');
      return;
    }
    const wrong = this.wrongAnswerBlocks_(members);
    if (wrong.length) {
      setPendingChoice(this.workspace, {
        gap: this.question_.gap,
        remove: wrong.map((b) => b.id),
        names: wrong.map((b) => blockTypeName(b.type)),
        types: new Set(items.map((i) => i.type)),
      });
    }
    const message = this.workspace.keyboardAccessibilityMode ?
      `${items.length} choices. Use W and S to hear them, Enter to put one in the question, Escape to go back.` :
      `${items.length} choices are in the flyout. Drag one into the question.`;
    this.close(); // focus back on the workspace, so its keys drive the flyout
    blockTypes.navigationHost().showChoices(this.workspace, {items, target, anchor, message});
  }

  // ---- Hint ladder: written hints first, then AI hints ------

  /** AI levels this learner may ask for here (empty when AI hints are off). */
  aiLevels_() {
    if (!this.aiHints_) return [];
    return aiHintLevels(this.question_.config, getPolicy(this.workspace).activity);
  }

  totalHints_() {
    return this.question_.config.hints.length + this.aiLevels_().length;
  }

  /** @returns {!Array<{text: string, ai: boolean}>} Hints given so far, in order. */
  givenHints_() {
    const {config, gap} = this.question_;
    const written = config.hints.slice(0, revealedHints(this.workspace, gap)).map((text) => ({text, ai: false}));
    const ai = aiHintsGiven(this.workspace, gap).map((text) => ({text, ai: true}));
    return [...written, ...ai];
  }

  /** "Hint 2 of 4: …" or, for AI hints, "AI hint 3 of 4: …" (AI output is always identified). */
  hintLabel_(index) {
    const hint = this.givenHints_()[index];
    if (!hint) return '';
    return `${hint.ai ? 'AI hint' : 'Hint'} ${index + 1} of ${this.totalHints_()}: ${hint.text}`;
  }

  async nextHint_() {
    const {config, gap} = this.question_;
    if (revealedHints(this.workspace, gap) < config.hints.length) {
      revealNextHint(this.workspace, gap, config.hints.length);
      this.onEvent_('hint.shown', {questionId: gap, level: `written ${revealedHints(this.workspace, gap)}`, ai: false});
      this.showHint_(this.givenHints_().length - 1);
      return;
    }
    const levels = this.aiLevels_();
    const aiGiven = aiHintsGiven(this.workspace, gap);
    if (aiGiven.length >= levels.length) return;

    const block = this.block_;
    this.thinking_ = true;
    this.render_();
    this.focusCurrent_();
    this.say_('Thinking of a hint…');
    const previous = this.givenHints_().map((h) => h.text);
    const level = levels[aiGiven.length];
    const text = await this.aiHints_.generate(block, this.question_, level, previous);
    addAiHint(this.workspace, gap, text);
    this.onEvent_('hint.shown', {questionId: gap, level, ai: true});
    // The popover may have closed or moved to another question meanwhile.
    if (!this.element_ || this.question_?.gap !== gap) return;
    this.thinking_ = false;
    this.showHint_(this.givenHints_().length - 1);
  }

  showHint_(index) {
    if (index < 0 || index >= this.givenHints_().length) return;
    this.hintIndex_ = index;
    this.render_(); // keeps the model's focus in range
    this.focusCurrent_();
    this.say_(this.hintLabel_(index));
  }

  /** The popover's live region for a screen reader; the system voice speaks it instead. */
  say_(text) {
    if (systemVoiceOn()) this.announce_(text);
    else this.live_.textContent = text;
  }

  // ---- Keyboard and focus -----------------------------------------------

  onKeyDown_(event) {
    // Popover keys never reach the workspace shortcuts (Blockly listens on document).
    event.stopPropagation();
    if (event.key === 'Tab' || event.key === 'Enter' || event.key === ' ') return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const result = this.model_.handleKey(event.key);
    if (result.action === PopoverAction.NONE && !result.message) return;
    event.preventDefault();
    if (result.action === PopoverAction.CLOSE) this.close();
    else if (result.action === PopoverAction.FOCUS) this.focusCurrent_();
    if (result.message) this.say_(result.message);
  }

  focusCurrent_() {
    const {row, control, detail} = this.model_.focus;
    const rowEl = this.element_?.querySelector(`[data-row="${row}"]`);
    if (!rowEl) return;
    let target = rowEl;
    if (detail >= 0) target = rowEl.querySelectorAll(`.${CLS}-hints li`)[detail] || rowEl;
    else if (control >= 0) target = rowEl.querySelectorAll(`.${CLS}-btn`)[control] || rowEl;
    target.focus();
  }

  // ---- Workspace coupling -------------------------------------------------

  /**
   * Anchored to the block like a tooltip (decided at M2 review): just below it,
   * or above when there is no room below, with an arrow pointing at the block.
   * Follows the block on scroll and zoom.
   */
  position_() {
    if (!this.element_ || !this.block_) return;
    const box = this.workspace.getInjectionDiv().getBoundingClientRect();
    const rect = this.block_.getSvgRoot().getBoundingClientRect();
    const width = this.element_.offsetWidth || 300;
    const height = this.element_.offsetHeight;
    const gap = 12; // room for the arrow

    const anchorX = rect.left - box.left + Math.min(rect.width / 2, 24);
    const left = Math.min(Math.max(8, anchorX - 28), box.width - width - 8);
    const below = rect.bottom - box.top + gap;
    const fitsBelow = below + height <= box.height - 8;
    const top = fitsBelow ? below : Math.max(8, rect.top - box.top - height - gap);

    this.element_.classList.toggle(`${CLS}--below`, fitsBelow);
    this.element_.classList.toggle(`${CLS}--above`, !fitsBelow);
    const arrowX = Math.min(Math.max(14, anchorX - left), width - 14);
    this.element_.style.setProperty('--eaf-qp-arrow-x', `${arrowX}px`);
    this.element_.style.left = `${left}px`;
    this.element_.style.top = `${top}px`;
  }

  onWorkspaceEvent_(event) {
    if (event.workspaceId !== this.workspace.id) return;
    if (!event.isUiEvent) setTimeout(() => this.syncHitAreas_(), 0);
    if (event.type === Blockly.Events.CLICK && event.targetType === 'block') {
      const block = this.workspace.getBlockById(event.blockId);
      if (block && questionOf(block)) this.open(block);
      return;
    }
    if (!this.element_) return;
    if (event.type === Blockly.Events.VIEWPORT_CHANGE) {
      this.position_();
      return;
    }
    // Close if the block went away or no longer carries the question (e.g. it vanished on answer).
    setTimeout(() => {
      const block = this.block_;
      if (!block) return;
      const gone = block.isDeadOrDying?.() || !this.workspace.getBlockById(block.id);
      if (gone || questionOf(block)?.gap !== this.question_.gap) this.close({restoreFocus: false});
      else this.position_();
    }, 0);
  }
}

function capitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}
