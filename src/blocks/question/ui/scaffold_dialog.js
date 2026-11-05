/**
 * "Make scaffold" modal for teachers: pick a concept and a level, see how many
 * questions that gives, then turn the program into a scaffold.
 */

import {LearnerLevel, getPolicy} from '../../policy.js';
import {CONCEPTS, makeScaffold, previewScaffold} from '../scaffold/index.js';
import {ModalForm} from './modal_form.js';

const CONCEPT_LABELS = {
  'auto': 'Let the AI decide',
  'variables': 'Variables',
  'input-output': 'Input and output',
  'conditionals': 'Conditionals',
  'loops': 'Loops',
  'lists': 'Lists',
  'text': 'Text',
  'math': 'Math',
  'functions': 'Functions',
};

const KIND_TEXT = {
  [LearnerLevel.BEGINNER]: 'values and single steps',
  [LearnerLevel.INTERMEDIATE]: 'values, single steps and loops or ifs',
  [LearnerLevel.ADVANCED]: 'values, steps, loops or ifs, and runs of steps',
};

export class ScaffoldDialog extends ModalForm {
  /**
   * @param {!Blockly.WorkspaceSvg} workspace
   * @param {{agent?: ?Object, announce?: function(string): void}=} options
   */
  constructor(workspace, options = {}) {
    super();
    this.workspace = workspace;
    this.agent_ = options.agent || null;
    this.announce_ = options.announce || (() => {});
  }

  dispose() {
    this.close_();
  }

  open() {
    this.concept_ = document.createElement('select');
    for (const value of ['auto', ...CONCEPTS]) this.concept_.add(new Option(CONCEPT_LABELS[value], value));
    this.level_ = document.createElement('select');
    for (const value of Object.values(LearnerLevel)) {
      this.level_.add(new Option(value[0].toUpperCase() + value.slice(1), value));
    }
    this.level_.value = getPolicy(this.workspace).learnerLevel;
    this.status_ = this.help_('');
    this.status_.setAttribute('role', 'status');
    this.level_.addEventListener('change', () => this.updatePreview_());

    this.makeButton_ = this.button_('Make scaffold', () => this.make_(), true);
    this.openShell_('Make scaffold', [
      this.help_('Turns the program on the workspace into a partial program: some parts become questions, ' +
          'with the removed blocks kept as each question\'s reference answer. You can review and edit every question, ' +
          'or undo the whole scaffold in one step.'),
      this.labelled_('Key concept', this.concept_, 'Questions go where this concept appears.'),
      this.labelled_('Learner level', this.level_),
      this.status_,
    ], [this.button_('Cancel', () => this.close_()), this.makeButton_]);
    this.updatePreview_();
    this.focusFirst_();
  }

  updatePreview_() {
    const level = this.level_.value;
    const {max, spots} = previewScaffold(this.workspace, level);
    this.canMake_ = max > 0;
    this.makeButton_.setAttribute('aria-disabled', String(!this.canMake_));
    this.status_.textContent = this.canMake_ ?
      `Up to ${max} ${max === 1 ? 'question' : 'questions'} (${KIND_TEXT[level]}), chosen from ${spots.length} possible places.` :
      'Nothing in this program can become a question at this level.';
  }

  async make_() {
    if (!this.canMake_ || this.busy_) return;
    this.busy_ = true;
    this.makeButton_.setAttribute('aria-disabled', 'true');
    this.status_.textContent = 'Making the scaffold…';
    try {
      const concept = this.concept_.value;
      const result = await makeScaffold(this.workspace, {concept, level: this.level_.value, agent: this.agent_});
      this.close_();
      const n = result.questions.length;
      const about = CONCEPT_LABELS[result.concept] && result.concept !== 'auto' ? ` about ${CONCEPT_LABELS[result.concept].toLowerCase()}` : '';
      const note = result.source === 'rules' ? ' The AI was not available, so the questions use simple text; edit them if you like.' : '';
      this.announce_(`Made ${n} ${n === 1 ? 'question' : 'questions'}${about}. Each holds its reference answer in its slot; ` +
          `export the task to hide them from learners.${note}`);
    } catch (e) {
      this.status_.textContent = e?.message || 'The scaffold could not be made.';
      this.makeButton_.setAttribute('aria-disabled', 'false');
    } finally {
      this.busy_ = false;
    }
  }
}
