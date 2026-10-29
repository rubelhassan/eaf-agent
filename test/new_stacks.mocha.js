/**
 * New stacks and stack names: the ops, the program view, the harness rule for an empty workspace, and the assistant
 * applying them with the cursor following each step.
 */

import {assert} from 'chai';
import * as Blockly from 'blockly/core';
import {itemWorkspace, loadProgram} from '../eval/runner/programs.js';
import {loadItems} from '../eval/runner/items.js';
import {score} from '../eval/runner/scorers.js';
import {runProgram} from '../eval/runner/run_program.js';
import {applyOp, OpError} from '../src/agent/editor/ops.js';
import {applyPlan} from '../src/agent/editor/plan.js';
import {snapshot} from '../src/agent/context/snapshot.js';
import {opsInWords} from '../src/agent/context/ops_in_words.js';
import {runPlanAction} from '../src/agent/harness/run.js';
import {impossiblePlaces} from '../src/agent/guardrails/speech.js';
import {setStackName, stackName} from '../src/labels_and_comments/stack_name.js';
import {createCoordinator} from '../src/interaction/coordinator.js';
import {createScriptedAgent} from './helpers/scripted_agent.js';

const HELLO = {type: 'text_print', id: 'n_print', inputs: {TEXT: {type: 'text', fields: {TEXT: 'hello world'}}}};
const printed = (ws) => runProgram(ws, []).lines;
const empty = () => {
  const ws = loadProgram(18);
  ws.clear();
  return ws;
};
const opError = (ws, op, ctx = {}) => {
  try {
    applyOp(ws, op, {allowedTypes: ws.allowedTypeCatalog, ...ctx});
  } catch (e) {
    assert.instanceOf(e, OpError);
    return e.message;
  }
  assert.fail('expected an OpError');
};
const xy = (ws, id) => ws.getBlockById(id).getRelativeToSurfaceXY();
// Blockly fires events on the next tick; undo needs them recorded.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

suite('New stacks', function() {
  test('on an empty workspace, at the cursor\'s spot, with blocks following it', function() {
    const ws = empty();
    const focus = applyOp(ws, {op: 'insert', block: {...HELLO, next: {type: 'text_print', inputs: {TEXT: {type: 'text',
      fields: {TEXT: 'bye'}}}}}, stack: 'new'}, {newStack: {at: {x: 120, y: 80}}});
    assert.equal(focus, 'n_print');
    assert.lengthOf(ws.getTopBlocks(false), 1);
    assert.deepEqual([xy(ws, 'n_print').x, xy(ws, 'n_print').y], [120, 80]);
    assert.deepEqual(printed(ws), ['hello world', 'bye']);
  });

  test('below the cursor\'s stack, moved down past a stack in the way; else below the last stack', function() {
    const ws = loadProgram(18);
    const top = ws.getTopBlocks(false)[0];
    applyOp(ws, {op: 'insert', block: HELLO, stack: 'new'}, {newStack: {near: 'print_2'}});
    assert.isNull(ws.getBlockById('n_print').getParent());
    assert.equal(xy(ws, 'n_print').x, xy(ws, top.id).x);
    assert.isAbove(xy(ws, 'n_print').y, xy(ws, top.id).y);
    applyOp(ws, {op: 'insert', block: {...HELLO, id: 'n_two'}, stack: 'new'}, {newStack: {near: 'print_2'}});
    assert.isAbove(xy(ws, 'n_two').y, xy(ws, 'n_print').y, 'not on top of the first new stack');
    applyOp(ws, {op: 'insert', block: {...HELLO, id: 'n_three'}, stack: 'new'});
    assert.isAbove(xy(ws, 'n_three').y, xy(ws, 'n_two').y);
    assert.lengthOf(ws.getTopBlocks(false), 4);
  });

  test('a moved block can start a stack; a value block can\'t; stack takes only "new"', function() {
    const ws = loadProgram(18);
    applyOp(ws, {op: 'move', block: 'print_2', stack: 'new'});
    assert.isNull(ws.getBlockById('print_2').getParent());
    assert.match(opError(ws, {op: 'insert', block: {type: 'math_number', fields: {NUM: 2}}, stack: 'new'}), /is a value block; it can't start a stack/);
    assert.match(opError(ws, {op: 'insert', block: HELLO, stack: 'A'}), /stack takes "new"/);
    assert.match(opError(ws, {op: 'insert', block: HELLO, stack: 'new', after: 'set_1'}), /exactly one place/);
    assert.match(opError(ws, {op: 'insert', block: HELLO}), /exactly one place/, 'no place is still an error for the editor');
  });
});

suite('Stack names', function() {
  test('a new stack may be named; nameStack names or renames any stack; the name stays with the stack', function() {
    const ws = loadProgram(18);
    applyOp(ws, {op: 'insert', block: HELLO, stack: 'new', name: 'Greeting'});
    assert.equal(stackName(ws.getBlockById('n_print')), 'Greeting');
    assert.equal(applyOp(ws, {op: 'nameStack', block: 'print_2', name: 'main'}), ws.getTopBlocks(false)[0].id);
    assert.equal(stackName(ws.getBlockById('num_4')), 'main', 'any block in the stack has its name');
    applyOp(ws, {op: 'insert', block: {type: 'text_print', id: 'n_top', inputs: {TEXT: {type: 'text', fields: {TEXT: 'x'}}}},
      before: ws.getTopBlocks(false)[0].id});
    assert.equal(stackName(ws.getBlockById('n_top')), 'main', 'a block put above the top joins the named stack');
    applyOp(ws, {op: 'nameStack', block: 'n_print', name: ''});
    assert.equal(stackName(ws.getBlockById('n_print')), '');
    assert.match(opError(ws, {op: 'nameStack', block: 'n_print', name: 'x'.repeat(31)}), /at most 30 characters/);
    assert.match(opError(ws, {op: 'insert', block: {...HELLO, id: 'n_other'}, after: 'print_2', name: 'Nope'}),
        /name goes with stack "new"/);
  });

  test('saved with the program; undo takes a name back', async function() {
    const ws = loadProgram(18);
    const top = ws.getTopBlocks(false)[0];
    setStackName(top, 'Counting');
    const xml = Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(ws));
    const copy = new Blockly.Workspace();
    Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(xml), copy);
    assert.equal(stackName(copy.getBlockById(top.id)), 'Counting');
    copy.dispose();
    Blockly.Events.setGroup(true);
    setStackName(top, 'Skip');
    Blockly.Events.setGroup(false);
    await settle();
    ws.undo(false);
    assert.equal(stackName(top), 'Counting');
    ws.undo(true);
    assert.equal(stackName(top), 'Skip');
  });

  test('the program view shows names; new stack letters follow the app\'s labels; step words say where', function() {
    const ws = loadProgram(18);
    const top = ws.getTopBlocks(false)[0];
    setStackName(top, 'Counting');
    assert.include(snapshot(ws).text, 'Stack A: Counting\n1. ');
    applyOp(ws, {op: 'insert', block: HELLO, stack: 'new'});
    // The app has labelled the first stack B (A was freed); the new one gets A, the first free letter.
    assert.include(snapshot(ws, {stackLetters: new Map([[top.id, 'B']])}).text, 'Stack A\n1. [');
    const words = opsInWords(loadProgram(18), [{ops: [{op: 'insert', block: HELLO, stack: 'new', name: 'Hi'}]},
      {ops: [{op: 'nameStack', block: 'print_2', name: 'main'}]}]);
    assert.deepEqual(words, ['add a print block saying "hello world" in a new stack named "Hi"', 'name stack A "main"']);
  });
});

suite('Harness: new stacks', function() {
  const plan = (ops, voiceLine = 'I will add a print block saying hello world. Should I do it?') => ({steps: [{title: 'Add', ops}], voiceLine});

  test('an empty workspace, or the cursor on empty workspace: an insert with no place starts a new stack', async function() {
    for (const [ws, options] of [[empty(), {}], [loadProgram(18), {onWorkspace: true}]]) {
      const client = createScriptedAgent([plan([{op: 'insert', block: HELLO}])]);
      const r = await runPlanAction('EDIT_GUIDE', ws, {client, learnerSays: 'add a print block', ...options});
      assert.isTrue(r.valid, r.problems.join('; '));
      assert.isFalse(r.repaired);
      assert.include(r.adjusted, 'new stack');
      assert.equal(r.output.steps[0].ops[0].stack, 'new');
    }
  });

  test('the request says the cursor is on empty workspace; with the cursor on a block, no place still gets a repair', async function() {
    const client = createScriptedAgent([plan([{op: 'insert', block: HELLO}]), plan([{op: 'insert', block: HELLO, stack: 'new'}])]);
    const r = await runPlanAction('EDIT_GUIDE', loadProgram(18), {client, cursor: 'print_2', learnerSays: 'add a print block'});
    assert.isTrue(r.repaired);
    assert.isTrue(r.valid);
    const onEmpty = createScriptedAgent([plan([{op: 'insert', block: HELLO, stack: 'new'}])]);
    await runPlanAction('EDIT_GUIDE', loadProgram(18), {client: onEmpty, onWorkspace: true, learnerSays: 'add a print block'});
    assert.include(onEmpty.sent[0].messages[1].content, 'Cursor: on empty workspace, not on a block');
  });

  test('the speech may name the stack the plan makes', function() {
    const ws = loadProgram(18);
    assert.isEmpty(impossiblePlaces('It goes as block 1 of stack B.', ws, {newStacks: 1}));
    assert.deepEqual(impossiblePlaces('It goes as block 1 of stack B.', ws), ['block 1 of stack B']);
  });
});

suite('Assistant: new stacks and the cursor', function() {
  function make(ws, replies, cursor) {
    const moved = [];
    const at = {cursor};
    const assistant = createCoordinator({workspace: ws, client: createScriptedAgent(replies), cursor: () => at.cursor,
      moveCursor: (target, options) => {
        moved.push([target, options]);
        at.cursor = typeof target === 'string' ? {block: target} : target;
      }});
    return {assistant, moved};
  }

  test('empty workspace: offered, applied as a new stack at the cursor, the cursor follows; undo puts it back', async function() {
    const ws = empty();
    const {assistant, moved} = make(ws, [{intent: 'EDIT', question: null},
      {steps: [{title: 'Add a print block', ops: [{op: 'insert', block: HELLO}]}],
        voiceLine: 'I will add a print block saying hello world in a new stack. Should I do it?'}], {block: null, at: {x: 60, y: 40}});
    const offer = await assistant.ask('add a print block with hello world');
    assert.equal(offer.kind, 'offer');
    const done = await assistant.ask('yes');
    assert.equal(done.say, 'Done. Your cursor is on the print block, block 1 of stack A. That was the last step. Say undo to take it back.');
    assert.deepEqual(moved[0], ['n_print', {focus: false}], 'keyboard focus stays where it is');
    assert.deepEqual([xy(ws, 'n_print').x, xy(ws, 'n_print').y], [60, 40]);
    await settle();
    const undone = await assistant.ask('undo');
    assert.match(undone.say, /^Took back the change\. Your cursor is back where it was\./);
    assert.deepEqual(moved[1][0], {block: null, field: null, at: {x: 60, y: 40}});
    assert.lengthOf(ws.getTopBlocks(false), 0);
  });

  test('every applied step moves the cursor: a change to the changed block, a delete to the block in its place', async function() {
    const ws = loadProgram(18);
    const {assistant, moved} = make(ws, [{intent: 'EDIT', question: null}, {steps: [
      {title: 'Count by 5', ops: [{op: 'setField', block: 'b10', field: 'NUM', value: 5}]},
      {title: 'Remove the first print', ops: [{op: 'delete', block: 'b1'}]},
    ], voiceLine: 'I can count by 5 and remove the first print. Should I do it?'}], {block: 'set_1'});
    await assistant.ask('count by five and remove the welcome');
    const first = await assistant.ask('yes');
    assert.equal(moved[0][0], 'num_4');
    assert.include(first.say, 'Did step 1. Your cursor is on the number block, inside block 3 of stack A.');
    await assistant.ask('yes');
    assert.equal(moved[1][0], ws.getTopBlocks(false)[0].id, 'the block that took the deleted one\'s place');
  });
});

suite('Eval: new stack items', function() {
  const items = Object.fromEntries(loadItems('dev').map((i) => [i.id, i]));
  const scoreItem = (id, steps) => score(items[id], {steps, voiceLine: 'I will add it. Should I do it?'},
      itemWorkspace(items[id]), [], {arm: 'harness'});
  const say = (text) => ({type: 'text_print', inputs: {TEXT: {type: 'text', fields: {TEXT: text}}}});

  test('right answers pass; the same output without a new stack, or without the name, fails', function() {
    assert.isTrue(scoreItem('dev-empty-edit-2', [{ops: [{op: 'insert', block: {...say('Hello'), next: say('Goodbye')}, stack: 'new'}]}]).pass);
    assert.isTrue(scoreItem('dev-8-edit-3', [{ops: [{op: 'insert', block: say('Thanks for baking'), stack: 'new'}]}]).pass);
    const appended = scoreItem('dev-8-edit-3', [{ops: [{op: 'insert', block: say('Thanks for baking'), after: 'print_2'}]}]);
    assert.isTrue(appended.checks.outputMatchesGoal);
    assert.isFalse(appended.pass, 'asked where the cursor is, on empty workspace');
    assert.isTrue(scoreItem('dev-18-edit-5', [{ops: [{op: 'insert', block: say('The end'), stack: 'new', name: 'ending'}]}]).pass);
    assert.isFalse(scoreItem('dev-18-edit-5', [{ops: [{op: 'insert', block: say('The end'), stack: 'new'}]}]).pass);
    assert.isTrue(scoreItem('dev-18-edit-6', [{ops: [{op: 'nameStack', block: 'repeat_1', name: 'Counter'}]}]).pass);
  });
});
