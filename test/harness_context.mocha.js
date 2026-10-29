/**
 * Harness context pieces: plan steps in words, the task context lines, and the workspace version on results.
 */
import {assert} from 'chai';
import {loadProgram} from '../eval/runner/programs.js';
import {opsInWords} from '../src/agent/context/ops_in_words.js';
import {workspaceVersion} from '../src/agent/context/version.js';
import {speechProblems} from '../src/agent/guardrails/speech.js';
import {taskContext} from '../src/interaction/task_context.js';
import {createFakeAgentClient} from '../src/agent/model/fake.js';
import {buildIntentRequest, runIntent} from '../src/agent/harness/intent.js';
import {runComprehend} from '../src/agent/harness/comprehend.js';
import {buildPlanRequest, runPlanAction} from '../src/agent/harness/run.js';
import {renderRequest} from '../server/src/prompts/render.js';
import {runSearch} from '../src/agent/harness/search.js';

const step = (...ops) => ({title: 't', ops});

suite('Ops in words', function() {
  test('every op, with places by structure', function() {
    const ws = loadProgram(18);
    const words = opsInWords(ws, [
      step({op: 'setField', block: 'num_5', field: 'NUM', value: 6}),
      step({op: 'setField', block: 'text_2', field: 'TEXT', value: 'Finished'}),
      step({op: 'insert', block: {type: 'text_print', inputs: {TEXT: {type: 'text', fields: {TEXT: 'Bye'}}}}, after: 'print_3'}),
      step({op: 'insert', block: {type: 'math_number', fields: {NUM: 2}}, parent: 'arith_1', input: 'B'}),
      step({op: 'move', block: 'print_1', after: 'set_1'}),
      step({op: 'delete', block: 'set_2'}),
    ]);
    assert.deepEqual(words, [
      'set the number in the repeat times block, block 3 of stack A, to 6',
      'set the text in the print block, block 4 of stack A, to "Finished"',
      'add a print block saying "Bye" after block 4 of stack A',
      'put a number block 2 into the arithmetic block, inside block 3 of stack A',
      'move the print block, block 1 of stack A, to after block 2 of stack A',
      'remove the set variable block, inside block 3 of stack A, and what is plugged into it',
    ]);
    for (const w of words) assert.isEmpty(speechProblems(w, ws), w);
  });

  test('a later step names a block an earlier step added; several ops are joined with then', function() {
    const ws = loadProgram(18);
    const words = opsInWords(ws, [
      step({op: 'insert', block: {type: 'text_print', id: 'new_print', inputs: {TEXT: {type: 'text', fields: {TEXT: 'Hi'}}}},
        before: 'print_1'}),
      step({op: 'move', block: 'print_3', after: 'new_print'}, {op: 'setField', block: 'num_5', field: 'NUM', value: 2}),
    ]);
    assert.equal(words[0], 'add a print block saying "Hi" before block 1 of stack A');
    assert.equal(words[1], 'move the print block, block 5 of stack A, to after block 1 of stack A, ' +
      'then set the number in the repeat times block, block 5 of stack A, to 2');
    assert.equal(ws.getBlockById('new_print'), null, 'the program itself is never changed');
  });
});

suite('Task context', function() {
  const task = {
    action: 'EDIT_GUIDE', revision: 2, state: 'awaiting',
    request: {words: 'make it count by five', clarifications: [{asked: 'Start at 5 or at 0?', answer: 'at 5'}],
      corrections: ['actually, use the "inner" loop']},
    proposal: {kind: 'plan', steps: [{title: 'a'}, {title: 'b'}], next: 0, presented: true,
      words: ['set the number in the repeat block, block 3 of stack A, to 5', 'b']},
    applied: [],
    lastSay: 'Step 1 of 2: change the repeat count to 5. Say yes to do it, or stop.',
  };

  test('the lines, in order, with quotes escaped', function() {
    assert.equal(taskContext(task), [
      'Task: edit, revision 2, waiting for an answer',
      'Learner asked: "make it count by five"',
      'You asked: "Start at 5 or at 0?" Learner answered: "at 5"',
      'Correction: "actually, use the \\"inner\\" loop"',
      'Offered: step 1 of 2, set the number in the repeat block, block 3 of stack A, to 5',
      'Applied: none',
      'You last said: "Step 1 of 2: change the repeat count to 5. Say yes to do it, or stop."',
    ].join('\n'));
  });

  test('a debug fix not yet shown, a long last line cut, and no task at all', function() {
    const long = Array.from({length: 80}, (_, i) => `w${i}`).join(' ');
    const fix = {...task, action: 'DEBUG', revision: 1, request: {words: 'fix it', clarifications: [], corrections: []},
      proposal: {kind: 'fix', steps: [{title: 'Multiply instead'}], next: 0, presented: false,
        words: ['set the operator of the arithmetic block in the print block, block 2 of stack A, to multiply']}, lastSay: long};
    const text = taskContext(fix);
    assert.include(text, 'Offered: the fix: set the operator of the arithmetic block in the print block, block 2 of stack A, to multiply');
    assert.notInclude(text, 'Multiply instead', 'a model-written title never describes the change');
    assert.match(text, /You last said: "w0 .* w59\.\.\."$/);
    assert.equal(taskContext(null), '');
  });
});

suite('Workspace version on results', function() {
  test('every harness result carries the version of the program it was built from', async function() {
    const ws = loadProgram(18);
    const version = workspaceVersion(ws);
    const client = createFakeAgentClient([{intent: 'COMPREHEND', question: null}, {voiceLine: 'It counts.'},
      {steps: [], voiceLine: 'What should change?'}, {blocks: ['b3'], voiceLine: 'The repeat block, block 3 of stack A.'}]);
    const results = [
      await runIntent(ws, {client, learnerSays: 'what is this'}),
      await runComprehend(ws, {client, learnerSays: 'what is this'}),
      await runPlanAction('EDIT_GUIDE', ws, {client, learnerSays: 'change it'}),
      await runSearch(ws, {client, learnerSays: 'where is the loop that counts'}),
    ];
    for (const r of results) assert.equal(r.workspaceVersion, version);
    ws.getBlockById('num_5').setFieldValue(7, 'NUM');
    assert.notEqual(workspaceVersion(ws), version);
  });
});

suite('Requests without a task', function() {
  test('intent, debug and edit send exactly what was evaluated when there is no task context', function() {
    const ws = loadProgram(18);
    const intent = buildIntentRequest(ws, {cursor: 'repeat_1', learnerSays: 'what is this'}).call;
    const edit = buildPlanRequest('EDIT_GUIDE', ws, {cursor: 'repeat_1', learnerSays: 'count by 5'}).call;
    const user = (call) => renderRequest(call, {model: 'm'}).payload.messages[1].content;
    assert.match(user(intent), /^Learner said: "what is this"\nAt the cursor: a controls_repeat_ext block\n\nProgram:\n/);
    assert.match(user(edit), /^Instruction: "count by 5"\n\nProgram:\n/);
    assert.deepEqual(Object.keys(intent.input), ['atCursor', 'program']);
    assert.deepEqual(Object.keys(edit.input), ['program']);
    const revised = buildPlanRequest('EDIT_GUIDE', ws, {learnerSays: 'by 3', taskContext: 'Task: edit, revision 2, working'}).call;
    assert.match(user(revised), /^Instruction: "by 3"\n\nTask so far:\nTask: edit, revision 2, working\n\nProgram:\n/);
  });

  test('a proposal question uses its own prompt with the task, and a reply saying it was done gets the repair round', async function() {
    const ws = loadProgram(18);
    const client = createFakeAgentClient([{voiceLine: 'I changed the number to 5.'}, {voiceLine: 'It would change the number to 5.'}]);
    const r = await runComprehend(ws, {client, learnerSays: 'why?', scope: 'proposal', taskContext: 'Offered: step 1 of 1, x'});
    assert.equal(client.calls[0].task, 'COMPREHEND_PROPOSAL');
    assert.equal(client.calls[0].input.taskContext, 'Offered: step 1 of 1, x');
    assert.isTrue(r.repaired);
    assert.isTrue(r.valid);
  });
});
