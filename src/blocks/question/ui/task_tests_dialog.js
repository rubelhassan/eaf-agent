/**
 * "Task tests" modal form for teachers: a list of tests, each with inputs
 * (one per line) and the output lines that must be printed, in order. Learners
 * never see it. Save stores the tests on the task; Run tests saves, closes, and
 * asks the host to assess the program on the workspace.
 */

import {getTaskTests, setTaskTests} from '../task_tests.js';
import {CLS, ModalForm} from './modal_form.js';
import {uncoveredQuestions} from '../solved.js';

const lines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean);

export class TaskTestsDialog extends ModalForm {
  /**
   * @param {!Blockly.Workspace} workspace
   * @param {{onRun?: function(): void, onSave?: function(): void,
   *     execute?: function(!Object, !Array<string>): !Promise<!Object>}=} options
   */
  constructor(workspace, options = {}) {
    super();
    this.workspace = workspace;
    this.onRun_ = options.onRun || null;
    this.onSave_ = options.onSave || null;
    this.execute_ = options.execute || null;
  }

  dispose() {
    this.close_();
  }

  open() {
    this.list_ = document.createElement('div');
    const intro = this.help_(
        'Only teachers see these tests. Each test runs the program with its inputs and checks that the ' +
        'expected lines are printed, in this order. Check Exact output to allow no extra or missing lines. ' +
        "A test without expected output is removed when you save. Without tests, questions can't be marked solved in practice.");
    const coverage = this.help_('');
    const add = this.button_('Add test', () => this.addTest_({inputs: [], expectedOutput: []}, true));
    const buttons = [this.button_('Cancel', () => this.close_())];
    if (this.onRun_) buttons.push(this.button_('Run tests', () => this.save_({run: true})));
    buttons.push(this.button_('Save', () => this.save_(), true));

    this.openShell_('Task tests', [intro, coverage, this.list_, add], buttons);
    const dialog = this.dialog_;
    if (this.execute_) void uncoveredQuestions(this.workspace, this.execute_).then((numbers) => {
      if (this.dialog_ === dialog) coverage.textContent = numbers.map((number) => `No test checks question ${number}.`).join(' ');
    }).catch(() => { if (this.dialog_ === dialog) coverage.textContent = 'Could not check test coverage.'; });
    const tests = getTaskTests(this.workspace);
    if (tests.length) tests.forEach((test) => this.addTest_(test));
    else this.addTest_({inputs: [], expectedOutput: []});
    this.focusFirst_();
  }

  /** Appends one test's fields; optionally focuses its inputs. */
  addTest_(test, focus = false) {
    const set = this.fieldset_('');
    set.className = `${CLS}-test`;
    const inputs = this.textarea_(test.inputs.join('\n'));
    const expected = this.textarea_(test.expectedOutput.join('\n'));
    const exact = this.input_('checkbox');
    exact.checked = test.exact === true;
    const exactLabel = document.createElement('label');
    exactLabel.className = `${CLS}-choice`;
    exactLabel.append(exact, 'Exact output');
    const remove = this.button_('Remove test', () => {
      const next = set.nextElementSibling || set.previousElementSibling;
      set.remove();
      this.renumber_();
      (next?.querySelector('textarea') || this.dialog_.querySelector(`.${CLS}-body > button`))?.focus();
    });
    set.append(
        this.labelled_('Inputs, one per line', inputs, 'Answers typed into prompt blocks, in order.'),
        this.labelled_('Expected output, one line each', expected, 'Lines that must be printed, in this order.'),
        exactLabel,
        remove,
    );
    remove.style.marginTop = '8px';
    this.list_.appendChild(set);
    this.renumber_();
    if (focus) inputs.focus();
  }

  renumber_() {
    [...this.list_.children].forEach((set, i) => {
      set.querySelector('legend').textContent = `Test ${i + 1}`;
      set.querySelector('button').setAttribute('aria-label', `Remove test ${i + 1}`);
    });
  }

  save_({run = false} = {}) {
    const tests = [...this.list_.children].map((set) => {
      const [inputs, expected] = set.querySelectorAll('textarea');
      return {inputs: lines(inputs.value), expectedOutput: lines(expected.value),
        exact: set.querySelector('input[type="checkbox"]').checked};
    });
    setTaskTests(this.workspace, tests);
    this.close_();
    this.onSave_?.();
    if (run) this.onRun_?.();
  }
}
