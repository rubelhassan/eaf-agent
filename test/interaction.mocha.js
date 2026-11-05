/**
 * The coordinator on dataset programs: routing, offered fixes, step-by-step plans, consent, side questions,
 * stopping, undo, clarification, quiz limits, events. Model replies are scripted.
 */

import {assert} from 'chai';
import {loadItems} from '../eval/runner/items.js';
import {itemWorkspace, loadProgram} from '../eval/runner/programs.js';
import {createOfflineAgentClient} from '../src/agent/model/fake.js';
import {createScriptedAgent} from './helpers/scripted_agent.js';

const V3 = {INTENT: 'v3'};
import {createCoordinator} from '../src/interaction/coordinator.js';
import {matchCommand} from '../src/interaction/commands.js';
import {scopeFor} from '../src/interaction/scope.js';
import {checkIntentReply} from '../src/agent/harness/intent.js';
import {Activity, setPolicy} from '../src/blocks/policy.js';

const items = Object.fromEntries(loadItems('dev').map((i) => [i.id, i]));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const names = (reply) => reply.actions.map((a) => a.name);

function make(ws, replies, extra = {}, versions = {}) {
  const client = extra.client || createScriptedAgent(replies, versions);
  const moved = [];
  const opened = [];
  const events = [];
  const progress = [];
  const assistant = createCoordinator({workspace: ws, client, cursor: () => extra.cursor || {block: null},
    moveCursor: (id) => moved.push(id), openQuestion: (id) => opened.push(id),
    onEvent: (kind, data) => events.push({kind, ...data}), onProgress: (text) => progress.push(text)});
  return {assistant, client, moved, opened, events, progress};
}

// Program 18 in the view: num_5 (repeat count) is b6, num_4 (the added 4) is b10.
const TWO_STEPS = {steps: [
  {title: 'Count by 5', ops: [{op: 'setField', block: 'b10', field: 'NUM', value: 5}]},
  {title: 'Repeat 6 times', ops: [{op: 'setField', block: 'b6', field: 'NUM', value: 6}]},
], voiceLine: 'I can make it count by 5, six times.'};
const num = (ws, id) => ws.getBlockById(id).getFieldValue('NUM');

suite('Answer words and scope', function() {
  test('whole replies only', function() {
    assert.equal(matchCommand('Yes.'), 'yes');
    assert.equal(matchCommand('okay do it'), 'yes');
    assert.equal(matchCommand('No thanks'), 'stop');
    assert.equal(matchCommand('undo please'), 'undo');
    assert.equal(matchCommand('go there'), 'go');
    assert.equal(matchCommand('cancel that'), 'stop');
    assert.equal(matchCommand('go on'), 'continue');
    assert.isNull(matchCommand('yes but use 5 instead'));
    assert.isNull(matchCommand('what does this do'));
  });

  test('scope follows the cursor, widened by clear words', function() {
    const ws = loadProgram(18);
    assert.equal(scopeFor(ws, {block: 'num_5', field: 'NUM'}, 'what is this'), 'field');
    assert.equal(scopeFor(ws, {block: 'set_2'}, 'what is this'), 'statement');
    assert.equal(scopeFor(ws, {block: 'repeat_1'}, 'what is this'), 'block', 'a container is a block');
    assert.equal(scopeFor(ws, {block: 'arith_1'}, 'what is this'), 'block');
    assert.equal(scopeFor(ws, {block: 'set_2'}, 'what does my program do'), 'program');
    assert.equal(scopeFor(ws, {block: 'set_2'}, 'explain this part'), 'stack');
    assert.equal(scopeFor(ws, {block: null}, 'what is this'), 'program');
  });
});

suite('Coordinator', function() {
  test('a question is routed and answered; the same question on the same program is answered from the cache', async function() {
    const ws = loadProgram(18);
    const {assistant, client} = make(ws, [{intent: 'COMPREHEND', question: null}, {voiceLine: 'It repeats 5 times.'},
      {intent: 'COMPREHEND', question: null}], {cursor: {block: 'repeat_1'}});
    assert.equal((await assistant.ask('what does this do')).say, 'It repeats 5 times.');
    assert.include(client.sent[1].messages[1].content, 'Scope: block');
    // Routed again (the first task is now part of the request), explained from the cache.
    assert.equal((await assistant.ask('what does this do')).say, 'It repeats 5 times.');
    assert.lengthOf(client.sent, 3);
  });

  test('debug explains first; yes shows the fix, yes applies it, undo takes it back', async function() {
    const ws = itemWorkspace(items['dev-8-debug-1']);
    const fix = {issue: {severity: 'wrongResult', blocks: ['b5'], explanation: 'It adds 1.'},
      fix: {title: 'Multiply instead', ops: [{op: 'setField', block: 'b5', field: 'OP', value: 'MULTIPLY'}]},
      voiceLine: 'The math block adds 1 instead of doubling. Do you want the fix?'};
    const {assistant} = make(ws, [{intent: 'DEBUG', question: null}, fix]);
    const explained = await assistant.ask('it should double my cookies');
    assert.match(explained.say, /Do you want the fix/);
    assert.includeMembers(names(explained), ['yes', 'stop']);
    assert.isTrue(explained.expectsAnswer);
    const op = () => ws.getBlockById('arith_1').getFieldValue('OP');
    const before = op();
    assert.match((await assistant.ask('yes')).say, /^The change: set the operator of the arithmetic block in .*, to multiply\. Say yes to do it, or stop\.$/);
    assert.equal(op(), before, 'nothing changes before the second yes');
    const done = await assistant.ask('yes');
    assert.match(done.say, /^Done\. Your cursor is on [^.]+\. That was the last step/);
    assert.equal(op(), 'MULTIPLY');
    await settle();
    const undone = await assistant.ask('undo');
    assert.equal(undone.say, 'Took back the change.');
    assert.equal(op(), before);
    assert.notInclude(names(undone), 'yes', 'a finished plan stays ended');
  });

  test('a plan goes one step at a time; all needs the teacher\'s whole-plan setting', async function() {
    const ws = loadProgram(18);
    const {assistant} = make(ws, [{intent: 'EDIT', question: null}, TWO_STEPS]);
    const offered = await assistant.ask('count by five, six times');
    assert.match(offered.say, /Step 1 of 2: set the number in the set variable block, [^.]*, to 5\. Say yes to do it, or stop\.$/);
    assert.notInclude(names(offered), 'all');
    const first = await assistant.ask('yes');
    assert.match(first.say, /^Did step 1\. Your cursor is on [^.]+\. Step 2 of 2: set the number in the repeat times block, block 3 of stack A, to 6\./);
    assert.equal(num(ws, 'num_4'), 5);
    assert.equal(num(ws, 'num_5'), 5, 'step 2 waits');
    await assistant.ask('all');
    assert.equal(num(ws, 'num_5'), 5, '"all" is not offered, so it is a request, not a command');
  });

  test('with whole-plan on, all applies the rest at once', async function() {
    const ws = loadProgram(18);
    setPolicy(ws, {wholePlan: true});
    const {assistant} = make(ws, [{intent: 'EDIT', question: null}, TWO_STEPS]);
    const offered = await assistant.ask('count by five, six times');
    assert.include(names(offered), 'all');
    assert.match(offered.say, /all to do every step/);
    assert.match((await assistant.ask('do all')).say, /^Did steps 1 to 2\. Your cursor is on [^.]+\. That was the last step/);
    assert.equal(num(ws, 'num_4'), 5);
    assert.equal(num(ws, 'num_5'), 6);
  });

  test('a loose or misheard answer goes to the intent step with what each answer does, and acts like saying it', async function() {
    const ws = loadProgram(18);
    const {assistant, client} = make(ws, [{intent: 'EDIT', question: null}, TWO_STEPS,
      {intent: 'ANSWER', answer: 'yes', question: null}, {intent: 'ANSWER', answer: 'undo', question: null},
      {intent: 'ANSWER', answer: null, question: null}], {}, V3);
    await assistant.ask('count by five, six times');
    const done = await assistant.ask('yes louit');
    assert.match(done.say, /^Did step 1\./);
    assert.equal(num(ws, 'num_4'), 5);
    const asked = client.sent[2].messages[1].content;
    assert.match(asked, /You last said: ".*Step 1 of 2: set the number .* to 5. Say yes to do it, or stop."/);
    assert.match(asked, /- yes: do step 1 of 2: set the number .* to 5/);
    await settle();
    assert.match((await assistant.ask('can you undo it')).say, /^Took back step 1\./);
    assert.equal(num(ws, 'num_4'), 4);
    const unclear = await assistant.ask('mm the blue');
    assert.equal(unclear.say, "I didn't understand your answer. Can you say it again?");
    assert.isTrue(unclear.expectsAnswer, 'the step is still offered');
  });

  test('an answer the model picks must be one that can be given now', function() {
    const ws = loadProgram(18);
    const answers = [{name: 'yes', does: 'do it'}];
    assert.deepEqual(checkIntentReply(ws, {intent: 'ANSWER', answer: 'yes'}, {answers}, 'v3'), []);
    assert.deepEqual(checkIntentReply(ws, {intent: 'ANSWER', answer: null}, {answers}, 'v3'), []);
    assert.match(checkIntentReply(ws, {intent: 'ANSWER', answer: 'undo'}, {answers}, 'v3')[0], /one of yes/);
    assert.match(checkIntentReply(ws, {intent: 'ANSWER', answer: 'yes'}, {}, 'v3')[0], /nothing to answer/);
    assert.match(checkIntentReply(ws, {intent: 'ANSWER', answer: 'yes'}, {answers}, 'v2')[0], /intent must be one of/);
  });

  test('relations: needed with a task, ignored without one; revise only for debug or edit', function() {
    const ws = loadProgram(18);
    const edit = {taskContext: 'Task: edit, revision 1, waiting for an answer', taskAction: 'EDIT_GUIDE'};
    assert.deepEqual(checkIntentReply(ws, {intent: 'EDIT', relation: 'revise'}, edit, 'v3'), []);
    assert.match(checkIntentReply(ws, {intent: 'EDIT', relation: null}, edit, 'v3')[0], /relation must be one of/);
    assert.deepEqual(checkIntentReply(ws, {intent: 'EDIT', relation: 'new'}, {}, 'v3'), []);
    assert.match(checkIntentReply(ws, {intent: 'COMPREHEND', relation: 'revise'},
        {taskContext: 'Task: comprehend, revision 1, done', taskAction: 'COMPREHEND'}, 'v3')[0], /only for a debug or edit/);
    assert.deepEqual(checkIntentReply(ws, {intent: 'EDIT'}, edit, 'v2'), [], 'v2 has no relation');
  });

  test('a correction revises the offered plan with the task so far; the old plan is gone', async function() {
    const ws = loadProgram(18);
    const byThree = {steps: [{title: 'Count by 3', ops: [{op: 'setField', block: 'b10', field: 'NUM', value: 3}]}],
      voiceLine: 'I can make it count by 3.'};
    const {assistant, client, events} = make(ws, [{intent: 'EDIT', relation: null, question: null}, TWO_STEPS,
      {intent: 'EDIT', relation: 'revise', answer: null, question: null}, byThree], {}, V3);
    await assistant.ask('count by five, six times');
    const revised = await assistant.ask('no, count by three');
    assert.match(revised.say, /The change: set the number in the set variable block, [^.]*, to 3\./);
    const sent = client.sent[3].messages[1].content;
    assert.match(sent, /^Instruction: "no, count by three"\n\nTask so far:\nTask: edit, revision 2, working\n/);
    assert.include(sent, 'Learner asked: "count by five, six times"');
    assert.include(sent, 'Correction: "no, count by three"');
    assert.include(events.map((e) => e.kind), 'task.revised');
    await assistant.ask('yes');
    assert.equal(num(ws, 'num_4'), 3);
    assert.equal(num(ws, 'num_5'), 5, 'the replaced plan never applies');
  });

  test('a question about the offered change is answered from the task so far, and the offer stays', async function() {
    const ws = loadProgram(18);
    const {assistant, client} = make(ws, [{intent: 'EDIT', relation: null, question: null}, TWO_STEPS,
      {intent: 'COMPREHEND', relation: 'ask', answer: null, question: null},
      {voiceLine: 'It would add 5 each time instead of 4, so it counts by five.'}], {}, V3);
    await assistant.ask('count by five, six times');
    const why = await assistant.ask('why that number block?');
    assert.equal(why.say, 'It would add 5 each time instead of 4, so it counts by five. Step 1 is still waiting. Say yes to do it, or stop.');
    assert.include(client.sent[3].messages[0].content, 'question about a change you offered');
    assert.include(client.sent[3].messages[1].content, 'Offered: step 1 of 2, set the number in the set variable block');
    await assistant.ask('yes');
    assert.equal(num(ws, 'num_4'), 5);
  });

  test('stop ends the plan; undo goes one step at a time and resumes the plan', async function() {
    const ws = loadProgram(18);
    const {assistant} = make(ws, [{intent: 'EDIT', question: null}, TWO_STEPS]);
    await assistant.ask('count by five, six times');
    await assistant.ask('yes');
    await settle();
    const undone = await assistant.ask('undo');
    assert.match(undone.say, /^Took back step 1\. Step 1 of 2/, 'mid-plan, the step is offered again');
    assert.equal(num(ws, 'num_4'), 4);
    await assistant.ask('yes');
    const stopped = await assistant.ask('stop');
    assert.equal(stopped.say, "Okay, I won't make that change. Say undo to take back a step.");
    assert.isFalse(stopped.expectsAnswer);
    await settle();
    const after = await assistant.ask('undo');
    assert.equal(after.say, 'Took back step 1.', 'a stopped plan stays ended');
    assert.isFalse(after.expectsAnswer);
  });

  test('undo refuses when the program changed after the step', async function() {
    const ws = loadProgram(18);
    const {assistant} = make(ws, [{intent: 'EDIT', question: null}, TWO_STEPS]);
    await assistant.ask('count by five, six times');
    await assistant.ask('yes');
    await settle();
    ws.getBlockById('num_0').setFieldValue(1, 'NUM');
    await settle();
    assert.match((await assistant.ask('undo')).say, /can't take it back safely/);
    assert.equal(num(ws, 'num_4'), 5);
  });

  test('a yes after the program changed: asks again when the step still fits, offers a new plan when it doesn\'t', async function() {
    const ws = loadProgram(18);
    const {assistant, client} = make(ws, [{intent: 'EDIT', question: null}, TWO_STEPS]);
    await assistant.ask('count by five, six times');
    ws.getBlockById('num_0').setFieldValue(1, 'NUM');
    const again = await assistant.ask('yes');
    assert.match(again.say, /It still fits\. Say yes again to do it\.$/);
    assert.equal(num(ws, 'num_4'), 4, 'the learner agreed to the old program, so nothing applies yet');
    await assistant.ask('yes');
    assert.equal(num(ws, 'num_4'), 5);

    ws.getBlockById('num_5').dispose();
    const refit = await assistant.ask('yes');
    assert.match(refit.say, /doesn't fit any more\. Should I make a new one\?$/);
    const calls = client.sent.length;
    await assistant.ask('yes');
    assert.isAbove(client.sent.length, calls, 'a yes makes a new plan for the same request');
    assert.include(client.sent.at(-1).messages[1].content, 'count by five, six times');
  });

  test('a yes after a new request never applies the plan it replaced', async function() {
    const ws = loadProgram(18);
    const other = {steps: [{title: 'Start at 1', ops: [{op: 'setField', block: 'b4', field: 'NUM', value: 1}]}],
      voiceLine: 'I can start the count at 1.'};
    const {assistant, events} = make(ws, [{intent: 'EDIT', question: null}, TWO_STEPS, {intent: 'EDIT', question: null}, other]);
    await assistant.ask('count by five, six times');
    await assistant.ask('start at one instead');
    await assistant.ask('yes');
    assert.equal(num(ws, 'num_4'), 4, 'the replaced plan never applies');
    assert.equal(num(ws, 'num_0'), 1);
    assert.include(events.map((e) => e.kind), 'proposal.withdrawn');
  });

  test('a side question keeps the offered step, with a reminder; yes then applies it', async function() {
    const ws = loadProgram(18);
    const {assistant} = make(ws, [{intent: 'EDIT', question: null}, TWO_STEPS, {intent: 'COMPREHEND', question: null},
      {voiceLine: 'It adds 4 each time.'}], {cursor: {block: 'set_2'}});
    await assistant.ask('count by five, six times');
    const side = await assistant.ask('what does this block do');
    assert.equal(side.say, 'It adds 4 each time. Step 1 is still waiting. Say yes to do it, or stop.');
    assert.isTrue(side.expectsAnswer);
    await assistant.ask('yes');
    assert.equal(num(ws, 'num_4'), 5);
  });

  test('stop while working aborts the call and its late reply is dropped', async function() {
    const ws = loadProgram(18);
    let release;
    const signals = [];
    const client = {
      call(call, {signal} = {}) {
        signals.push(signal);
        return new Promise((resolve) => {
          release = () => resolve({requestId: call.requestId, status: 'ok', reply: JSON.stringify({intent: 'COMPREHEND', question: null}), meta: {}});
          signal?.addEventListener('abort', () => resolve({requestId: call.requestId, status: 'error', code: 'ABORTED', meta: {}}));
        });
      },
      result() {},
    };
    const {assistant} = make(ws, [], {client});
    const pending = assistant.ask('what does my program do');
    assert.equal(assistant.state().lock, 'frozen');
    const stopped = await assistant.ask('stop');
    assert.equal(stopped.say, 'Okay, I stopped.');
    assert.isTrue(signals[0].aborted);
    release();
    assert.equal((await pending).say, '', 'the late reply is dropped');
    assert.equal(assistant.state().lock, 'free');
  });

  test('a message while working stops the running task and is routed instead', async function() {
    const ws = loadProgram(18);
    const replies = [];
    const client = {
      call(call, {signal} = {}) {
        if (replies.length === 0) {
          replies.push(1);
          return new Promise((resolve) => signal.addEventListener('abort', () => resolve({requestId: call.requestId, status: 'error', code: 'ABORTED', meta: {}})));
        }
        const reply = call.task === 'INTENT' ? {intent: 'COMPREHEND', question: null} : {voiceLine: 'It counts by 4.'};
        return Promise.resolve({requestId: call.requestId, status: 'ok', reply: JSON.stringify(reply), meta: {}});
      },
      result() {},
    };
    const {assistant, events} = make(ws, [], {client});
    const first = assistant.ask('fix my program');
    const second = await assistant.ask('what does my program do');
    assert.equal(second.say, 'It counts by 4.');
    assert.equal((await first).say, '');
    assert.include(events.map((e) => e.kind), 'task.cancelled');
  });

  test('a clarification answer goes into the task context with its question', async function() {
    const ws = loadProgram(18);
    const {assistant} = make(ws, [{intent: 'EDIT', question: null}, {steps: [], voiceLine: 'Which number should change?'},
      TWO_STEPS]);
    await assistant.ask('change the counting');
    await assistant.ask('the four');
    const context = assistant.state().context;
    assert.include(context, 'You asked: "Which number should change?" Learner answered: "the four"');
    assert.include(context, 'Offered: step 1 of 2, set the number in the set variable block, inside block 3 of stack A, to 5');
  });

  test('undo works across tasks, newest first', async function() {
    const ws = loadProgram(18);
    const one = (block, value, title) => ({steps: [{title, ops: [{op: 'setField', block, field: 'NUM', value}]}], voiceLine: 'Okay.'});
    const {assistant} = make(ws, [{intent: 'EDIT', question: null}, one('b10', 5, 'Count by 5'),
      {intent: 'EDIT', question: null}, one('b6', 6, 'Six times')]);
    await assistant.ask('count by five');
    await assistant.ask('yes');
    await settle();
    await assistant.ask('six times');
    await assistant.ask('yes');
    await settle();
    await assistant.ask('undo');
    assert.equal(num(ws, 'num_5'), 5);
    assert.equal(num(ws, 'num_4'), 5);
    await settle();
    const second = await assistant.ask('undo');
    assert.equal(num(ws, 'num_4'), 4);
    assert.notInclude(names(second), 'yes', 'an ended task is not offered again');
  });

  test('events: a task from start to done, in order', async function() {
    const ws = loadProgram(18);
    const {assistant, events} = make(ws, [{intent: 'EDIT', question: null}, TWO_STEPS]);
    setPolicy(ws, {wholePlan: true});
    await assistant.ask('count by five, six times');
    await assistant.ask('all');
    assert.deepEqual(events.map((e) => e.kind), ['task.started', 'message.routed', 'task.stage', 'proposal.offered',
      'message.routed', 'step.applied', 'task.done']);
    assert.isTrue(events.every((e) => e.taskId === events[0].taskId));
    assert.equal(events.at(-1).action, 'EDIT_GUIDE', 'task events carry the action once known');
    assert.deepEqual(events.find((e) => e.kind === 'proposal.offered').words, ['set the number in the set variable block, inside block 3 of stack A, to 5',
      'set the number in the repeat times block, block 3 of stack A, to 6']);
  });

  test('a clarifying question joins the next reply to the request', async function() {
    const ws = loadProgram(18);
    const {assistant, client} = make(ws, [
      {intent: 'CLARIFICATION', question: 'Do you want to know what it does, or change it?'},
      {intent: 'EDIT', question: null}, {steps: [], voiceLine: 'Which number should change?'},
      {steps: [], voiceLine: 'Okay.'},
    ]);
    const asked = await assistant.ask('help');
    assert.isTrue(asked.expectsAnswer);
    await assistant.ask('change it');
    assert.include(client.sent[1].messages[1].content, 'Learner said: "help change it"');
    // An edit that asks back goes straight to edit with the answer, no intent call.
    await assistant.ask('the four');
    assert.include(client.sent[3].messages[0].content, 'OPS');
    assert.include(client.sent[3].messages[1].content, 'Instruction: "help change it the four"\n\nTask so far:\n');
    assert.include(client.sent[3].messages[1].content, 'You asked: "Which number should change?" Learner answered: "the four"');
  });

  test('my name is masked for the model and back in the reply', async function() {
    const ws = loadProgram(18);
    const client = createScriptedAgent([{intent: 'COMPREHEND', question: null}, {voiceLine: 'Hi NAME_1, it counts by 4.'}], {},
        {guarded: true});
    const {assistant} = make(ws, [], {client});
    const r = await assistant.ask('my name is zoe, what does my program do');
    assert.equal(r.say, 'Hi zoe, it counts by 4.');
    assert.notInclude(JSON.stringify(client.sent), 'zoe');
  });

  test('a plan that fails its checks twice is not offered, and the next reply is a new message', async function() {
    const ws = loadProgram(18);
    const broken = {steps: [{title: 'Add a print', ops: [{op: 'insert', block: {type: 'text_print'}}]}],
      voiceLine: 'I will add a print block. Should I do it?'};
    const {assistant, client} = make(ws, [{intent: 'EDIT', question: null}, broken, broken,
      {intent: 'ANSWER', relation: null, answer: null, question: null}], {}, V3);
    const r = await assistant.ask('add a print block');
    assert.match(r.say, /^Sorry, I couldn't make a change that works/);
    assert.isFalse(r.expectsAnswer);
    await assistant.ask('ah yes');
    assert.include(client.sent[3].messages[0].content, 'intent', 'routed by intent, not sent to edit as an answer');
  });

  test('a step is spoken from its ops, never from the model\'s title', async function() {
    const ws = loadProgram(18);
    const misleading = {steps: [{title: 'Delete the whole loop', ops: [{op: 'setField', block: 'b10', field: 'NUM', value: 5}]}],
      voiceLine: 'I can make it count by 5. Should I do it?'};
    const {assistant, events} = make(ws, [{intent: 'EDIT', question: null}, misleading]);
    const offered = await assistant.ask('count by five');
    assert.notInclude(offered.say, 'Delete the whole loop');
    assert.equal(offered.say, 'I can make it count by 5. Should I do it? The change: set the number in the set variable block, ' +
      'inside block 3 of stack A, to 5. Say yes to do it, or stop.');
    assert.equal(assistant.state().context.match(/Offered: .*/)[0],
        'Offered: step 1 of 1, set the number in the set variable block, inside block 3 of stack A, to 5');
    assert.include(events.find((e) => e.kind === 'proposal.offered').words[0], 'to 5');
  });

  test('a plan whose spoken line breaks the speech rules twice is never offered', async function() {
    const ws = loadProgram(18);
    const claims = {steps: [{title: 'Count by 5', ops: [{op: 'setField', block: 'b10', field: 'NUM', value: 5}]}],
      voiceLine: 'I changed the **number** in b10, the green math block on the left, to 5.'};
    const {assistant, client} = make(ws, [{intent: 'EDIT', question: null}, claims, claims]);
    const r = await assistant.ask('count by five');
    assert.match(r.say, /^Sorry, I couldn't make a change that works/);
    assert.notInclude(names(r), 'yes');
    assert.isFalse(r.expectsAnswer);
    assert.lengthOf(client.sent, 3, 'one repair round');
    await assistant.ask('yes');
    assert.equal(num(ws, 'num_4'), 4, 'nothing was offered, so nothing applies');
  });

  test('a checked plan whose line still names an impossible place is offered from its ops, without the line', async function() {
    const ws = itemWorkspace(items['dev-8-debug-1']);
    const wrongPlace = {issue: {severity: 'wrongResult', blocks: ['b5'], explanation: 'It adds 1.'},
      fix: {title: 'Multiply', ops: [{op: 'setField', block: 'b5', field: 'OP', value: 'MULTIPLY'}]},
      voiceLine: 'The math block, block 9 of stack A, adds 1. Want me to fix it?'};
    const {assistant, client} = make(ws, [{intent: 'DEBUG', question: null}, wrongPlace, wrongPlace]);
    const r = await assistant.ask('it should double my cookies');
    assert.lengthOf(client.sent, 3, 'one repair round');
    assert.notInclude(r.say, 'block 9');
    assert.match(r.say, /^The change: set the operator of the arithmetic block in .*, to multiply\. Say yes to do it, or stop\.$/);
    await assistant.ask('yes');
    assert.equal(ws.getBlockById('arith_1').getFieldValue('OP'), 'MULTIPLY');
  });

  test('in a quiz only explaining, finding and question help are on; explaining stays at block level', async function() {
    const ws = loadProgram(18);
    setPolicy(ws, {activity: Activity.QUIZ});
    const {assistant, client} = make(ws, [{intent: 'DEBUG', question: null}, {intent: 'COMPREHEND', question: null},
      {voiceLine: 'It adds 4.'}], {cursor: {block: 'set_2'}});
    assert.match((await assistant.ask('fix my program')).say, /^During the quiz/);
    await assistant.ask('what does my program do');
    assert.include(client.sent[2].messages[1].content, 'Scope: block');
  });

  test('search offers to go there; the cursor moves only when asked', async function() {
    const ws = loadProgram(18);
    const {assistant, moved, client} = make(ws, [{intent: 'SEARCH', question: null}]);
    const found = await assistant.ask('Which block says Done?');
    assert.match(found.say, /block 4 of stack A\. Say go there to move to it\.$/);
    assert.isEmpty(moved);
    await assistant.ask('go there');
    assert.deepEqual(moved, ['print_3']);
    assert.lengthOf(client.sent, 1, 'only the intent call; code found the block');
  });

  test('a hint request opens the question\'s help, or asks to move to a question', async function() {
    const item = items['dev-intent-25'];
    const ws = itemWorkspace(item);
    const away = make(ws, [{intent: 'HINT', question: null}], {cursor: {block: 'print_1'}});
    assert.match((await away.assistant.ask('give me a hint')).say, /^Move to the question/);
    const at = make(ws, [{intent: 'HINT', question: null}], {cursor: {block: 'q_grow'}});
    await at.assistant.ask('give me a hint');
    assert.deepEqual(at.opened, ['q_grow']);
  });

  test('offline: requests are routed by words and answered without a network', async function() {
    const assistant = createCoordinator({workspace: loadProgram(18), client: createOfflineAgentClient(),
      cursor: () => ({block: 'repeat_1'})});
    assert.match((await assistant.ask('fix my program')).say, /can't check your program/);
    assert.match((await assistant.ask('what does this do')).say, /can't explain/);
  });

  test('a call that gets no answer says so; a reply that fails its checks asks to try again', async function() {
    const ws = loadProgram(18);
    const down = {call: async (call) => ({requestId: call.requestId, status: 'error', code: 'MODEL', message: 'HTTP 401', meta: {}}),
      result() {}};
    assert.equal((await make(ws, [], {client: down}).assistant.ask('what does this do')).say,
        "Sorry, I can't connect right now. Please try again later.");
    const {assistant} = make(ws, [{intent: 'COMPREHEND', question: null}, {voiceLine: ''}], {cursor: {block: 'repeat_1'}});
    assert.equal((await assistant.ask('what does this do')).say, "Sorry, I couldn't work that out. Please try again.");
  });
});
