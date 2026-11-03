/**
 * "Edit question" modal form for teachers. Focus is trapped inside,
 * Esc cancels, and Save applies every change as one undoable step. Keys typed in
 * the form never reach workspace or page shortcuts.
 */

import * as Blockly from 'blockly/core';
import {blockTypeName, withArticle} from '../../block_names.js';
import {updateQuestionConfig} from '../definition.js';
import {ANSWER_INPUT, AiHintLevel, Expects, MAX_AI_HINTS, normalizeConfig} from '../model.js';
import {referenceToSlot} from '../reference.js';
import {SnapshotRenderer, toolboxCatalog} from './snapshots.js';
import {BlockSelect} from './block_select.js';
import {CLS, ModalForm, uid} from './modal_form.js';

export class QuestionDialog extends ModalForm {
  /** @param {!Blockly.WorkspaceSvg} workspace */
  constructor(workspace) {
    super();
    this.workspace = workspace;
    this.snapshots_ = new SnapshotRenderer(workspace);
  }

  dispose() {
    this.close_();
    this.snapshots_.dispose();
  }

  /**
   * Opens the form for a question block.
   * @param {!Blockly.Block} question
   */
  open(question) {
    this.question_ = question;
    const config = question.getQuestionConfig();
    this.openShell_('Edit question', [
      this.kindSection_(config),
      this.textSection_(config),
      this.pickerSection_(config),
      this.referenceSection_(config),
      this.hintsSection_(config),
    ], [this.button_('Cancel', () => this.close_()), this.button_('Save', () => this.save_(), true)]);
    this.updateMinBlocks_();
    this.focusFirst_();
  }

  // ---- Sections ------------------------------------------------------------

  /**
   * The question block's shape is fixed (a value or a statement question), so only
   * the kinds that fit it are offered: a value question is always "a value"; a
   * statement question is one statement or a sequence.
   */
  kindSection_(config) {
    const set = this.fieldset_('What goes in the question block');
    const valueQuestion = config.expects === Expects.VALUE;
    const name = uid('expects');
    const options = [
      [Expects.VALUE, 'A value (e.g. a number or a true or false test)'],
      [Expects.STATEMENT, 'One statement block'],
      [Expects.SEQUENCE, 'A sequence of statement blocks'],
    ];
    for (const [value, text] of options) {
      const label = document.createElement('label');
      label.className = `${CLS}-choice`;
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = name;
      radio.value = value;
      radio.checked = config.expects === value;
      radio.disabled = valueQuestion ? value !== Expects.VALUE : value === Expects.VALUE;
      radio.addEventListener('change', () => this.updateMinBlocks_());
      label.append(radio, text);
      set.appendChild(label);
    }
    set.appendChild(this.help_(valueQuestion ?
      'This is a value question: it fits a value slot, like an if condition.' :
      'This is a statement question: it fits in a stack of blocks.'));
    this.expectsName_ = name;

    this.minBlocks_ = this.input_('number', config.minBlocks);
    this.minBlocks_.min = '1';
    this.minBlocksField_ = this.labelled_('Minimum number of blocks', this.minBlocks_);
    set.appendChild(this.minBlocksField_);
    return set;
  }

  textSection_(config) {
    const set = this.fieldset_('What the learner hears');
    this.prompt_ = this.input_('text', config.prompt);
    this.instruction_ = this.textarea_(config.instruction);
    this.needLabel_ = this.input_('text', config.needLabel || '');
    set.append(
        this.labelled_('Question (short)', this.prompt_),
        this.labelled_('Instruction', this.instruction_),
        this.labelled_('What it requires (optional override)', this.needLabel_,
            'Leave empty to say it from the intended blocks, e.g. "a true or false value".'),
    );
    return set;
  }

  /**
   * Intended blocks: pick a category, then a block from it, and Add. Chosen blocks
   * are listed below with their snapshot and a Remove button.
   */
  pickerSection_(config) {
    const set = this.fieldset_('Intended blocks');
    set.appendChild(this.help_('Only these blocks can answer the question. Choose none to allow any block.'));
    this.catalog_ = toolboxCatalog(this.workspace);
    this.intended_ = [...config.intendedTypes];

    const row = document.createElement('div');
    row.className = `${CLS}-pickrow`;
    this.categorySelect_ = document.createElement('select');
    this.catalog_.forEach((category, i) => this.categorySelect_.add(new Option(category.name, String(i))));
    this.blockSelect_ = new BlockSelect(this.snapshots_, 'Block');
    this.categorySelect_.addEventListener('change', () => this.fillBlockSelect_());
    this.fillBlockSelect_();
    const blockField = document.createElement('div');
    blockField.className = `${CLS}-field`;
    const blockLabel = document.createElement('span');
    blockLabel.textContent = 'Block';
    blockLabel.setAttribute('aria-hidden', 'true'); // the button carries "Block: <name>"
    blockField.append(blockLabel, this.blockSelect_.element);
    row.append(
        this.labelled_('Category', this.categorySelect_),
        blockField,
        this.button_('Add', () => this.addIntended_(this.blockSelect_.value)),
    );
    set.appendChild(row);

    this.chosen_ = document.createElement('ul');
    this.chosen_.className = `${CLS}-chosen`;
    this.chosen_.setAttribute('aria-label', 'Chosen blocks');
    set.appendChild(this.chosen_);
    this.renderChosen_();
    return set;
  }

  fillBlockSelect_() {
    const category = this.catalog_[Number(this.categorySelect_.value)] || this.catalog_[0];
    this.blockSelect_.setItems(category?.items || []);
  }

  addIntended_(type) {
    if (!type || this.intended_.includes(type)) return;
    this.intended_.push(type);
    this.renderChosen_();
  }

  /** @returns {?Object} The first toolbox item of a type (for its snapshot). */
  itemOf_(type) {
    for (const category of this.catalog_) {
      const item = category.items.find((i) => i.type === type);
      if (item) return item;
    }
    return {type};
  }

  renderChosen_() {
    this.chosen_.textContent = '';
    if (!this.intended_.length) {
      const empty = document.createElement('li');
      empty.className = `${CLS}-help`;
      empty.textContent = 'None chosen: any block can answer.';
      this.chosen_.appendChild(empty);
      return;
    }
    for (const type of this.intended_) {
      const chip = document.createElement('li');
      chip.className = `${CLS}-chip`;
      const snapshot = this.snapshots_.snapshot(this.itemOf_(type), 28);
      if (snapshot) chip.appendChild(snapshot);
      const name = document.createElement('span');
      name.textContent = blockTypeName(type);
      const remove = this.button_('Remove', () => {
        this.intended_ = this.intended_.filter((t) => t !== type);
        this.renderChosen_();
        this.blockSelect_.focus();
      });
      remove.setAttribute('aria-label', `Remove ${blockTypeName(type)}`);
      chip.append(name, remove);
      this.chosen_.appendChild(chip);
    }
  }

  referenceSection_(config) {
    const set = this.fieldset_('Reference answer');
    this.referenceAction_ = null;
    if (this.question_.getInputTargetBlock(ANSWER_INPUT)) {
      set.appendChild(this.help_('The block in the question\'s slot is the reference answer. ' +
          'Exporting the task keeps it hidden from learners and empties the slot.'));
      return set;
    }
    if (!config.reference) {
      set.appendChild(this.help_('None yet. Build the answer in the question\'s slot to add one. ' +
          'Choices and scaffolds need it; learners never see it.'));
      return set;
    }
    const picture = this.snapshots_.snapshot(config.reference, 48);
    if (picture) set.appendChild(picture);
    const name = withArticle(blockTypeName(config.reference.type));
    const hidden = `${name[0].toUpperCase()}${name.slice(1)} block, hidden from learners.`;
    const status = this.help_(hidden);
    status.setAttribute('role', 'status');
    const toSlot = this.button_('Put in slot to edit', () => choose('slot'));
    const remove = this.button_('Remove', () => choose('remove'));
    const choose = (action) => {
      this.referenceAction_ = this.referenceAction_ === action ? null : action;
      toSlot.setAttribute('aria-pressed', String(this.referenceAction_ === 'slot'));
      remove.setAttribute('aria-pressed', String(this.referenceAction_ === 'remove'));
      status.textContent = {
        slot: 'It will be put in the slot when you save.',
        remove: 'It will be removed when you save.',
      }[this.referenceAction_] || hidden;
    };
    choose(null);
    const row = document.createElement('div');
    row.className = `${CLS}-hint`;
    row.append(toSlot, remove);
    set.append(row, status);
    return set;
  }

  hintsSection_(config) {
    const set = this.fieldset_('Hints');
    set.appendChild(this.help_('Revealed one at a time, after the learner\'s first answer: written hints first, then AI hints.'));

    const written = this.fieldset_('Written hints');
    this.hintList_ = document.createElement('div');
    written.appendChild(this.hintList_);
    config.hints.forEach((hint) => this.addHint_(hint));
    written.appendChild(this.button_('Add written hint', () => this.addHint_('', true)));

    const ai = this.fieldset_('AI hints');
    this.aiLevel_ = document.createElement('select');
    [[AiHintLevel.OFF, 'Off'],
      [AiHintLevel.NUDGE, 'Up to Nudge: a guiding question, no block names'],
      [AiHintLevel.POINT, 'Up to Point: names the idea or category'],
      [AiHintLevel.KIND, 'Up to Show the kind: names the block, never the full answer'],
    ].forEach(([value, text]) => this.aiLevel_.add(new Option(text, value)));
    this.aiLevel_.value = config.ai.level;
    this.aiCount_ = this.input_('number', config.ai.count);
    this.aiCount_.min = '1';
    this.aiCount_.max = String(MAX_AI_HINTS);
    this.aiNote_ = this.input_('text', config.ai.note);
    this.aiQuiz_ = document.createElement('input');
    this.aiQuiz_.type = 'checkbox';
    this.aiQuiz_.checked = config.ai.allowInQuiz;
    const quizLabel = document.createElement('label');
    quizLabel.className = `${CLS}-choice`;
    quizLabel.append(this.aiQuiz_, 'Also allow AI hints in quizzes');
    this.aiDetails_ = document.createElement('div');
    this.aiDetails_.append(
        this.labelled_('How many AI hints', this.aiCount_),
        this.labelled_('Note for the AI (optional)', this.aiNote_, 'E.g. "focus on greater than". Learners never see it.'),
        quizLabel,
    );
    this.aiLevel_.addEventListener('change', () => this.updateAiDetails_());
    ai.append(this.labelled_('AI help allowed', this.aiLevel_), this.aiDetails_);

    this.offerChoices_ = document.createElement('input');
    this.offerChoices_.type = 'checkbox';
    this.offerChoices_.checked = config.offerChoices;
    const choicesLabel = document.createElement('label');
    choicesLabel.className = `${CLS}-choice`;
    choicesLabel.append(this.offerChoices_, 'Offer choices (interactive hint)');
    const choices = this.fieldset_('Choices');
    choices.append(choicesLabel, this.help_('Learners pick from a few real blocks made from the reference answer. ' +
        'Needs a reference answer; never offered in quizzes.'));

    set.append(written, ai, choices);
    this.updateAiDetails_();
    return set;
  }

  updateAiDetails_() {
    this.aiDetails_.style.display = this.aiLevel_.value === AiHintLevel.OFF ? 'none' : '';
  }

  addHint_(text, focus = false) {
    const row = document.createElement('div');
    row.className = `${CLS}-hint`;
    const area = this.textarea_(text);
    row.appendChild(area);
    const move = (change) => {
      change();
      this.renumberHints_();
    };
    row.append(
        this.button_('Up', () => move(() => row.previousElementSibling &&
            this.hintList_.insertBefore(row, row.previousElementSibling))),
        this.button_('Down', () => move(() => row.nextElementSibling &&
            this.hintList_.insertBefore(row.nextElementSibling, row))),
        this.button_('Remove', () => move(() => row.remove())),
    );
    this.hintList_.appendChild(row);
    this.renumberHints_();
    if (focus) area.focus();
  }

  renumberHints_() {
    [...this.hintList_.children].forEach((row, i) => row.querySelector('textarea').setAttribute('aria-label', `Hint ${i + 1}`));
  }

  // ---- Save / close / keys -------------------------------------------------

  save_() {
    const expects = this.dialog_.querySelector(`input[name="${this.expectsName_}"]:checked`)?.value;
    const config = normalizeConfig({
      expects,
      minBlocks: this.minBlocks_.value,
      intendedTypes: this.intended_,
      needLabel: this.needLabel_.value,
      prompt: this.prompt_.value,
      instruction: this.instruction_.value,
      hints: [...this.hintList_.querySelectorAll('textarea')].map((t) => t.value),
      ai: {
        level: this.aiLevel_.value,
        count: this.aiCount_.value,
        note: this.aiNote_.value,
        allowInQuiz: this.aiQuiz_.checked,
      },
      reference: this.referenceAction_ === 'remove' ? null : this.question_.getQuestionConfig().reference,
      offerChoices: this.offerChoices_.checked,
    });
    // Saving is its own action: one undo step, never merged into an earlier one.
    Blockly.Events.setGroup(true);
    try {
      updateQuestionConfig(this.question_, config);
      if (this.referenceAction_ === 'slot') referenceToSlot(this.question_);
    } finally {
      Blockly.Events.setGroup(false);
    }
    this.close_();
  }

  updateMinBlocks_() {
    const expects = this.dialog_?.querySelector(`input[name="${this.expectsName_}"]:checked`)?.value;
    // style.display, not [hidden]: the field label's display:block rule would override it.
    if (this.minBlocksField_) this.minBlocksField_.style.display = expects === Expects.SEQUENCE ? '' : 'none';
  }
}
