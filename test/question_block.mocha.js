/**
 * Unit tests for the question block (documentation/specs/question-block.md).
 * Run with `npm test` (headless Blockly under Node).
 */

import {assert} from 'chai';
import * as Blockly from 'blockly/core';
import 'blockly/blocks';
import * as En from 'blockly/msg/en';
import {javascriptGenerator} from 'blockly/javascript';
import {pythonGenerator} from 'blockly/python';

import {
  Activity,
  LearnerLevel,
  getPolicy,
  attachCustomBlocks,
  blockTypes,
  registerCustomBlocks,
  setPolicy,
  withConnectionRulesSuspended,
} from '../src/blocks/index.js';
import {ANSWER_INPUT, Expects, QUESTION_TYPE, normalizeConfig} from '../src/blocks/question/model.js';
import {getBinding} from '../src/blocks/question/binding.js';
import {AnswerState, chainFrom, gapOf} from '../src/blocks/question/rules.js';
import {needPhrase, placeholderFocusText, detailsText} from '../src/blocks/question/speech.js';
import {updateQuestionConfig} from '../src/blocks/question/definition.js';
import {isAttempted, revealNextHint, revealedHints} from '../src/blocks/question/session.js';
import {categoryNote, flyoutNote, suggestedTypes} from '../src/blocks/question/suggestions.js';
import {PopoverAction, PopoverModel} from '../src/blocks/question/ui/popover_model.js';
import {cleanTaskXml, isTaskBlock, loadTaskXml, markTaskBlocks, workXml} from '../src/blocks/question/task.js';
import {referenceOf, referenceToSlot} from '../src/blocks/question/reference.js';
import {choicesFor, offersChoices} from '../src/blocks/question/choices.js';
import {makeScaffold, previewScaffold} from '../src/blocks/question/scaffold/index.js';
import {checkScaffold, fallbackScaffold} from '../src/blocks/question/scaffold/request.js';
import {findSpots, gapPlan, rankSpots} from '../src/blocks/question/scaffold/spots.js';
import {markAttempted, setPendingChoice} from '../src/blocks/question/session.js';
import {AiHintService, aiHintLevels, buildHintRequest, checkHint} from '../src/blocks/question/ai_hints.js';
import {createFakeAgentServices} from '../src/agent/fake_services.js';
import {getTaskTests, matchInOrder, runTests, setTaskTests} from '../src/blocks/question/task_tests.js';
import {assess, learnerRunWarning, questionStatuses} from '../src/blocks/question/check.js';

Blockly.setLocale(En);

const {connectionChecker} = registerCustomBlocks({
  generators: {javascript: javascriptGenerator, python: pythonGenerator},
});

/** Connects a child connection to a parent connection and reports whether it took. */
function tryConnect(parentConnection, childConnection) {
  parentConnection.connect(childConnection);
  return parentConnection.targetConnection === childConnection;
}

/** Lets Blockly fire queued events and the gap tracker process them. */
async function settle() {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

suite('Question block', function() {
  let ws;
  let attachment;
  let spoken;

  setup(async function() {
    ws = new Blockly.Workspace(new Blockly.Options({plugins: {connectionChecker}}));
    spoken = [];
    attachment = attachCustomBlocks(ws, {announce: (text) => spoken.push(text)});
  });

  teardown(function() {
    attachment.dispose();
    ws.dispose();
  });

  function question(config = {}) {
    const block = ws.newBlock(QUESTION_TYPE);
    block.setQuestionConfig(config);
    return block;
  }

  /**
   * Builds a structure as a teacher would (placing a placeholder under a block
   * looks, to the learner rules, like that block arriving above the placeholder).
   */
  async function asTeacher(build) {
    setPolicy(ws, {teacherMode: true});
    try {
      const result = build();
      await settle(); // the gap tracker processes the build as teacher edits
      return result;
    } finally {
      setPolicy(ws, {teacherMode: false});
    }
  }

  /** repeat { print A; ?; print B } with the question configured as given. */
  function stackWithStatementQuestion(config = {}) {
    return asTeacher(() => {
      const repeat = ws.newBlock('controls_repeat_ext');
      const a = ws.newBlock('text_print');
      const q = question({expects: Expects.STATEMENT, ...config});
      const b = ws.newBlock('text_print');
      tryConnect(repeat.getInput('DO').connection, a.previousConnection);
      tryConnect(a.nextConnection, q.previousConnection);
      tryConnect(q.nextConnection, b.previousConnection);
      return {repeat, a, q, b};
    });
  }

  suite('model', function() {
    test('normalizes malformed input to safe defaults', async function() {
      const config = normalizeConfig({
        expects: 'bogus',
        minBlocks: -3,
        intendedTypes: ['text_print', 'text_print', '', 5],
        hints: ['  first  ', ''],
      });
      assert.equal(config.expects, Expects.VALUE);
      assert.equal(config.minBlocks, 1);
      assert.deepEqual(config.intendedTypes, ['text_print']);
      assert.deepEqual(config.hints, ['first']);
    });
  });

  suite('shapes', function() {
    test('value question: gold, output, one value slot', async function() {
      const q = question();
      assert.exists(q.outputConnection);
      assert.equal(q.getColour().toLowerCase(), '#eac452');
      assert.deepEqual(q.inputList.map((i) => i.name), [ANSWER_INPUT]);
      assert.equal(q.getInput(ANSWER_INPUT).type, Blockly.inputs.inputTypes.VALUE);
    });

    test('statement and sequence questions: gold, top/bottom, a statement slot', async function() {
      for (const expects of [Expects.STATEMENT, Expects.SEQUENCE]) {
        const q = question({expects});
        assert.notExists(q.outputConnection);
        assert.exists(q.previousConnection);
        assert.exists(q.nextConnection);
        assert.equal(q.getColour().toLowerCase(), '#eac452');
        assert.equal(q.getInput(ANSWER_INPUT).type, Blockly.inputs.inputTypes.STATEMENT);
      }
    });

    test('refuses to reshape while attached and keeps the old config', async function() {
      const print = ws.newBlock('text_print');
      const q = question();
      assert.isTrue(tryConnect(print.getInput('TEXT').connection, q.outputConnection));
      assert.isFalse(q.setQuestionConfig({expects: Expects.STATEMENT}));
      assert.equal(q.getQuestionConfig().expects, Expects.VALUE);
    });
  });

  suite('serialization', function() {
    test('round-trips every field through readable XML', async function() {
      const config = {
        expects: Expects.STATEMENT,
        intendedTypes: ['text_print'],
        needLabel: 'a greeting',
        prompt: 'Greet the user',
        instruction: 'Use print & text <carefully>.',
        hints: ['Look in Text'],
      };
      question(config);
      const text = Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(ws));
      assert.include(text, '<intended type="text_print"></intended>');
      ws.clear();
      Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(text), ws);
      assert.deepEqual(ws.getBlocksByType(QUESTION_TYPE)[0].getQuestionConfig(), normalizeConfig(config));
    });

    test('reads a hand-written statement question from XML', async function() {
      Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(
          '<xml xmlns="https://developers.google.com/blockly/xml">' +
          '<block type="question"><mutation expects="sequence" min_blocks="2">' +
          '<intended type="text_print"/><prompt>Say hello twice</prompt></mutation></block></xml>'), ws);
      const loaded = ws.getBlocksByType(QUESTION_TYPE)[0];
      assert.equal(loaded.getQuestionConfig().minBlocks, 2);
      assert.exists(loaded.previousConnection);
    });
  });

  suite('connection rules (learners)', function() {
    test('a value placeholder takes a non-intended block, which does not fit yet', async function() {
      const ifBlock = ws.newBlock('controls_if');
      tryConnect(ifBlock.getInput('IF0').connection, question({intendedTypes: ['logic_compare']}).outputConnection);
      await settle();
      const boolean = ws.newBlock('logic_boolean');
      assert.isTrue(tryConnect(ifBlock.getInput('IF0').connection, boolean.outputConnection));
      await settle();
      assert.lengthOf(ws.getBlocksByType(QUESTION_TYPE), 0);
      assert.equal(gapOf(boolean).state, AnswerState.MISMATCH);
    });

    test('any statement placed right above a statement placeholder fills it', async function() {
      const {a} = await stackWithStatementQuestion({intendedTypes: ['text_print']});
      const set = ws.newBlock('variables_set');
      assert.isTrue(tryConnect(a.nextConnection, set.previousConnection));
      await settle();
      assert.equal(gapOf(set).state, AnswerState.MISMATCH);
    });

    test('a block dropped right below an empty statement question answers it', async function() {
      const {repeat, q} = await asTeacher(() => {
        const repeat = ws.newBlock('controls_repeat_ext');
        const q = question({expects: Expects.STATEMENT, intendedTypes: ['text_print']});
        tryConnect(repeat.getInput('DO').connection, q.previousConnection);
        return {repeat, q};
      });
      const print = ws.newBlock('text_print');
      assert.isTrue(tryConnect(q.nextConnection, print.previousConnection));
      await settle();
      assert.lengthOf(ws.getBlocksByType(QUESTION_TYPE), 0);
      assert.strictEqual(repeat.getInputTargetBlock('DO'), print, 'the answer takes the question\'s place');
      assert.equal(gapOf(print).state, AnswerState.SATISFIED);
    });

    test('in a quiz, dropping below a question answers it instead of touching the locked task', async function() {
      const {q} = await asTeacher(() => {
        const repeat = ws.newBlock('controls_repeat_ext');
        const q = question({expects: Expects.STATEMENT, intendedTypes: ['text_print']});
        tryConnect(repeat.getInput('DO').connection, q.previousConnection);
        return {repeat, q};
      });
      markTaskBlocks(ws);
      setPolicy(ws, {activity: Activity.QUIZ});
      const print = ws.newBlock('text_print');
      assert.isTrue(tryConnect(q.nextConnection, print.previousConnection));
      await settle();
      assert.isNotNull(getBinding(print));
    });

    test('a non-intended stack dropped onto a loose placeholder fills it, not fitting yet', async function() {
      const q = question({expects: Expects.SEQUENCE, intendedTypes: ['text_print']});
      await settle();
      const top = ws.newBlock('text_print');
      tryConnect(top.nextConnection, ws.newBlock('variables_set').previousConnection);
      tryConnect(top.getNextBlock().nextConnection, q.previousConnection);
      await settle();
      assert.lengthOf(ws.getBlocksByType(QUESTION_TYPE), 0);
      assert.equal(gapOf(top).state, AnswerState.MISMATCH, 'every block of a sequence must be intended');
    });

    test('blocks nested inside an answer are unrestricted', async function() {
      const ifBlock = ws.newBlock('controls_if');
      tryConnect(ifBlock.getInput('IF0').connection, question({intendedTypes: ['logic_compare']}).outputConnection);
      const compare = ws.newBlock('logic_compare');
      tryConnect(ifBlock.getInput('IF0').connection, compare.outputConnection);
      assert.isTrue(tryConnect(compare.getInput('A').connection, ws.newBlock('math_number').outputConnection));
    });

    test('a question cannot answer another question', async function() {
      const ifBlock = ws.newBlock('controls_if');
      tryConnect(ifBlock.getInput('IF0').connection, question().outputConnection);
      assert.isFalse(tryConnect(ifBlock.getInput('IF0').connection, question().outputConnection));
    });

    test('teachers are not restricted', async function() {
      const {a} = await stackWithStatementQuestion({intendedTypes: ['text_print']});
      setPolicy(ws, {teacherMode: true});
      assert.isTrue(tryConnect(a.nextConnection, ws.newBlock('variables_set').previousConnection));
    });

    test('rules can be suspended for loading files', async function() {
      const ifBlock = ws.newBlock('controls_if');
      tryConnect(ifBlock.getInput('IF0').connection, question({intendedTypes: ['logic_compare']}).outputConnection);
      assert.isTrue(withConnectionRulesSuspended(() =>
        tryConnect(ifBlock.getInput('IF0').connection, ws.newBlock('logic_boolean').outputConnection)));
    });
  });

  suite('answering through the slot (the question vanishes)', function() {
    test('a value answer docks where the question was', async function() {
      const ifBlock = ws.newBlock('controls_if');
      const q = question({intendedTypes: ['logic_compare'], prompt: 'Too heavy?'});
      const gap = q.id;
      tryConnect(ifBlock.getInput('IF0').connection, q.outputConnection);
      await settle();

      const compare = ws.newBlock('logic_compare');
      tryConnect(q.getInput(ANSWER_INPUT).connection, compare.outputConnection);
      await settle();

      assert.lengthOf(ws.getBlocksByType(QUESTION_TYPE), 0, 'question vanished');
      assert.strictEqual(ifBlock.getInputTargetBlock('IF0'), compare, 'answer docked in the if condition');
      assert.equal(getBinding(compare).gap, gap);
      assert.include(spoken, 'Question answered with a compare block.');
    });

    test('a statement answer docks in the stack, keeping the blocks around it', async function() {
      const {a, q, b} = await stackWithStatementQuestion({intendedTypes: ['text_print']});
      const answer = ws.newBlock('text_print');
      tryConnect(q.getInput(ANSWER_INPUT).connection, answer.previousConnection);
      await settle();

      assert.lengthOf(ws.getBlocksByType(QUESTION_TYPE), 0);
      assert.strictEqual(a.getNextBlock(), answer);
      assert.strictEqual(answer.getNextBlock(), b);
      assert.isNotNull(getBinding(answer));
      assert.isNull(getBinding(b), 'the block below did not join');
    });

    test('a stack put in a sequence slot docks as a whole', async function() {
      const {a, q, b} = await stackWithStatementQuestion({expects: Expects.SEQUENCE});
      const first = ws.newBlock('text_print');
      const second = ws.newBlock('text_print');
      tryConnect(first.nextConnection, second.previousConnection);
      tryConnect(q.getInput(ANSWER_INPUT).connection, first.previousConnection);
      await settle();

      assert.deepEqual([a.getNextBlock(), first.getNextBlock(), second.getNextBlock()], [first, second, b]);
      assert.equal(getBinding(first).gap, getBinding(second).gap);
      assert.include(spoken, 'Question answered with 2 blocks.');
    });

    test('a loose question leaves its answer where it stood', async function() {
      const q = question();
      q.moveBy(100, 50);
      await settle();
      const compare = ws.newBlock('logic_compare');
      tryConnect(q.getInput(ANSWER_INPUT).connection, compare.outputConnection);
      await settle();
      assert.lengthOf(ws.getBlocksByType(QUESTION_TYPE), 0);
      assert.isNull(compare.getParent());
      assert.deepEqual(compare.getRelativeToSurfaceXY(), new Blockly.utils.Coordinate(100, 50));
    });

    test('the slot takes a non-intended block and says why it does not fit (practice)', async function() {
      const q = question({intendedTypes: ['logic_compare'], hints: ['Compare two numbers.']});
      await settle();
      const boolean = ws.newBlock('logic_boolean');
      assert.isNull(blockTypes.explainRejection(boolean, q.getInput(ANSWER_INPUT).connection));
      assert.isTrue(tryConnect(q.getInput(ANSWER_INPUT).connection, boolean.outputConnection));
      await settle();
      assert.equal(gapOf(boolean).state, AnswerState.MISMATCH);
      assert.include(spoken, 'Placed a true or false block. This doesn\'t answer the question yet. ' +
          'It needs a true or false value, like a compare block. Press Enter on it for hints.');
      assert.isTrue(isAttempted(ws, gapOf(boolean).gap), 'a misfit counts as a try, so hints unlock');
    });

    test('a quiz does not reveal that an answer does not fit', async function() {
      setPolicy(ws, {activity: Activity.QUIZ});
      const q = question({intendedTypes: ['logic_compare']});
      await settle();
      const boolean = ws.newBlock('logic_boolean');
      tryConnect(q.getInput(ANSWER_INPUT).connection, boolean.outputConnection);
      await settle();
      assert.include(spoken, 'Question answered with a true or false block.');
      assert.notInclude(blockTypes.focusSuffix(boolean), 'does not fit');
    });

    test('removing a docked answer brings the question back', async function() {
      const ifBlock = ws.newBlock('controls_if');
      const q = question({prompt: 'Too heavy?'});
      const gap = q.id;
      tryConnect(ifBlock.getInput('IF0').connection, q.outputConnection);
      await settle();
      const compare = ws.newBlock('logic_compare');
      tryConnect(q.getInput(ANSWER_INPUT).connection, compare.outputConnection);
      await settle();
      compare.unplug();
      await settle();
      assert.equal(ifBlock.getInputTargetBlock('IF0')?.id, gap);
      assert.include(spoken, 'The question is open again.');
    });

    test('in teacher mode the slot just holds the block', async function() {
      setPolicy(ws, {teacherMode: true});
      const q = question();
      const compare = ws.newBlock('logic_compare');
      tryConnect(q.getInput(ANSWER_INPUT).connection, compare.outputConnection);
      await settle();
      assert.strictEqual(q.getInputTargetBlock(ANSWER_INPUT), compare);
      javascriptGenerator.init(ws);
      assert.deepEqual(javascriptGenerator.blockToCode(q), javascriptGenerator.blockToCode(compare),
          'a question holding an answer generates exactly the answer');
    });
  });

  suite('answering at the question\'s spot (fallback)', function() {
    test('a value answer replaces the placeholder and remembers the question', async function() {
      const ifBlock = ws.newBlock('controls_if');
      const q = question({intendedTypes: ['logic_compare'], prompt: 'Too heavy?'});
      const gap = q.id;
      tryConnect(ifBlock.getInput('IF0').connection, q.outputConnection);
      await settle();

      const compare = ws.newBlock('logic_compare');
      tryConnect(ifBlock.getInput('IF0').connection, compare.outputConnection);
      await settle();

      assert.lengthOf(ws.getBlocksByType(QUESTION_TYPE), 0, 'placeholder removed');
      assert.strictEqual(ifBlock.getInputTargetBlock('IF0'), compare);
      assert.equal(getBinding(compare).gap, gap);
      assert.equal(getBinding(compare).config.prompt, 'Too heavy?');
      assert.equal(gapOf(compare).state, AnswerState.SATISFIED);
    });

    test('works for programs built with events off (no earlier snapshot)', async function() {
      Blockly.Events.disable();
      const ifBlock = ws.newBlock('controls_if');
      const q = question({prompt: 'Too heavy?'});
      tryConnect(ifBlock.getInput('IF0').connection, q.outputConnection);
      Blockly.Events.enable();

      const compare = ws.newBlock('logic_compare');
      tryConnect(ifBlock.getInput('IF0').connection, compare.outputConnection);
      await settle();
      assert.lengthOf(ws.getBlocksByType(QUESTION_TYPE), 0);
      assert.equal(getBinding(compare)?.config.prompt, 'Too heavy?');

      compare.unplug();
      await settle();
      assert.equal(ifBlock.getInputTargetBlock('IF0')?.type, QUESTION_TYPE, 'placeholder restored');
    });

    test('answers placed before the tracker ran on the placeholder still fill it', async function() {
      const ifBlock = ws.newBlock('controls_if');
      const q = question({prompt: 'Too heavy?'});
      tryConnect(ifBlock.getInput('IF0').connection, q.outputConnection);
      await new Promise((resolve) => setTimeout(resolve, 0)); // events fired, tracker not yet run
      const compare = ws.newBlock('logic_compare');
      tryConnect(ifBlock.getInput('IF0').connection, compare.outputConnection);
      await settle();
      assert.lengthOf(ws.getBlocksByType(QUESTION_TYPE), 0);
      assert.equal(getBinding(compare)?.gap, q.id);
    });

    test('a statement answer placed above the placeholder replaces it and heals the stack', async function() {
      const {a, q, b} = await stackWithStatementQuestion({intendedTypes: ['text_print']});
      const gap = q.id;
      await settle();
      const answer = ws.newBlock('text_print');
      tryConnect(a.nextConnection, answer.previousConnection);
      await settle();

      assert.lengthOf(ws.getBlocksByType(QUESTION_TYPE), 0);
      assert.strictEqual(a.getNextBlock(), answer);
      assert.strictEqual(answer.getNextBlock(), b, 'the block after the placeholder follows the answer');
      assert.equal(getBinding(answer).gap, gap);
      assert.isNull(getBinding(b), 'the block below is not part of the answer');
    });

    test('a stack dropped onto a loose placeholder\'s top fills it', async function() {
      const q = question({expects: Expects.SEQUENCE});
      await settle();
      const first = ws.newBlock('text_print');
      const second = ws.newBlock('text_print');
      tryConnect(first.nextConnection, second.previousConnection);
      tryConnect(second.nextConnection, q.previousConnection);
      await settle();
      assert.lengthOf(ws.getBlocksByType(QUESTION_TYPE), 0);
      assert.isNotNull(getBinding(first));
      assert.isNotNull(getBinding(second));
    });

    test('blocks placed below an answer join a statement gap', async function() {
      const {a, q} = await stackWithStatementQuestion({expects: Expects.SEQUENCE, minBlocks: 2, intendedTypes: ['text_print']});
      const gap = q.id;
      await settle();
      const first = ws.newBlock('text_print');
      tryConnect(a.nextConnection, first.previousConnection);
      await settle();
      assert.equal(gapOf(first).state, AnswerState.NOT_ENOUGH);

      const second = ws.newBlock('text_print');
      tryConnect(first.nextConnection, second.previousConnection);
      await settle();
      assert.equal(getBinding(second).gap, gap);
      assert.equal(gapOf(first).state, AnswerState.SATISFIED);
    });

    test('practice statement gaps accept any extra blocks after a matching one', async function() {
      const {a} = await stackWithStatementQuestion({intendedTypes: ['text_print']});
      await settle();
      const answer = ws.newBlock('text_print');
      tryConnect(a.nextConnection, answer.previousConnection);
      await settle();
      assert.isTrue(tryConnect(answer.nextConnection, ws.newBlock('variables_set').previousConnection));
    });

    test('quiz statement gaps take exactly one block', async function() {
      setPolicy(ws, {activity: Activity.QUIZ});
      const {a} = await stackWithStatementQuestion({intendedTypes: ['text_print']});
      await settle();
      const answer = ws.newBlock('text_print');
      tryConnect(a.nextConnection, answer.previousConnection);
      await settle();
      assert.isFalse(tryConnect(answer.nextConnection, ws.newBlock('text_print').previousConnection));
    });

    test('removing the answer brings the placeholder back with the same config', async function() {
      const ifBlock = ws.newBlock('controls_if');
      const q = question({intendedTypes: ['logic_compare'], prompt: 'Too heavy?'});
      const gap = q.id;
      tryConnect(ifBlock.getInput('IF0').connection, q.outputConnection);
      await settle();
      const compare = ws.newBlock('logic_compare');
      tryConnect(ifBlock.getInput('IF0').connection, compare.outputConnection);
      await settle();

      compare.unplug();
      await settle();
      const restored = ifBlock.getInputTargetBlock('IF0');
      assert.equal(restored?.type, QUESTION_TYPE);
      assert.equal(restored.id, gap, 'same gap identity');
      assert.equal(restored.getQuestionConfig().prompt, 'Too heavy?');
      assert.isNull(getBinding(compare), 'the removed block no longer answers it');
    });

    test('deleting all statement answers restores the placeholder in place', async function() {
      const {a, b} = await stackWithStatementQuestion({expects: Expects.SEQUENCE});
      await settle();
      const first = ws.newBlock('text_print');
      tryConnect(a.nextConnection, first.previousConnection);
      await settle();
      first.dispose(true);
      await settle();
      assert.equal(a.getNextBlock()?.type, QUESTION_TYPE);
      assert.strictEqual(a.getNextBlock().getNextBlock(), b);
    });

    test('dragging the first of several answers away takes its followers out too', async function() {
      const {a, b} = await stackWithStatementQuestion({expects: Expects.SEQUENCE});
      await settle();
      const first = ws.newBlock('text_print');
      tryConnect(a.nextConnection, first.previousConnection);
      await settle();
      const second = ws.newBlock('text_print');
      tryConnect(first.nextConnection, second.previousConnection);
      await settle();

      first.unplug(); // takes `second` (and the stack below) along
      await settle();
      assert.isNull(getBinding(first));
      assert.isNull(getBinding(second));
      assert.equal(a.getNextBlock()?.type, QUESTION_TYPE, 'placeholder restored');
      assert.isNull(getBinding(b));
    });

    test('an unanswered placeholder the learner deletes is not restored', async function() {
      const ifBlock = ws.newBlock('controls_if');
      const q = question();
      tryConnect(ifBlock.getInput('IF0').connection, q.outputConnection);
      await settle();
      q.dispose();
      await settle();
      assert.isNull(ifBlock.getInputTargetBlock('IF0'));
    });

    test('loading a program never fills placeholders, and keeps answers bound', async function() {
      const {a} = await stackWithStatementQuestion({expects: Expects.SEQUENCE});
      await settle();
      const answer = ws.newBlock('text_print');
      tryConnect(a.nextConnection, answer.previousConnection);
      question({expects: Expects.STATEMENT}); // a second, unanswered placeholder
      await settle();

      const xml = Blockly.Xml.workspaceToDom(ws);
      ws.clear();
      await settle();
      withConnectionRulesSuspended(() => Blockly.Xml.domToWorkspace(xml, ws));
      await settle();

      assert.lengthOf(ws.getBlocksByType(QUESTION_TYPE), 1, 'unanswered placeholder kept, not filled');
      const printsBound = ws.getBlocksByType('text_print').filter((p) => getBinding(p));
      assert.lengthOf(printsBound, 1);
    });

    test('a pasted copy of an answer does not inherit the binding', async function() {
      const ifBlock = ws.newBlock('controls_if');
      tryConnect(ifBlock.getInput('IF0').connection, question().outputConnection);
      await settle();
      const compare = ws.newBlock('logic_compare');
      tryConnect(ifBlock.getInput('IF0').connection, compare.outputConnection);
      await settle();

      Blockly.serialization.blocks.append(Blockly.serialization.blocks.save(compare), ws, {recordUndo: true});
      await settle();
      const bound = ws.getBlocksByType('logic_compare').filter((c) => getBinding(c));
      assert.deepEqual(bound, [compare]);
    });

    test('one undo reverts an answer and its placeholder swap', async function() {
      const ifBlock = ws.newBlock('controls_if');
      tryConnect(ifBlock.getInput('IF0').connection, question().outputConnection);
      await settle();
      ws.clearUndo();

      Blockly.Events.setGroup(true);
      const compare = ws.newBlock('logic_compare');
      tryConnect(ifBlock.getInput('IF0').connection, compare.outputConnection);
      Blockly.Events.setGroup(false);
      await settle();
      assert.lengthOf(ws.getBlocksByType(QUESTION_TYPE), 0);

      ws.undo(false);
      await settle();
      assert.equal(ifBlock.getInputTargetBlock('IF0')?.type, QUESTION_TYPE);
      assert.lengthOf(ws.getAllBlocks(false).filter((x) => getBinding(x)), 0);
    });

    test('in teacher mode placeholders are ordinary blocks', async function() {
      const {a} = await stackWithStatementQuestion();
      setPolicy(ws, {teacherMode: true});
      await settle();
      tryConnect(a.nextConnection, ws.newBlock('text_print').previousConnection);
      await settle();
      assert.lengthOf(ws.getBlocksByType(QUESTION_TYPE), 1);
    });
  });

  suite('keyboard insert', function() {
    // Stand-in for the flyout manager's own shape test.
    const fitsStructurally = (target, block) =>
      target.type === Blockly.ConnectionType.NEXT_STATEMENT ? !!block.previousConnection : !!block.outputConnection;

    test('a value question is not insertable at a statement target (fixed shapes)', async function() {
      const repeat = ws.newBlock('controls_repeat_ext');
      assert.isFalse(blockTypes.isInsertCompatible(question(), repeat.getInput('DO').connection, fitsStructurally));
    });

    test('every shape-compatible block can be inserted at a placeholder\'s socket', async function() {
      const ifBlock = ws.newBlock('controls_if');
      tryConnect(ifBlock.getInput('IF0').connection, question({intendedTypes: ['logic_compare']}).outputConnection);
      const socket = ifBlock.getInput('IF0').connection;
      assert.isTrue(blockTypes.isInsertCompatible(ws.newBlock('logic_boolean'), socket, fitsStructurally));
      assert.isTrue(blockTypes.isInsertCompatible(ws.newBlock('logic_compare'), socket, fitsStructurally));
    });

    test('explains a structural rejection', async function() {
      const ifBlock = ws.newBlock('controls_if');
      tryConnect(ifBlock.getInput('IF0').connection, question({intendedTypes: ['logic_compare']}).outputConnection);
      assert.equal(blockTypes.explainRejection(question(), ifBlock.getInput('IF0').connection),
          'A question cannot answer another question.');
    });

    test('a non-intended statement is not rejected at a statement placeholder\'s top connection', async function() {
      const {q} = await stackWithStatementQuestion({intendedTypes: ['text_print']});
      assert.isNull(blockTypes.explainRejection(ws.newBlock('variables_set'), q.previousConnection));
    });
  });

  suite('code generation', function() {
    const codeOf = (generator) => {
      generator.init(ws);
      return generator.workspaceToCode(ws).trim();
    };

    test('unanswered placeholders generate neutral code', async function() {
      const print = ws.newBlock('text_print');
      tryConnect(print.getInput('TEXT').connection, question().outputConnection);
      assert.equal(codeOf(javascriptGenerator), 'window.alert(null);');
      ws.clear();
      question({expects: Expects.STATEMENT});
      assert.equal(codeOf(pythonGenerator), '# question not answered yet');
    });
  });

  suite('speech', function() {
    test('derives the need from intended blocks', async function() {
      assert.equal(needPhrase(normalizeConfig({intendedTypes: ['logic_compare', 'logic_operation']})),
          'a true or false value, like a compare or and or block');
      assert.equal(needPhrase(normalizeConfig({expects: 'statement', intendedTypes: ['text_print']})), 'a print block');
      assert.equal(needPhrase(normalizeConfig({needLabel: 'the loop count'})), 'the loop count');
    });

    test('placeholder focus line follows the learner level', async function() {
      const q = question({intendedTypes: ['math_number']});
      assert.equal(placeholderFocusText(q), 'Question. Needs a number, like a number block. Press Enter to open the question.');
      setPolicy(ws, {learnerLevel: LearnerLevel.ADVANCED});
      assert.equal(placeholderFocusText(q), 'Question. Needs a number, like a number block.');
    });

    test('an answer block says it answers a question', async function() {
      setPolicy(ws, {learnerLevel: LearnerLevel.ADVANCED});
      const ifBlock = ws.newBlock('controls_if');
      tryConnect(ifBlock.getInput('IF0').connection, question().outputConnection);
      await settle();
      const compare = ws.newBlock('logic_compare');
      tryConnect(ifBlock.getInput('IF0').connection, compare.outputConnection);
      await settle();
      assert.equal(blockTypes.focusSuffix(compare), 'Answers a question.');
      assert.isNull(blockTypes.focusSuffix(ifBlock));
    });

    test('details read the prompt and instruction', async function() {
      assert.equal(detailsText(normalizeConfig({prompt: 'How many times', instruction: 'Pick a number.'})),
          'Question. How many times. Pick a number. It needs a value block.');
    });
  });

  suite('undo', function() {
    test('a config change is one undoable step', async function() {
      const q = question();
      updateQuestionConfig(q, {expects: Expects.STATEMENT});
      await settle();
      ws.undo(false);
      assert.equal(q.getQuestionConfig().expects, Expects.VALUE);
      assert.exists(q.outputConnection);
    });
  });

  suite('hints session (attempt before hint)', function() {
    test('hints stay locked until the question is answered', async function() {
      const ifBlock = ws.newBlock('controls_if');
      const q = question({hints: ['one', 'two']});
      tryConnect(ifBlock.getInput('IF0').connection, q.outputConnection);
      await settle();
      assert.isFalse(isAttempted(ws, q.id));
      assert.equal(revealNextHint(ws, q.id, 2), 0, 'locked');

      tryConnect(q.getInput(ANSWER_INPUT).connection, ws.newBlock('logic_compare').outputConnection);
      await settle();
      assert.isTrue(isAttempted(ws, q.id));
      assert.equal(revealNextHint(ws, q.id, 2), 1);
      assert.equal(revealNextHint(ws, q.id, 2), 2);
      assert.equal(revealNextHint(ws, q.id, 2), 2, 'no more hints');
    });

    test('revealed hints survive the answer being removed and the question restored', async function() {
      const ifBlock = ws.newBlock('controls_if');
      const q = question({hints: ['one', 'two']});
      const gap = q.id;
      tryConnect(ifBlock.getInput('IF0').connection, q.outputConnection);
      await settle();
      const compare = ws.newBlock('logic_compare');
      tryConnect(q.getInput(ANSWER_INPUT).connection, compare.outputConnection);
      await settle();
      revealNextHint(ws, gap, 2);
      compare.unplug();
      await settle();
      assert.equal(ifBlock.getInputTargetBlock('IF0')?.id, gap);
      assert.equal(revealedHints(ws, gap), 1);
      assert.isTrue(isAttempted(ws, gap));
    });
  });

  suite('suggested blocks (marked in place)', function() {
    // Headless workspaces have no marker manager: stand in for the navigation marker.
    const marker = () => {
      let node = null;
      const m = {setCurNode: (n) => (node = n), getCurNode: () => node};
      ws.getMarker = (name) => (name === 'local_marker_1' ? m : null);
      return m;
    };

    test('a marked question slot suggests its intended blocks', async function() {
      const q = question({intendedTypes: ['logic_compare', 'logic_operation']});
      marker().setCurNode(Blockly.ASTNode.createConnectionNode(q.getInput(ANSWER_INPUT).connection));
      assert.deepEqual(suggestedTypes(ws), ['logic_compare', 'logic_operation']);
      assert.equal(flyoutNote(ws.newBlock('logic_compare')), 'suggested');
      assert.isNull(flyoutNote(ws.newBlock('math_number')));
    });

    test('the socket holding a question and the connection above a statement question count too', async function() {
      const ifBlock = ws.newBlock('controls_if');
      const q = question({intendedTypes: ['logic_compare']});
      tryConnect(ifBlock.getInput('IF0').connection, q.outputConnection);
      const m = marker();
      m.setCurNode(Blockly.ASTNode.createConnectionNode(ifBlock.getInput('IF0').connection));
      assert.deepEqual(suggestedTypes(ws), ['logic_compare']);

      const {a} = await stackWithStatementQuestion({intendedTypes: ['text_print']});
      m.setCurNode(Blockly.ASTNode.createConnectionNode(a.nextConnection));
      assert.deepEqual(suggestedTypes(ws), ['text_print']);
    });

    test('categories holding suggested blocks are noted', async function() {
      const q = question({intendedTypes: ['logic_compare']});
      marker().setCurNode(Blockly.ASTNode.createConnectionNode(q.getInput(ANSWER_INPUT).connection));
      const category = (types) => ({getContents: () => types.map((type) => ({kind: 'block', type}))});
      assert.equal(categoryNote(category(['controls_if', 'logic_compare']), ws), 'has suggested blocks');
      assert.isNull(categoryNote(category(['math_number']), ws));
    });

    test('nothing is suggested away from questions', async function() {
      marker().setCurNode(Blockly.ASTNode.createConnectionNode(ws.newBlock('controls_if').getInput('IF0').connection));
      assert.deepEqual(suggestedTypes(ws), []);
    });

    test('names take the right article', function() {
      assert.equal(needPhrase(normalizeConfig({intendedTypes: ['math_arithmetic']})), 'a number, like an arithmetic block');
    });

    test('only beginners get suggestions', async function() {
      const q = question({intendedTypes: ['logic_compare']});
      marker().setCurNode(Blockly.ASTNode.createConnectionNode(q.getInput(ANSWER_INPUT).connection));
      setPolicy(ws, {learnerLevel: LearnerLevel.INTERMEDIATE});
      assert.deepEqual(suggestedTypes(ws), []);
      assert.isNull(flyoutNote(ws.newBlock('logic_compare')));
    });
  });

  suite('popover keyboard model', function() {
    const rows = () => [
      {id: 'need', controls: 0},
      {id: 'prompt', controls: 0},
      {id: 'hints', controls: 2, details: 2},
      {id: 'actions', controls: 2},
    ];

    test('W/S move between rows and stop at the ends', async function() {
      const m = new PopoverModel(rows());
      assert.deepEqual(m.handleKey('w').focus, {row: 0, control: -1, detail: -1});
      m.handleKey('s');
      m.handleKey('S');
      assert.equal(m.focus.row, 2);
      m.handleKey('s');
      m.handleKey('s');
      assert.equal(m.focus.row, 3);
    });

    test('A/D move between controls only in rows that have them', async function() {
      const m = new PopoverModel(rows());
      assert.equal(m.handleKey('d').action, PopoverAction.NONE);
      m.focusRow(2);
      m.handleKey('d');
      assert.equal(m.focus.control, 0);
      m.handleKey('d');
      m.handleKey('d');
      assert.equal(m.focus.control, 1);
      m.handleKey('a');
      assert.equal(m.focus.control, 0);
    });

    test('F goes into the hint list, Q comes out, Q at top level closes', async function() {
      const m = new PopoverModel(rows());
      assert.equal(m.handleKey('f').message, 'Nothing to open here.');
      m.focusRow(2);
      m.handleKey('f');
      assert.deepEqual(m.focus, {row: 2, control: -1, detail: 0});
      m.handleKey('s');
      m.handleKey('s');
      assert.equal(m.focus.detail, 1);
      m.handleKey('q');
      assert.deepEqual(m.focus, {row: 2, control: -1, detail: -1});
      assert.equal(m.handleKey('q').action, PopoverAction.CLOSE);
      assert.equal(new PopoverModel(rows()).handleKey('Escape').action, PopoverAction.CLOSE);
    });
  });

  suite('teacher tools: task files and locks', function() {
    const TASK = '<xml xmlns="https://developers.google.com/blockly/xml" activity="quiz">' +
      '<block type="controls_if" id="if1" x="10" y="10"><value name="IF0">' +
      '<block type="question" id="q1"><mutation expects="value" min_blocks="1"><prompt>Heavy?</prompt></mutation></block>' +
      '</value><statement name="DO0"><block type="text_print" id="p1"></block></statement></block></xml>';

    test('loading a task applies its activity and records its blocks', async function() {
      loadTaskXml(ws, TASK);
      assert.equal(getPolicy(ws).activity, Activity.QUIZ);
      assert.isTrue(isTaskBlock(ws.getBlockById('p1')));
      assert.isTrue(isTaskBlock(ws.getBlockById('q1')));
    });

    test('learners cannot move or delete questions; teachers can', async function() {
      loadTaskXml(ws, TASK);
      await settle();
      const q = ws.getBlockById('q1');
      assert.isFalse(q.isMovable());
      assert.isFalse(q.isDeletable());
      setPolicy(ws, {teacherMode: true});
      assert.isTrue(q.isMovable());
      assert.isTrue(q.isDeletable());
    });

    test('quiz locks task blocks and refuses attaching to them except at a question', async function() {
      loadTaskXml(ws, TASK);
      await settle();
      const print = ws.getBlockById('p1');
      assert.isFalse(print.isMovable());
      assert.isFalse(print.isEditable());
      assert.isFalse(tryConnect(print.nextConnection, ws.newBlock('text_print').previousConnection));
      assert.equal(blockTypes.explainRejection(ws.newBlock('text_print'), print.nextConnection),
          'This part of the program is locked in this quiz. Answer the questions instead.');
      const q = ws.getBlockById('q1');
      assert.isTrue(tryConnect(q.getInput(ANSWER_INPUT).connection, ws.newBlock('logic_compare').outputConnection));
    });

    test('practice does not lock task blocks', async function() {
      loadTaskXml(ws, TASK.replace(' activity="quiz"', ''));
      await settle();
      assert.equal(getPolicy(ws).activity, Activity.PRACTICE);
      assert.isTrue(ws.getBlockById('p1').isMovable());
      assert.isTrue(tryConnect(ws.getBlockById('p1').nextConnection, ws.newBlock('text_print').previousConnection));
    });

    test('blocks added by the learner stay free in a quiz', async function() {
      loadTaskXml(ws, TASK);
      await settle();
      const scratch = ws.newBlock('text_print');
      await settle();
      assert.isTrue(scratch.isMovable());
      assert.isTrue(tryConnect(scratch.nextConnection, ws.newBlock('text_print').previousConnection));
    });

    test('clean export turns answers back into questions and keeps the activity', async function() {
      loadTaskXml(ws, TASK);
      await settle();
      tryConnect(ws.getBlockById('q1').getInput(ANSWER_INPUT).connection, ws.newBlock('logic_compare').outputConnection);
      await settle();
      assert.equal(ws.getBlockById('if1').getInputTargetBlock('IF0').type, 'logic_compare', 'answered live');

      const xml = cleanTaskXml(ws);
      assert.include(xml, 'activity="quiz"');
      assert.include(xml, '<block type="question" id="q1">');
      assert.include(xml, '<prompt>Heavy?</prompt>');
      assert.notInclude(xml, 'logic_compare');
      assert.equal(ws.getBlockById('if1').getInputTargetBlock('IF0').type, 'logic_compare', 'live workspace untouched');
    });

    test('clean export restores a statement question between its neighbours', async function() {
      const {a, q, b} = await stackWithStatementQuestion();
      const gap = q.id;
      tryConnect(q.getInput(ANSWER_INPUT).connection, ws.newBlock('text_print').previousConnection);
      await settle();
      const copy = new Blockly.Workspace();
      withConnectionRulesSuspended(() => Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(cleanTaskXml(ws)), copy));
      const restored = copy.getBlockById(a.id).getNextBlock();
      assert.equal(restored.id, gap);
      assert.equal(restored.getNextBlock().id, b.id);
      copy.dispose();
    });

    test('leaving teacher mode makes the teacher blocks the task (and locks them in a quiz)', async function() {
      setPolicy(ws, {teacherMode: true, activity: Activity.QUIZ});
      const print = ws.newBlock('text_print');
      assert.isFalse(isTaskBlock(print));
      setPolicy(ws, {teacherMode: false});
      assert.isTrue(isTaskBlock(print));
      assert.isFalse(print.isMovable());
    });
  });

  suite('AI hints', function() {
    const aiConfig = (ai, extra = {}) => normalizeConfig({intendedTypes: ['logic_compare'], ai, ...extra});

    test('the ai settings normalize and round-trip through XML', async function() {
      assert.deepEqual(normalizeConfig({ai: {level: 'bogus', count: 99}}).ai,
          {level: 'off', count: 5, note: '', allowInQuiz: false});
      const q = question({ai: {level: 'point', count: 2, note: 'Focus on greater than', allowInQuiz: true}});
      const text = Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(ws));
      assert.include(text, '<ai level="point" count="2" quiz="true">Focus on greater than</ai>');
      ws.clear();
      Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(text), ws);
      assert.deepEqual(ws.getBlocksByType(QUESTION_TYPE)[0].getQuestionConfig().ai, q.getQuestionConfig().ai);
    });

    test('levels escalate to the ceiling and are off in quizzes unless allowed', async function() {
      assert.deepEqual(aiHintLevels(aiConfig({level: 'point', count: 3}), Activity.PRACTICE), ['nudge', 'point', 'point']);
      assert.deepEqual(aiHintLevels(aiConfig({level: 'kind', count: 2}), Activity.PRACTICE), ['nudge', 'point']);
      assert.deepEqual(aiHintLevels(aiConfig({level: 'off'}), Activity.PRACTICE), []);
      assert.deepEqual(aiHintLevels(aiConfig({level: 'nudge', count: 1}), Activity.QUIZ), []);
      assert.deepEqual(aiHintLevels(aiConfig({level: 'nudge', count: 1, allowInQuiz: true}), Activity.QUIZ), ['nudge']);
    });

    test('output is made speech-ready and checked against the level', async function() {
      const config = aiConfig({level: 'kind'});
      assert.deepEqual(checkHint('**Think** about it. What do you *check*? Extra sentence. More.', 'nudge', config),
          {ok: true, text: 'Think about it. What do you check?'});
      assert.isFalse(checkHint('Use weight > 100; done', 'kind', config).ok, 'no code');
      assert.isFalse(checkHint('Use a compare block here.', 'point', config).ok, 'no exact block below kind');
      assert.isTrue(checkHint('Use a compare block here.', 'kind', config).ok);
      assert.isFalse(checkHint('', 'nudge', config).ok);
    });

    test('the request is grounded in the program with the question marked', async function() {
      const print = ws.newBlock('text_print');
      const q = question({prompt: 'What should be printed?', ai: {level: 'point', count: 1, note: 'greeting'}});
      tryConnect(print.getInput('TEXT').connection, q.outputConnection);
      const request = buildHintRequest(q, {gap: q.id, config: q.getQuestionConfig()}, 'nudge', ['earlier hint']);
      assert.include(request.program, '/* QUESTION */');
      assert.equal(request.question.prompt, 'What should be printed?');
      assert.deepEqual(request.previousHints, ['earlier hint']);
      assert.equal(request.teacherNote, 'greeting');
      assert.isNull(request.learnerAnswer);
    });

    test('the service retries a rejected hint once, then falls back, and caches', async function() {
      const q = question({intendedTypes: ['logic_compare'], ai: {level: 'point', count: 2}});
      const question_ = {gap: q.id, config: q.getQuestionConfig()};
      const calls = [];
      const service = new AiHintService({async generateHint(request) {
        calls.push(request.retryReason || 'first');
        return {hint: calls.length === 1 ? 'Use a compare block.' : 'Look in the Logic category.'};
      }});
      assert.equal(await service.generate(q, question_, 'point', []), 'Look in the Logic category.');
      assert.deepEqual(calls, ['first', 'Do not name the exact block at this level.']);
      assert.equal(await service.generate(q, question_, 'point', []), 'Look in the Logic category.');
      assert.lengthOf(calls, 2, 'cached');

      const failing = new AiHintService(createFakeAgentServices({delayMs: 0, unavailable: true}));
      assert.match(await failing.generate(q, question_, 'nudge', []), /\?/, 'safe fallback question');
    });
  });
  suite('run integration and task tests', function() {
    /** if (?) print "Too heavy!" else (?): a value and a statement question. */
    async function goatTask() {
      return asTeacher(() => {
        const ifBlock = ws.newBlock('controls_if');
        ifBlock.loadExtraState?.({hasElse: true});
        const value = question({intendedTypes: ['logic_compare'], prompt: 'Too heavy?'});
        const statement = question({expects: Expects.STATEMENT, intendedTypes: ['text_print']});
        tryConnect(ifBlock.getInput('IF0').connection, value.outputConnection);
        tryConnect(ifBlock.getInput('ELSE').connection, statement.previousConnection);
        return {ifBlock, value, statement};
      });
    }

    async function answer(q, block) {
      const connection = q.getInput(ANSWER_INPUT).connection;
      tryConnect(connection, block.outputConnection || block.previousConnection);
      await settle();
      return block;
    }

    test('expected lines must appear in order; other lines are allowed', function() {
      assert.isTrue(matchInOrder(['b', 'd'], ['a', 'b', 'c', ' d ']).ok);
      assert.deepEqual(matchInOrder(['d', 'b'], ['a', 'b', 'c', 'd']), {ok: false, missing: 'b'});
      assert.deepEqual(matchInOrder(['B'], ['b']), {ok: false, missing: 'B'}, 'case-sensitive');
    });

    test('a test fails with a plain reason', function() {
      const tests = [{inputs: [], expectedOutput: ['x']}];
      const reason = (run) => runTests(tests, () => run)[0].reason;
      assert.equal(reason({lines: ['x']}), '');
      assert.equal(reason({lines: ['y']}), 'Expected "x", but it was not printed.');
      assert.equal(reason({lines: [], timedOut: true}), 'The program ran too long and was stopped.');
      assert.equal(reason({lines: [], outOfInputs: true}), 'The program asked for more inputs than the test gives.');
      assert.equal(reason({lines: [], error: 'boom'}), 'The program stopped with an error: boom');
      assert.equal(runTests(tests, () => {
        throw new Error('crash');
      })[0].reason, 'The program stopped with an error: crash');
    });

    test('tests without expected output are dropped', function() {
      setTaskTests(ws, [{inputs: ['1'], expectedOutput: []}, {inputs: [' 2 '], expectedOutput: ['ok', '']}]);
      assert.deepEqual(getTaskTests(ws), [{inputs: ['2'], expectedOutput: ['ok']}]);
    });

    test('tests travel with the task file, the clean export, and saved work', async function() {
      setTaskTests(ws, [{inputs: ['120'], expectedOutput: ['Too heavy!']}]);
      const {value} = await goatTask();
      await answer(value, ws.newBlock('logic_boolean'));
      const clean = cleanTaskXml(ws);
      const work = workXml(ws);
      assert.include(clean, '<test>');
      assert.include(work, '<output>Too heavy!</output>');

      setTaskTests(ws, []);
      loadTaskXml(ws, work);
      await settle();
      assert.deepEqual(getTaskTests(ws), [{inputs: ['120'], expectedOutput: ['Too heavy!']}]);
      assert.lengthOf(ws.getBlocksByType('logic_boolean'), 1, 'saved work keeps the answers');
      assert.equal(questionStatuses(ws).map((q) => q.state).join(), `${AnswerState.MISMATCH},${AnswerState.EMPTY}`);

      loadTaskXml(ws, clean);
      assert.lengthOf(ws.getBlocksByType(QUESTION_TYPE), 2, 'the clean task has only empty questions');
    });

    test('the learner warning names empty questions first, then answers that do not fit', async function() {
      const {value, statement} = await goatTask();
      assert.equal(learnerRunWarning(ws), '2 question blocks are not answered yet.');
      await answer(value, ws.newBlock('logic_boolean'));
      assert.equal(learnerRunWarning(ws), '1 question block is not answered yet.');
      await answer(statement, ws.newBlock('text_print'));
      assert.equal(learnerRunWarning(ws), '1 answer does not fit its question yet.');
      setPolicy(ws, {activity: Activity.QUIZ});
      assert.isNull(learnerRunWarning(ws), 'a quiz never reveals fit');
    });

    test('a teacher\'s worked answer in a question\'s slot is judged like an answer', async function() {
      setPolicy(ws, {teacherMode: true});
      const q = question({intendedTypes: ['logic_compare']});
      assert.equal(questionStatuses(ws)[0].state, AnswerState.EMPTY);
      tryConnect(q.getInput(ANSWER_INPUT).connection, ws.newBlock('logic_boolean').outputConnection);
      assert.equal(questionStatuses(ws)[0].state, AnswerState.MISMATCH);
      q.getInputTargetBlock(ANSWER_INPUT).dispose();
      tryConnect(q.getInput(ANSWER_INPUT).connection, ws.newBlock('logic_compare').outputConnection);
      assert.equal(questionStatuses(ws)[0].state, AnswerState.SATISFIED);
    });

    test('the assessment reports every question, then the tests', async function() {
      const {value, statement} = await goatTask();
      setTaskTests(ws, [{inputs: ['120'], expectedOutput: ['Too heavy!']}, {inputs: ['80'], expectedOutput: ['Safe']}]);
      const execute = (inputs) => ({lines: inputs[0] === '120' ? ['Too heavy!'] : ['Go']});

      let report = assess(ws, {execute, locate: () => 'stack A, block 1'});
      assert.equal(report.lines[0], 'Questions: 0 of 2 fit.');
      assert.equal(report.lines[1], '  Question 1 (stack A, block 1) "Too heavy?": empty');
      assert.include(report.lines, 'Tests skipped: 2 questions are empty.');

      await answer(value, ws.newBlock('logic_boolean'));
      await answer(statement, ws.newBlock('text_print'));
      report = assess(ws, {execute});
      assert.equal(report.lines[0], 'Questions: 1 of 2 fit.');
      assert.equal(report.lines[1], '  Question 1 "Too heavy?": doesn\'t fit: got a true or false block. ' +
          'It needs a true or false value, like a compare block.');
      assert.equal(report.lines[2], '  Question 2: fits');
      assert.include(report.lines, 'Tests: 1 of 2 pass.');
      assert.include(report.lines, '  Test 1 (inputs: 120): pass');
      assert.include(report.lines, '  Test 2 (inputs: 80): fail. Expected "Safe", but it was not printed.');
      assert.include(report.lines, '    Printed: Go');
      assert.equal(report.summary, 'Questions: 1 of 2 fit. Tests: 1 of 2 pass.');
    });
  });
  suite('reference answers', function() {
    /** A value question inside an if, with a teacher's compare in its slot. */
    async function withTeacherAnswer() {
      return asTeacher(() => {
        const ifBlock = ws.newBlock('controls_if');
        const q = question({intendedTypes: ['logic_compare']});
        tryConnect(ifBlock.getInput('IF0').connection, q.outputConnection);
        const compare = ws.newBlock('logic_compare');
        compare.setFieldValue('GT', 'OP');
        tryConnect(q.getInput(ANSWER_INPUT).connection, compare.outputConnection);
        return {ifBlock, q, compare};
      });
    }

    test('only a block state is kept as a reference', function() {
      assert.isNull(normalizeConfig({reference: 'x'}).reference);
      assert.isNull(normalizeConfig({reference: {fields: {}}}).reference);
      assert.equal(normalizeConfig({reference: {type: 'math_number'}}).reference.type, 'math_number');
    });

    test('the clean export hides the slot\'s answer as the reference and empties the slot', async function() {
      await withTeacherAnswer();
      const xml = cleanTaskXml(ws);
      assert.lengthOf(ws.getBlocksByType('logic_compare'), 1, 'the live workspace is untouched');
      loadTaskXml(ws, xml);
      await settle();
      const q = ws.getBlocksByType(QUESTION_TYPE)[0];
      assert.isNull(q.getInputTargetBlock(ANSWER_INPUT));
      assert.lengthOf(ws.getBlocksByType('logic_compare'), 0);
      assert.equal(referenceOf(q).type, 'logic_compare');
      assert.equal(referenceOf(q).fields.OP, 'GT', 'the reference keeps its values through XML');
    });

    test('a hidden reference can be put back into the slot for editing', async function() {
      await withTeacherAnswer();
      loadTaskXml(ws, cleanTaskXml(ws));
      setPolicy(ws, {teacherMode: true});
      const q = ws.getBlocksByType(QUESTION_TYPE)[0];
      assert.isTrue(referenceToSlot(q));
      assert.equal(q.getInputTargetBlock(ANSWER_INPUT)?.type, 'logic_compare');
      assert.isNull(referenceOf(q));
      assert.isFalse(referenceToSlot(q), 'nothing left to put back');
    });

    test('a learner\'s answer keeps the reference, so the restored question still has it', async function() {
      await withTeacherAnswer();
      loadTaskXml(ws, cleanTaskXml(ws));
      await settle();
      const q = ws.getBlocksByType(QUESTION_TYPE)[0];
      const boolean = ws.newBlock('logic_boolean');
      tryConnect(q.getInput(ANSWER_INPUT).connection, boolean.outputConnection);
      await settle();
      boolean.dispose();
      await settle();
      assert.equal(referenceOf(ws.getBlocksByType(QUESTION_TYPE)[0]).type, 'logic_compare');
    });

    test('the reference never reaches the AI hint request', async function() {
      await withTeacherAnswer();
      loadTaskXml(ws, cleanTaskXml(ws));
      const q = ws.getBlocksByType(QUESTION_TYPE)[0];
      const request = buildHintRequest(q, {gap: q.id, config: q.getQuestionConfig()}, 'point', []);
      assert.notInclude(JSON.stringify(request), 'GT');
      assert.notProperty(request.question, 'reference');
    });
  });
  suite('choices (interactive hint)', function() {
    const catalog = [
      {name: 'Logic', items: [{kind: 'block', type: 'logic_compare'}, {kind: 'block', type: 'logic_boolean'}]},
      {name: 'Math', items: [{kind: 'block', type: 'math_number'}, {kind: 'block', type: 'math_arithmetic'}]},
      {name: 'Text', items: [
        {kind: 'block', type: 'text_print', inputs: {TEXT: {shadow: {type: 'text', fields: {TEXT: 'abc'}}}}},
        {kind: 'block', type: 'text'},
      ]},
      {name: 'Variables', items: [{kind: 'block', type: 'variables_set'}, {kind: 'block', type: 'math_change'}]},
    ];
    const variables = [{id: 'v_n', name: 'number', type: ''}, {id: 'v_w', name: 'weight', type: ''}];
    const numberVar = {type: 'variables_get', fields: {VAR: {id: 'v_n', name: 'number', type: ''}}};
    const plus4 = {type: 'math_arithmetic', fields: {OP: 'ADD'}, inputs: {
      A: {block: numberVar}, B: {block: {type: 'math_number', fields: {NUM: 4}}}}};
    const describe = (item) => {
      const fields = [];
      const walk = (b) => {
        if (!b) return;
        fields.push(b.type.replace(/^\w+?_/, '') + (b.fields?.OP ? `:${b.fields.OP}` : '') + (b.fields?.NUM !== undefined ? `:${b.fields.NUM}` : ''));
        Object.values(b.inputs || {}).forEach((i) => walk(i.block));
      };
      walk(item);
      return fields.join(' ');
    };
    const choices = (config, members = [], gap = 'g1') =>
      choicesFor({gap, config: normalizeConfig(config), members}, {catalog, variables});

    test('a value gets the reference and two wrong variants, in a stable order', function() {
      const items = choices({reference: plus4});
      assert.sameMembers(items.map(describe), [
        'arithmetic:ADD get number:4', 'arithmetic:ADD get number:40', 'arithmetic:MINUS get number:4']);
      assert.deepEqual(choices({reference: plus4}), items, 'deterministic');
      assert.isUndefined(items[0].id, 'fresh blocks, no saved ids');
    });

    test('a comparison flips first', function() {
      const compare = {type: 'logic_compare', fields: {OP: 'GT'}, inputs: {
        A: {block: numberVar}, B: {block: {type: 'math_number', fields: {NUM: 100}}}}};
      assert.sameMembers(choices({reference: compare}).map(describe), [
        'compare:GT get number:100', 'compare:LT get number:100', 'compare:GT get number:10']);
    });

    test('a value with too few rules is topped up with same-type blocks', function() {
      const items = choices({reference: numberVar});
      assert.lengthOf(items, 3);
      assert.include(items.map((i) => i.fields?.VAR?.id), 'v_w', 'another variable');
    });

    test('a control structure offers empty variants of its family', function() {
      const ifElse = {type: 'controls_if', extraState: {hasElse: true}, inputs: {IF0: {block: numberVar}}};
      const items = choices({expects: Expects.STATEMENT, reference: ifElse});
      assert.sameDeepMembers(items, [
        {kind: 'block', type: 'controls_if', extraState: {hasElse: true}},
        {kind: 'block', type: 'controls_if'},
        {kind: 'block', type: 'controls_if', extraState: {elseIfCount: 1, hasElse: true}},
      ]);
    });

    test('a single statement offers its kind with default values plus two other kinds', function() {
      const print = {type: 'text_print', inputs: {TEXT: {block: numberVar}}};
      const items = choices({expects: Expects.STATEMENT, reference: print});
      assert.sameMembers(items.map((i) => i.type), ['text_print', 'variables_set', 'math_change']);
      assert.equal(items.find((i) => i.type === 'text_print').inputs.TEXT.shadow.fields.TEXT, 'abc', 'not the answer');
    });

    test('a sequence offers only the next block it lacks', function() {
      const set = {type: 'variables_set', fields: {VAR: {id: 'v_n'}}, next: {block: {type: 'text_print'}}};
      const config = {expects: Expects.SEQUENCE, minBlocks: 2, reference: set};
      assert.include(choices(config).map((i) => i.type), 'variables_set');
      const placed = [ws.newBlock('variables_set')];
      const next = choices(config, placed);
      assert.include(next.map((i) => i.type), 'text_print');
      assert.lengthOf(next, 3);
      assert.deepEqual(choices(config, [placed[0], ws.newBlock('text_print')]), [], 'nothing left to reveal');
    });

    test('choices need a reference, the teacher\'s consent, practice, and a first try', function() {
      const q = question({reference: plus4});
      const gap = {gap: q.id, config: q.getQuestionConfig()};
      assert.isFalse(offersChoices(ws, gap), 'not tried yet');
      markAttempted(ws, q.id);
      assert.isTrue(offersChoices(ws, gap));
      assert.isFalse(offersChoices(ws, {...gap, config: {...gap.config, offerChoices: false}}));
      setPolicy(ws, {activity: Activity.QUIZ});
      assert.isFalse(offersChoices(ws, gap), 'never in a quiz');
    });

    test('a picked choice replaces the answer that did not fit, in one undo step', async function() {
      const ifBlock = ws.newBlock('controls_if');
      const q = question({intendedTypes: ['logic_compare']});
      tryConnect(ifBlock.getInput('IF0').connection, q.outputConnection);
      await settle();
      const wrong = ws.newBlock('logic_boolean');
      tryConnect(q.getInput(ANSWER_INPUT).connection, wrong.outputConnection);
      await settle();
      setPendingChoice(ws, {gap: gapOf(wrong).gap, remove: [wrong.id], names: ['true or false'], types: new Set(['logic_compare'])});
      const pick = ws.newBlock('logic_compare');
      Blockly.Events.setGroup(true);
      tryConnect(ifBlock.getInput('IF0').connection, pick.outputConnection); // bumps the old answer out
      Blockly.Events.setGroup(false);
      await settle();
      assert.isTrue(wrong.isDisposed(), 'the wrong block is gone, not left loose');
      assert.equal(gapOf(pick).state, AnswerState.SATISFIED);
      assert.include(spoken.at(-1), 'Replaced the true or false block with your choice.');
      ws.undo(false);
      await settle();
      assert.lengthOf(ws.getBlocksByType('logic_boolean'), 1, 'one undo brings the old answer back');
    });

    test('in a sequence only the steps after the right ones are replaced', async function() {
      const {repeat, q} = await asTeacher(() => {
        const repeat = ws.newBlock('controls_repeat_ext');
        const q = question({expects: Expects.SEQUENCE, minBlocks: 2, intendedTypes: ['variables_set', 'text_print'],
          reference: {type: 'variables_set', next: {block: {type: 'text_print'}}}});
        tryConnect(repeat.getInput('DO').connection, q.previousConnection);
        return {repeat, q};
      });
      const set = ws.newBlock('variables_set');
      tryConnect(q.getInput(ANSWER_INPUT).connection, set.previousConnection);
      await settle();
      const wrong = ws.newBlock('math_change');
      tryConnect(set.nextConnection, wrong.previousConnection);
      await settle();
      setPendingChoice(ws, {gap: gapOf(set).gap, remove: [wrong.id], names: ['change'], types: new Set(['text_print'])});
      const print = ws.newBlock('text_print');
      tryConnect(wrong.nextConnection, print.previousConnection);
      await settle();
      assert.isTrue(wrong.isDisposed());
      assert.deepEqual(chainFrom(repeat.getInputTargetBlock('DO')).map((b) => b.type), ['variables_set', 'text_print']);
      assert.equal(gapOf(set).state, AnswerState.SATISFIED);
    });

    test('turning choices off survives XML', function() {
      question({offerChoices: false});
      const text = Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(ws));
      assert.include(text, 'choices="false"');
      ws.clear();
      Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(text), ws);
      assert.isFalse(ws.getBlocksByType(QUESTION_TYPE)[0].getQuestionConfig().offerChoices);
    });
  });
  suite('structured scaffold', function() {
    // Program 18: skip count by 4.
    const PROGRAM_18 = `<xml xmlns="https://developers.google.com/blockly/xml">
      <variables><variable id="var_number">number</variable></variables>
      <block type="text_print" id="print_1" x="20" y="20">
        <value name="TEXT"><block type="text" id="text_1"><field name="TEXT">Let's skip count by 4!</field></block></value>
        <next><block type="variables_set" id="set_1"><field name="VAR" id="var_number">number</field>
          <value name="VALUE"><block type="math_number" id="num_0"><field name="NUM">0</field></block></value>
          <next><block type="controls_repeat_ext" id="repeat_1">
            <value name="TIMES"><block type="math_number" id="num_5"><field name="NUM">5</field></block></value>
            <statement name="DO"><block type="variables_set" id="set_2"><field name="VAR" id="var_number">number</field>
              <value name="VALUE"><block type="math_arithmetic" id="arith_1"><field name="OP">ADD</field>
                <value name="A"><block type="variables_get" id="get_1"><field name="VAR" id="var_number">number</field></block></value>
                <value name="B"><block type="math_number" id="num_4"><field name="NUM">4</field></block></value></block></value>
              <next><block type="text_print" id="print_2">
                <value name="TEXT"><block type="variables_get" id="get_2"><field name="VAR" id="var_number">number</field></block></value></block></next>
            </block></statement>
            <next><block type="text_print" id="print_3">
              <value name="TEXT"><block type="text" id="text_2"><field name="TEXT">Done!</field></block></value></block></next>
          </block></next>
        </block></next>
      </block></xml>`;

    function load() {
      setPolicy(ws, {teacherMode: true});
      loadTaskXml(ws, PROGRAM_18);
    }

    test('spots skip the first statement and never nest a value inside a value', function() {
      load();
      const ids = findSpots(ws).map((s) => s.id);
      assert.notInclude(ids, 's:print_1');
      assert.notInclude(ids, 'v:text_1', 'values of the first statement are setup too');
      assert.include(ids, 'v:arith_1');
      assert.notInclude(ids, 'v:num_4', 'part of a bigger value');
      assert.include(ids, 'c:repeat_1');
      assert.include(ids, 'q:set_2:2');
      const set2 = findSpots(ws).find((s) => s.id === 's:set_2');
      assert.isFalse(set2.covers.has('print_2'), 'a single statement does not include what follows it');
      assert.sameMembers(set2.concepts, ['variables', 'math']);
    });

    test('the gap count follows the level and the program length', function() {
      assert.deepInclude(gapPlan('beginner', 6, 20), {min: 1, max: 1});
      assert.deepInclude(gapPlan('intermediate', 12, 20), {min: 1, max: 2});
      assert.deepInclude(gapPlan('advanced', 30, 20), {min: 2, max: 6});
      assert.deepInclude(gapPlan('advanced', 30, 1), {min: 1, max: 1}, 'never more than there are spots');
      load();
      assert.notInclude(previewScaffold(ws, 'beginner').spots.map((s) => s.kind), 'control');
    });

    test('the rules pick spots of the concept, without overlap', function() {
      load();
      const {spots} = previewScaffold(ws, 'intermediate');
      const gaps = fallbackScaffold(spots, {concept: 'math', gapCount: {min: 1, max: 2}});
      assert.isAtLeast(gaps.length, 1);
      assert.isTrue(gaps.every((g) => g.spot.concepts.includes('math')));
      assert.isEmpty(gaps[0].hints, 'templates come without written hints');
    });

    test('important spots come first: the concept, inside loops, not plain literals', function() {
      load();
      const {spots} = previewScaffold(ws, 'advanced');
      assert.equal(rankSpots(spots, 'math')[0].id, 'v:arith_1', 'number + 4 in the loop, not set number to 0');
      assert.equal(fallbackScaffold(spots, {concept: 'math', gapCount: {min: 1, max: 1}})[0].spot.id, 'v:arith_1');
      assert.equal(rankSpots(spots, 'loops')[0].id, 'c:repeat_1');
    });

    test('agent output is checked against the spots and the rules', function() {
      load();
      const {spots} = previewScaffold(ws, 'advanced');
      const gap = (spotId, extra = {}) => ({spotId, prompt: 'How much?', instruction: 'Think about it.', hints: ['a', 'b'], ...extra});
      const range = {min: 1, max: 2};
      assert.isTrue(checkScaffold({gaps: [gap('v:arith_1')]}, spots, range).ok);
      assert.match(checkScaffold({gaps: [gap('v:nope')]}, spots, range).reason, /Unknown spotId/);
      assert.match(checkScaffold({gaps: [gap('s:set_2'), gap('v:arith_1')]}, spots, range).reason, /share or nest/);
      assert.match(checkScaffold({gaps: [gap('v:arith_1', {prompt: 'Use an arithmetic block.'})]}, spots, range).reason, /exact block/);
      assert.match(checkScaffold({gaps: [gap('v:arith_1', {instruction: 'number = number + 4;'})]}, spots, range).reason, /no code/);
      assert.match(checkScaffold({gaps: []}, spots, range).reason, /between 1 and 2/);
    });

    test('making a scaffold wraps the chosen parts, keeping them as reference answers, in one undo step', async function() {
      load();
      const before = Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(ws));
      const agent = createFakeAgentServices({delayMs: 0});
      const result = await makeScaffold(ws, {concept: 'loops', level: 'advanced', agent});
      assert.equal(result.source, 'agent');
      assert.isAtLeast(result.questions.length, 1);
      for (const q of result.questions) {
        assert.isNotNull(q.getInputTargetBlock(ANSWER_INPUT), 'the removed part sits in the slot');
        assert.lengthOf(q.getQuestionConfig().hints, 2);
      }
      await settle();
      ws.undo(false);
      await settle();
      assert.equal(Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(ws)), before);
    });

    test('without the agent the rules still make a scaffold; learners cannot make one', async function() {
      load();
      const result = await makeScaffold(ws, {concept: 'auto', level: 'beginner', agent: createFakeAgentServices({delayMs: 0, unavailable: true})});
      assert.equal(result.source, 'rules');
      assert.lengthOf(result.questions, 1);
      const exported = cleanTaskXml(ws);
      assert.include(exported, '<reference>');
      setPolicy(ws, {teacherMode: false});
      const error = await makeScaffold(ws, {concept: 'auto', level: 'beginner', agent: null}).catch((e) => e);
      assert.instanceOf(error, Error);
    });
  });
});
