/**
 * Question block: registry entry wiring the question and its answers into
 * navigation, speech, code generation, and connection rules.
 */

import * as Blockly from 'blockly/core';
import {AnswerBadges} from './badges.js';
import {getBinding, registerBindingEvent} from './binding.js';
import {QUESTION_EDITING_CLASS, defineQuestionBlock} from './definition.js';
import {getPolicy} from '../policy.js';
import {generateQuestion} from './generator.js';
import {QUESTION_TYPE} from './model.js';
import {allowsConnection, evaluatePair, gapOf} from './rules.js';
import {answerFocusSuffix, detailsText, placeholderFocusText, rejectionText} from './speech.js';
import {GapTracker} from './tracker.js';
import {setChipClickHandler} from './shapes.js';
import {SuggestionStars, categoryNote, flyoutNote} from './suggestions.js';
import {POPOVER_CSS, QuestionPopover, popoverFor} from './ui/popover.js';
import {MODAL_FORM_CSS} from './ui/modal_form.js';
import {BLOCK_SELECT_CSS} from './ui/block_select.js';
import {QuestionEditing} from './ui/question_editing.js';
import {Locks} from './locks.js';
import {AiHintService} from './ai_hints.js';
import {ScaffoldDialog} from './ui/scaffold_dialog.js';

/** @type {!WeakMap<!Object, !ScaffoldDialog>} */
const scaffoldDialogs = new WeakMap();

/** Opens the teacher's Make scaffold dialog. @returns {boolean} False before attach. */
export function openScaffoldDialog(workspace) {
  const dialog = scaffoldDialogs.get(workspace);
  dialog?.open();
  return !!dialog;
}

function define() {
  registerBindingEvent();
  defineQuestionBlock();
  Blockly.Css.register(POPOVER_CSS);
  Blockly.Css.register(MODAL_FORM_CSS);
  Blockly.Css.register(BLOCK_SELECT_CSS);
  setChipClickHandler((block) => popoverFor(block.workspace)?.open(block));
}

/**
 * Why `block` cannot be inserted at `target` (a marked connection), if a gap rule forbids it.
 * Mirrors how keyboard insert pairs connections (navigation.insertBlock / connect).
 */
function explainRejection(block, target) {
  const {INPUT_VALUE, NEXT_STATEMENT, PREVIOUS_STATEMENT} = Blockly.ConnectionType;
  let pair = null;
  if (target.type === INPUT_VALUE && block.outputConnection) {
    pair = [target, block.outputConnection];
  } else if (target.type === NEXT_STATEMENT && block.previousConnection) {
    pair = [target, block.previousConnection];
  } else if (target.type === PREVIOUS_STATEMENT && block.previousConnection) {
    pair = target.targetConnection ?
      [target.targetConnection, block.previousConnection] :
      [block.nextConnection, target];
  }
  if (!pair?.[0] || !pair[1]) return null;
  const result = evaluatePair(pair[0], pair[1]);
  if (!result || result.ok) return null;
  return rejectionText(result.config, result, target.getSourceBlock().workspace);
}

/** Enter on a question or an answer: open the popover (rendered workspaces), else read the details. */
function openQuestion(block, config, {workspace, speech}) {
  if (popoverFor(workspace)?.open(block)) return true;
  speech.update(detailsText(config));
  return true;
}

/** @type {!import('../registry.js').CustomBlockType} */
export const questionBlockType = {
  type: QUESTION_TYPE,
  define,
  generate: generateQuestion,
  describe: () => 'question',
  focusText: placeholderFocusText,
  activate: (question, context) => openQuestion(question, question.getQuestionConfig(), context),
  allowsConnection,
  explainRejection,
  // A learner edits a question as a whole: pick a block from the toolbox to replace it.
  editLock: (question) => getPolicy(question.workspace).teacherMode ?
    null :
    'Press T to pick a block that replaces this question, or E to leave Edit mode.',
  onEditTarget(question, editing) {
    const root = question.getSvgRoot?.();
    if (!root) return;
    const on = editing && !getPolicy(question.workspace).teacherMode;
    Blockly.utils.dom[on ? 'addClass' : 'removeClass'](root, QUESTION_EDITING_CLASS);
  },
  attach(workspace, options) {
    const parts = [new GapTracker(workspace, {announce: options?.announce}).attach(), new Locks(workspace).attach()];
    if (workspace.rendered) {
      const editing = new QuestionEditing(workspace).attach();
      parts.push(editing);
      parts.push(new AnswerBadges(workspace).attach());
      parts.push(new SuggestionStars(workspace).attach());
      const scaffold = new ScaffoldDialog(workspace, {agent: options?.agent, announce: options?.announce});
      scaffoldDialogs.set(workspace, scaffold);
      parts.push(scaffold);
      parts.push(new QuestionPopover(workspace, {
        announce: options?.announce,
        aiHints: new AiHintService(options?.agent || null),
        canEdit: (block) => editing.canEdit(block),
        edit: (block) => editing.edit(block),
        onEvent: options?.onEvent,
      }).attach());
    }
    return {dispose: () => parts.forEach((p) => p.dispose())};
  },
  // Blocks that answer a question keep its details reachable.
  decorator: {
    focusSuffix(block) {
      if (!getBinding(block)) return null;
      return answerFocusSuffix(gapOf(block), block.workspace);
    },
    activate(block, context) {
      const binding = getBinding(block);
      return binding ? openQuestion(block, binding.config, context) : false;
    },
    flyoutNote,
    categoryNote,
  },
};

export {QUESTION_TYPE, ANSWER_INPUT, Expects} from './model.js';
export {updateQuestionConfig} from './definition.js';
export {getBinding} from './binding.js';
export {AnswerState, gapOf} from './rules.js';
export {cleanTaskXml, loadTaskXml, markTaskBlocks, isTaskBlock, workXml} from './task.js';
export {getTaskTests, setTaskTests} from './task_tests.js';
export {assess, learnerRunWarning, questionStatuses} from './check.js';
export {TaskTestsDialog} from './ui/task_tests_dialog.js';
