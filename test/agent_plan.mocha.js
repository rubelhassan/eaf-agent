/**
 * The op vocabulary, the plan executor, the program view and the harness flow,
 * on dataset programs (Program 18: skip count by 4; Program 30: weather tracker).
 */

import fs from 'fs';
import {assert} from 'chai';
import {loadItems} from '../eval/runner/items.js';
import {applyOps, itemWorkspace, loadProgram} from '../eval/runner/programs.js';
import {runProgram} from '../eval/runner/run_program.js';
import {score, normalizeAnswer} from '../eval/runner/scorers.js';
import {claimsApplied, impossiblePlaces, speechChecks} from '../src/agent/guardrails/speech.js';
import {applyOp, OpError} from '../src/agent/editor/ops.js';
import {applyPlan, validatePlan} from '../src/agent/editor/plan.js';
import {blockPositions, snapshot} from '../src/agent/context/snapshot.js';
import {checkPlanReply, runPlanAction} from '../src/agent/harness/run.js';
import {createScriptedClient} from '../src/agent/model/fake.js';
import {createScriptedAgent} from './helpers/scripted_agent.js';
import {runComprehend} from '../src/agent/harness/comprehend.js';
import {OFF_TOPIC_REPLY, runIntent} from '../src/agent/harness/intent.js';
import {findExact, runSearch} from '../src/agent/harness/search.js';
import {runHint} from '../src/agent/harness/hint.js';
import {expand} from '../eval/runner/run.js';
import {runHarness} from '../eval/runner/arms/harness.js';
import {parseReview} from '../eval/runner/review.js';

const items = Object.fromEntries(loadItems('dev').map((i) => [i.id, i]));
const printed = (ws) => runProgram(ws, []).lines;
const opError = (ws, op) => {
  try {
    applyOp(ws, op, {allowedTypes: ws.allowedTypeCatalog});
  } catch (e) {
    assert.instanceOf(e, OpError);
    return e.message;
  }
  assert.fail('expected an OpError');
};
const NEXT_PRINT = {type: 'text_print', id: 'p_next', inputs: {TEXT: {type: 'text', fields: {TEXT: 'Next!'}}}};

suite('Plan ops', function() {
  test('setField changes numbers, dropdowns and variables by name', function() {
    const ws = loadProgram(18);
    applyOp(ws, {op: 'setField', block: 'num_4', field: 'NUM', value: '5'});
    applyOp(ws, {op: 'setField', block: 'arith_1', field: 'OP', value: 'MINUS'});
    applyOp(ws, {op: 'setField', block: 'get_2', field: 'VAR', value: 'step'});
    assert.equal(ws.getBlockById('get_2').getField('VAR').getVariable().name, 'step');
    assert.deepEqual(printed(ws).slice(1, 3), ['undefined', 'undefined'], 'step is a new, unset variable');
    assert.match(opError(ws, {op: 'setField', block: 'arith_1', field: 'OP', value: 'PLUS'}), /valid values: .*ADD/);
    assert.match(opError(ws, {op: 'setField', block: 'num_4', field: 'NUMBER', value: 1}), /no field NUMBER; fields: NUM/);
  });

  test('insert after, before, into a statement input, and into a filled value input', function() {
    const ws = loadProgram(18);
    applyOp(ws, {op: 'insert', block: NEXT_PRINT, after: 'print_2'});
    assert.deepEqual(printed(ws).slice(1, 3), ['4', 'Next!']);
    applyOp(ws, {op: 'insert', block: {type: 'text_print', inputs: {TEXT: {type: 'text', fields: {TEXT: 'Hi'}}}}, before: 'print_1'});
    assert.equal(printed(ws)[0], 'Hi', 'before the first block of a stack makes a new top');
    applyOp(ws, {op: 'insert', block: {type: 'text_print', inputs: {TEXT: {type: 'text', fields: {TEXT: 'go'}}}}, parent: 'repeat_1', input: 'DO'});
    assert.deepEqual(printed(ws).slice(2, 5), ['4', 'Next!', 'go'], 'goes at the end of the loop body');
    applyOp(ws, {op: 'insert', block: {type: 'text_print', inputs: {TEXT: {type: 'text', fields: {TEXT: 'first'}}}}, before: 'set_2'});
    assert.equal(printed(ws)[2], 'first', 'before the first block of a statement input');
    applyOp(ws, {op: 'insert', block: {type: 'math_number', id: 'n10', fields: {NUM: 10}}, parent: 'arith_1', input: 'B'});
    assert.isNull(ws.getBlockById('num_4'), 'the old value is replaced');
    assert.equal(printed(ws)[3], '10');
  });

  test('move, delete and addBranch', function() {
    const ws = loadProgram(18);
    applyOp(ws, {op: 'move', block: 'set_2', after: 'print_2'});
    assert.deepEqual(printed(ws).slice(1, 3), ['0', '4'], 'a block can move below the blocks that followed it');
    applyOp(ws, {op: 'move', block: 'set_2', before: 'print_2'});
    applyOp(ws, {op: 'move', block: 'print_2', before: 'set_2'});
    assert.deepEqual(printed(ws).slice(1, 3), ['0', '4']);
    applyOp(ws, {op: 'delete', block: 'print_2'});
    assert.deepEqual(printed(ws), ["Let's skip count by 4!", 'Done!'], 'the loop body closes the gap');
    assert.match(opError(ws, {op: 'move', block: 'repeat_1', parent: 'set_2', input: 'VALUE'}), /into itself/);

    const weather = itemWorkspace(items['dev-30-debug-3']);
    applyOp(weather, {op: 'addBranch', block: 'if_1', branch: 'elseif'});
    const ifBlock = weather.getBlockById('if_1');
    assert.isOk(ifBlock.getInput('IF2') && ifBlock.getInput('DO2'));
    assert.equal(ifBlock.getInput('ELSE').connection.targetBlock().id, 'print_5', 'existing branches keep their blocks');
    assert.match(opError(weather, {op: 'addBranch', block: 'if_1', branch: 'else'}), /already has an else/);
  });

  test('rejects unknown ids and types, blocks outside the toolbox, and wrong kinds of block', function() {
    const ws = loadProgram(18);
    assert.match(opError(ws, {op: 'delete', block: 'print_99'}), /no block with id print_99/);
    assert.match(opError(ws, {op: 'insert', block: {type: 'no_such'}, after: 'print_1'}), /unknown block type/);
    assert.match(opError(ws, {op: 'insert', block: {type: 'colour_picker'}, parent: 'print_1', input: 'TEXT'}), /(not in the learner's toolbox|unknown block type)/);
    assert.match(opError(ws, {op: 'insert', block: {type: 'math_number'}, after: 'print_1'}), /value block/);
    assert.match(opError(ws, {op: 'insert', block: NEXT_PRINT, parent: 'arith_1', input: 'B'}), /statement block/);
    assert.match(opError(ws, {op: 'insert', block: {...NEXT_PRINT, id: 'print_2'}, after: 'print_1'}), /already used/);
    assert.match(opError(ws, {op: 'updateFields', block: 'num_4'}), /unknown op updateFields; ops: setField/);
  });

  test('never touches question blocks or learners\' answers', function() {
    const ws = loadProgram(18);
    applyOps(ws, [{op: 'wrapQuestion', block: 'num_4', id: 'q_step', question: {prompt: 'How much to add?'}}]);
    assert.match(opError(ws, {op: 'insert', block: {type: 'math_number', fields: {NUM: 4}}, parent: 'q_step', input: 'ANSWER'}), /question block/);
    assert.match(opError(ws, {op: 'delete', block: 'set_2'}), /holds a question/);
    applyOp(ws, {op: 'delete', block: 'set_1'});
    assert.isOk(ws.getBlockById('q_step'), 'a question further down the stack is not part of a deleted block');
    assert.match(opError(ws, {op: 'insert', block: {type: 'question'}, after: 'print_1'}), /made by teachers/);
    applyOps(ws, [{op: 'answerQuestion', question: 'q_step', xml: '<block type="math_number" id="ans"><field name="NUM">3</field></block>'}]);
    assert.match(opError(ws, {op: 'setField', block: 'ans', field: 'NUM', value: 4}), /learner's answer/);
  });
});

suite('Plan executor', function() {
  test('validates on a copy: later steps see earlier ones, the program is untouched', function() {
    const ws = loadProgram(18);
    const steps = [
      {title: 'Add a print', ops: [{op: 'insert', block: NEXT_PRINT, after: 'print_2'}]},
      {title: 'Change it', ops: [{op: 'setField', block: 'p_next', field: 'NUM', value: 1}]},
    ];
    const check = validatePlan(ws, steps);
    assert.isFalse(check.ok);
    assert.deepEqual(check.errors.map((e) => [e.step, e.op]), [[1, 0]]);
    assert.isNull(ws.getBlockById('p_next'), 'the dry run happens on a copy');
  });

  test('applies all or nothing, step by step, and rechecks what is left', function() {
    const ws = loadProgram(18);
    const steps = [
      {title: 'Count by 5', ops: [{op: 'setField', block: 'num_4', field: 'NUM', value: 5}]},
      {title: 'Six times', ops: [{op: 'setField', block: 'num_5', field: 'NUM', value: 6}]},
    ];
    const bad = [...steps, {title: 'Broken', ops: [{op: 'delete', block: 'nope'}]}];
    assert.deepEqual(applyPlan(ws, bad).applied, 0);
    assert.equal(printed(ws)[1], '4', 'nothing applied when any step fails');

    assert.isTrue(applyPlan(ws, steps, {count: 1}).ok);
    assert.deepEqual(printed(ws).slice(1, 3), ['5', '10']);
    ws.getBlockById('num_5').dispose(false);
    const rest = applyPlan(ws, steps, {from: 1});
    assert.isFalse(rest.ok, 'the learner removed the block step 2 changes');
    assert.equal(rest.errors[0].step, 1);
  });
});

suite('Program view', function() {
  test('every block with its id, fields and inputs; stacks, numbers and the cursor', function() {
    const ws = itemWorkspace(items['dev-30-debug-2']);
    const {text, toReal, toShort} = snapshot(ws, {cursor: 'print_3', allowedTypes: ['text_print', 'question']});
    assert.include(text, 'Stack A\n1. [b1] variables_set VAR=temp VALUE=([b2] text_prompt_ext TYPE=NUMBER');
    assert.include(text, '  DO:\n    [b10] variables_set VAR=temp VALUE=([b11] math_arithmetic OP=ADD');
    assert.include(text, 'Stack B\n1. [b16] controls_if');
    assert.include(text, 'Cursor: [b23], inside block 1 of stack B');
    assert.equal(toReal.get('b23'), 'print_3');
    assert.equal(blockPositions(ws).get('print_2'), 'inside block 3 of stack A');
    assert.equal(blockPositions(ws).get('for_1'), 'stack A, block 3');
    assert.equal(toShort.size, ws.getAllBlocks(false).length, 'every block gets a short id');
    assert.include(text, 'Toolbox block types: text_print\n'.trim());
    assert.notInclude(text, 'question,');
    assert.equal(blockPositions(ws, new Map([[ws.getTopBlocks(true)[1].id, 'C']])).get('print_6'), 'stack C, block 2');
  });

  test('a question shows its purpose and kind; its reference and intended blocks never appear', function() {
    const ws = loadProgram(18);
    applyOps(ws, [{op: 'wrapQuestion', block: 'num_4', id: 'q_step', question: {prompt: 'How much?', intendedTypes: ['math_random_int']}}]);
    const {text} = snapshot(ws);
    assert.match(text, /B=\(\[b\d+\] question \(empty, for the learner to answer: "How much\?", needs a value block\)\)/);
    assert.notInclude(text, 'NUM=4', 'the hidden reference (add 4) is not shown');
    assert.notInclude(text, 'math_random_int', 'nor its intended block types');
  });

  test('the cursor line names a field the cursor is on', function() {
    const {text} = snapshot(loadProgram(18), {cursor: 'num_5', field: 'NUM'});
    assert.include(text, 'Cursor: [b6] field NUM, inside block 3 of stack A');
    assert.include(snapshot(loadProgram(18), {cursor: 'num_5', field: 'NOPE'}).text, 'Cursor: [b6], inside');
  });

  test('procedure parameters and calls are shown', function() {
    const {text} = snapshot(loadProgram(41));
    assert.include(text, 'procedures_defreturn NAME="applyDiscount" PARAMS=(price)');
    assert.include(text, 'procedures_callreturn CALLS=applyDiscount ARG0 price=([b12] variables_get VAR=p)');
  });
});

suite('Harness flow', function() {
  // Program 18 in the view: print_2 is b11, num_0 is b4.
  const goodEdit = {steps: [{title: 'Add Next', ops: [{op: 'insert', block: NEXT_PRINT, after: 'b11'}]}],
    voiceLine: 'I can add a print block that says Next after each number. Should I do it?'};

  test('a valid reply is used as it is; a bad one gets one repair round with the problems', async function() {
    const ws = itemWorkspace(items['dev-18-edit-2']);
    const client = createScriptedAgent([{...goodEdit, steps: [{title: 'x', ops: [{op: 'insert', block: NEXT_PRINT, after: 'b99'}]}]}, goodEdit]);
    const sent = client.sent;
    const result = await runPlanAction('EDIT_GUIDE', ws, {cursor: 'print_2', learnerSays: 'print Next', client});
    assert.isTrue(result.valid);
    assert.isTrue(result.repaired);
    assert.include(sent[1].messages.at(-1).content, 'step 1, op 1: no block with id b99');
    assert.equal(result.output.steps[0].ops[0].after, 'print_2', 'short ids are mapped back');
    assert.isNull(ws.getBlockById('p_next'), 'the harness never applies; the learner approves first');
  });

  test('after a failed repair nothing unchecked is offered', async function() {
    const ws = itemWorkspace(items['dev-18-debug-1']);
    const bad = {issue: {severity: 'wrongResult', blocks: ['b4'], explanation: 'Starts at 4.'},
      fix: {title: 'x', ops: [{op: 'setField', block: 'b4', field: 'NUMBER', value: 0}]}, voiceLine: 'It starts at 4.'};
    const client = createScriptedAgent([bad]);
    const sent = client.sent;
    const result = await runPlanAction('DEBUG', ws, {client});
    assert.include(sent[1].messages.at(-1).content, 'b4 (math_number) has no field NUMBER', 'problems use the view ids');
    assert.isFalse(result.valid);
    assert.isNull(result.output.fix);
    assert.equal(result.output.issue.blocks[0], 'num_0');
    assert.deepEqual(checkPlanReply('DEBUG', ws, {issue: null, fix: null, voiceLine: 'Looks right.'}), []);
    assert.include(checkPlanReply('DEBUG', ws, 'nope')[0], 'one JSON object');
  });

  test('a spoken line with ids, markdown, a visual reference or a claim gets a repair; still broken, nothing is offered', async function() {
    const ws = itemWorkspace(items['dev-18-debug-1']);
    const bad = {issue: {severity: 'wrongResult', blocks: ['b4'], explanation: 'Starts at 4.'},
      fix: {title: 'Start at 0', ops: [{op: 'setField', block: 'b4', field: 'NUM', value: 0}]},
      voiceLine: 'I fixed `b4`, the green number block on the left. It starts at 4.'};
    const client = createScriptedAgent([bad]);
    const result = await runPlanAction('DEBUG', ws, {client});
    const repair = client.sent[1].messages.at(-1).content;
    for (const problem of ['names a block id', 'markdown', 'colour or screen position', 'says a change was made']) {
      assert.include(repair, problem);
    }
    assert.isTrue(result.repaired);
    assert.isFalse(result.valid);
    assert.isNull(result.output.fix, 'the checked fix is dropped with the line that offers it');

    const edit = itemWorkspace(items['dev-18-edit-2']);
    const claimed = {...goodEdit, voiceLine: "I've added a print block that says Next."};
    const fixed = await runPlanAction('EDIT_GUIDE', edit, {client: createScriptedAgent([claimed, goodEdit])});
    assert.isTrue(fixed.valid);
    assert.include(fixed.firstProblems, 'voiceLine says a change was made; nothing is changed');
    assert.lengthOf(fixed.output.steps, 1);
    const long = {steps: [], voiceLine: `${Array(50).fill('word').join(' ')} too?`};
    assert.deepEqual(checkPlanReply('EDIT_GUIDE', edit, long), ['voiceLine has 51 words; use at most 50']);
  });

  test('place wrappers and bare numbers are normalized, without a repair round', async function() {
    const reply = (ops, blocks = ['b7', 'b11']) => ({issue: {severity: 'wrongResult', blocks, explanation: 'Adds before printing.'},
      fix: {title: 'Print first', ops}, voiceLine: 'The loop adds four before it prints. Want me to move the print up?'});
    // Replies seen from real models.
    const variants = [
      reply([{op: 'move', block: 11, place: {before: 7}}], [7, 11]),
      reply([{op: 'move', block: 'b11', place: 'before:b7'}]),
      reply([{op: 'move', block: 'b11', place: {before: 'b7'}}]),
    ];
    for (const variant of variants) {
      const ws = itemWorkspace(items['dev-18-debug-1']);
      const client = createScriptedAgent([variant]);
      const result = await runPlanAction('DEBUG', ws, {client});
      assert.isTrue(result.valid, JSON.stringify(variant.fix.ops));
      assert.isFalse(result.repaired);
      assert.deepEqual(result.output.fix.ops[0], {op: 'move', block: 'print_2', before: 'set_2'});
      assert.include(result.adjusted, 'place wrapper');
    }
  });

  test('an id in a new block\'s inputs is dropped when a later op puts that block there', async function() {
    const ws = itemWorkspace(items['dev-18-edit-2']);
    // Seen from GPT: build flat, pointing at blocks a later op inserts.
    const flat = {steps: [{title: 'Add Next', ops: [
      {op: 'insert', block: {type: 'text_print', id: 'n1', inputs: {TEXT: 'n2'}}, after: 'b11'},
      {op: 'insert', block: {type: 'text', id: 'n2', fields: {TEXT: 'Next!'}}, parent: 'n1', input: 'TEXT'},
    ]}], voiceLine: 'I can print Next after each number. Should I do it?'};
    const result = await runPlanAction('EDIT_GUIDE', ws, {client: createScriptedAgent([flat])});
    assert.isTrue(result.valid);
    assert.include(result.adjusted, 'forward reference');
    assert.notProperty(result.output.steps[0].ops[0].block.inputs, 'TEXT');
  });

  test('an id used as a new block or a removed block gets a message the model can act on', async function() {
    const ws = itemWorkspace(items['dev-18-edit-2']);
    const existing = {steps: [{title: 'x', ops: [{op: 'insert', block: {type: 'text_print', inputs: {TEXT: 'b12'}}, after: 'b11'}]}], voiceLine: 'Should I?'};
    let client = createScriptedAgent([existing]);
    await runPlanAction('EDIT_GUIDE', ws, {client});
    assert.include(client.sent[1].messages.at(-1).content, 'not an id (b12); to use a block already in the program, move it');

    // Seen from GPT: replace a value, then try to reuse the block it replaced.
    const reuse = {steps: [
      {title: 'Join', ops: [{op: 'insert', block: {type: 'text_join', id: 'j1'}, parent: 'b11', input: 'TEXT'}]},
      {title: 'Reuse', ops: [{op: 'move', block: 'b12', parent: 'j1', input: 'ADD0'}]},
    ], voiceLine: 'Should I?'};
    client = createScriptedAgent([reuse]);
    await runPlanAction('EDIT_GUIDE', ws, {client});
    assert.include(client.sent[1].messages.at(-1).content, 'b12 was replaced by the new block in TEXT of b11 in step 1, so it is gone');
  });

  test('a place the harness cannot read gets a specific repair message', async function() {
    const ws = itemWorkspace(items['dev-18-debug-1']);
    const bad = {issue: {severity: 'wrongResult', blocks: ['b7'], explanation: 'x'},
      fix: {title: 'x', ops: [{op: 'move', block: 'b11', place: 'above the add block'}]}, voiceLine: 'Want me to fix it?'};
    const client = createScriptedAgent([bad]);
    await runPlanAction('DEBUG', ws, {client});
    assert.include(client.sent[1].messages.at(-1).content, 'directly in the op, not inside place');
  });
});

suite('Eval scorers (v2 answers and M1.5 fixes)', function() {
  const scoreItem = (id, output) => score(items[id], output, itemWorkspace(items[id]), []);

  test('v2 debug: the fix must point at the bug, apply, and correct the output', function() {
    const good = {issue: {severity: 'error', blocks: ['num_0'], explanation: 'The number starts at 4.'},
      fix: {title: 'Start at 0', ops: [{op: 'setField', block: 'num_0', field: 'NUM', value: 0}]},
      voiceLine: 'The number starts at 4, so the first number is 8. Want the fix?'};
    assert.isTrue(scoreItem('dev-18-debug-1', good).pass);
    const otherFix = {...good, issue: {...good.issue, blocks: ['print_2']},
      fix: {title: 'Print first', ops: [{op: 'move', block: 'print_2', before: 'set_2'}, {op: 'setField', block: 'num_0', field: 'NUM', value: 0}]}};
    assert.isTrue(scoreItem('dev-18-debug-1', otherFix).checks.foundBug, 'the print-first fix is accepted too');
    const control = scoreItem('dev-18-debug-3', {issue: {severity: 'info', blocks: ['repeat_1'], explanation: 'Fine.'}, fix: null, voiceLine: 'x'});
    assert.isTrue(control.pass, 'an info remark on a correct program is not a false alarm');
    assert.equal(control.checks.remarks, 1);
  });

  test('v2 edit: applies with the app executor and must not claim it is done', function() {
    const good = {steps: [{title: 'Add Next', ops: [{op: 'insert', block: NEXT_PRINT, after: 'print_2'}]}],
      voiceLine: 'I can add a print block saying Next after each number. Should I do it?'};
    assert.isTrue(scoreItem('dev-18-edit-2', good).pass, JSON.stringify(scoreItem('dev-18-edit-2', good).checks));
    const claimed = scoreItem('dev-18-edit-2', {...good, voiceLine: 'I added a print block that says Next.'});
    assert.isFalse(claimed.checks.noAppliedClaim);
    assert.isFalse(claimed.pass);
  });

  test('applied claims, number words, quoted symbols and the ops-fixed diagnostic', function() {
    assert.isTrue(claimsApplied('Done! The mark is now #.'));
    const ws = loadProgram(18);
    assert.isTrue(speechChecks('I will change the text from X to #. Should I do it?', ws).noMarkdown, 'a # mid-sentence is content');
    assert.isFalse(speechChecks('# Fix\nMove the print.', ws).noMarkdown, 'a # heading is markdown');
    assert.isTrue(claimsApplied("I've changed the loop to 6."));
    assert.isFalse(claimsApplied('Move the print into the loop and keep the Done! message after it.'));
    assert.isFalse(claimsApplied('I can change the repeat count from 5 to 6. Should I?'));
    assert.equal(normalizeAnswer('It has three categories'), 'it has 3 categories');
    const marks = scoreItem('dev-38-edit-2', {editPlan: {steps: []}, voiceLine: 'I can make the mark "#" instead of "X". Should I?'});
    assert.isTrue(marks.checks.noMarkdown);
    const prototype = scoreItem('dev-18-debug-1', {
      diagnostics: {issues: [{message: 'Starts at 4.', relatedIds: ['num_0'], severity: 'error'}],
        proposedFixes: [{title: 'Fix', patch: {operations: [{op: 'updateFields', targetBlockId: 'num_0', fields: {NUM: 0}}]}}]},
      voiceLine: 'The number starts at 4. Want the fix?'});
    assert.isFalse(prototype.pass, 'the prototype executor does not know updateFields');
    assert.isTrue(prototype.checks.passIfOpsFixed);
  });
});

suite('Prompt examples', function() {
  const programIds = () => fs.readdirSync('eval/datasets/programs').filter((f) => f.endsWith('.xml')).map((f) => Number(f.slice(0, -4)));
  test('example ids in the current prompts exist in no dataset program, so they never hint at an answer', async function() {
    const {DEFAULT_PROMPT_VERSIONS: versions, getPrompt} = await import('../server/src/prompts/index.js');
    const largest = Math.max(...programIds().map((id) => loadProgram(id).getAllBlocks(false).length));
    for (const [task, version] of Object.entries(versions)) {
      const ids = [...getPrompt(task, version).matchAll(/"b(\d+)"/g)].map((m) => Number(m[1]));
      for (const n of ids) assert.isAbove(n, largest, `${task} ${version} uses b${n}, a real id in some program`);
    }
  });
});

suite('Comprehend', function() {
  const ws18 = () => itemWorkspace(items['dev-18-comprehend-4']);
  const options = (client, extra = {}) => ({client, cursor: 'num_5', field: 'NUM', scope: 'field',
    learnerSays: 'What is this number?', ...extra});

  test('a good reply is used as is; the request names the scope, limit and field', async function() {
    const client = createScriptedAgent([{voiceLine: 'It is 5, the number of times the repeat block runs.'}]);
    const result = await runComprehend(ws18(), options(client));
    assert.isTrue(result.valid);
    assert.isFalse(result.repaired);
    const user = client.sent[0].messages[1].content;
    assert.include(user, 'Scope: field\nWord limit: 50');
    assert.include(user, 'Cursor: [b6] field NUM');
  });

  test('asking for more raises the limit to 100', async function() {
    const client = createScriptedAgent([{voiceLine: 'Fine.'}]);
    await runComprehend(ws18(), options(client, {more: true}));
    assert.include(client.sent[0].messages[1].content, 'Word limit: 100');
  });

  test('a speech rule break gets one repair round with the problems', async function() {
    const long = Array(60).fill('word').join(' ');
    const client = createScriptedAgent([{voiceLine: `Block b6 is the blue block. ${long}`}, {voiceLine: 'It is 5, how many times the loop runs.'}]);
    const result = await runComprehend(ws18(), options(client));
    assert.isTrue(result.valid);
    assert.isTrue(result.repaired);
    const repair = client.sent[1].messages[3].content;
    assert.include(repair, 'use at most 50');
    assert.include(repair, 'names a block id');
    assert.include(repair, 'colour or screen position');
  });

  test('still broken after the repair: returned, marked invalid', async function() {
    const client = createScriptedAgent([{voiceLine: 'See the block on the left.'}]);
    const result = await runComprehend(ws18(), options(client));
    assert.isFalse(result.valid);
    assert.equal(result.output.voiceLine, 'See the block on the left.');
    assert.equal(client.sent.length, 2);
  });

  test('speech checks: colours and screen places, not stack order or output', function() {
    const ws = ws18();
    assert.isFalse(speechChecks('Look at the green math block.', ws).noVisualRefs);
    assert.isFalse(speechChecks('It sits in the top-right corner.', ws).noVisualRefs);
    assert.isTrue(speechChecks('The block above it prints 4 on the screen.', ws).noVisualRefs);
    assert.isTrue(speechChecks('It prints "blue block" and stops.', ws).noVisualRefs, 'quoted program text');
    assert.isFalse(speechChecks('Block b3 sets number.', ws).noRawIds);
  });

  test('the scorer applies the word limit the item asks for', function() {
    const words = (n) => ({voiceLine: Array(n).fill('loop').join(' ')});
    const item = items['dev-38-comprehend-4'];
    assert.isNull(score(item, words(90), itemWorkspace(item)).pass);
    assert.isFalse(score({...item, more: false}, words(90), itemWorkspace(item)).pass);
  });
});

suite('Review sheet', function() {
  const key = {'x A': {run: 'r', model: 'm', item: 'x', repeat: 0, task: 'comprehend'}, 'x B': {run: 'r', model: 'n', item: 'x', repeat: 0}};
  const sheet = (aDone) => ['### x A', '', '> answer', '', '- [x] covers: one', '- [X] covers: two', '- [ ] mistake: wrong',
    '- [ ] mistake: something else is wrong (say what after the box)', `- [${aDone ? 'x' : ' '}] done`, '',
    '### x B', '- [x] covers: one', '- [ ] covers: two', '- [ ] mistake: wrong',
    '- [x] mistake: something else is wrong (say what after the box) wrong loop count', '- [x] done'].join('\n');

  test('ticks become ratings; pass needs every key point and no mistake', function() {
    const [a, b] = parseReview(sheet(true), key);
    assert.deepInclude(a, {model: 'm', keyPoints: [true, true], mistakes: [false, false], coverage: 1, pass: true});
    assert.deepInclude(b, {model: 'n', coverage: 0.5, pass: false, note: 'wrong loop count'});
  });

  test('only answers marked done count', function() {
    assert.deepEqual(parseReview(sheet(false), key).map((r) => r.label), ['x B']);
  });
});

suite('Spoken places', function() {
  // Program 18: one stack A of 4 blocks.
  test('places that cannot exist are found; real ones and "inside" pass', function() {
    const ws = loadProgram(18);
    assert.deepEqual(impossiblePlaces('The set block, block 7 of stack A, adds 4.', ws), ['block 7 of stack A']);
    assert.deepEqual(impossiblePlaces('It is in stack B, block 1.', ws), ['stack B, block 1']);
    assert.deepEqual(impossiblePlaces('The fifth block in stack A.', ws), ['fifth block in stack A']);
    assert.isEmpty(impossiblePlaces('The set block inside block 3 of stack A, then the second block in stack A.', ws));
    assert.isEmpty(impossiblePlaces('It prints "block 9 of stack A".', ws), 'quoted program text');
  });

  test('a debug reply with a good fix but an impossible place gets a repair; the fix is kept if it stays', async function() {
    const ws = itemWorkspace(items['dev-8-debug-1']);
    const reply = {issue: {severity: 'wrongResult', blocks: ['b5'], explanation: 'It adds 1.'},
      fix: {title: 'Multiply', ops: [{op: 'setField', block: 'b5', field: 'OP', value: 'MULTIPLY'}]},
      voiceLine: 'The math block, block 9 of stack A, adds 1. Want me to fix it?'};
    const client = createScriptedAgent([reply]);
    const result = await runPlanAction('DEBUG', ws, {client, learnerSays: 'It should double.'});
    assert.isTrue(result.repaired);
    assert.isFalse(result.valid);
    assert.match(result.firstProblems[0], /block 9 of stack A.*doesn't exist \(stack A has \d+ blocks\)/);
    assert.lengthOf(result.output.fix.ops, 1, 'the checked fix stays');
  });
});

suite('Intent', function() {
  const ask = (reply, learnerSays = 'x', cursor = 'print_1') => {
    const client = createScriptedAgent(Array.isArray(reply) ? reply : [reply]);
    return runIntent(loadProgram(18), {client, cursor, learnerSays}).then((r) => ({...r, client}));
  };

  test('v3 without a task: a relation is ignored, not repaired', async function() {
    const client = createScriptedAgent([{intent: 'EDIT', relation: 'new', answer: null, question: null}], {INTENT: 'v3'});
    const r = await runIntent(loadProgram(18), {client, cursor: 'print_1', learnerSays: 'add a print block'});
    assert.isTrue(r.valid);
    assert.isFalse(r.repaired);
    assert.isNull(r.output.relation);
    assert.lengthOf(client.sent, 1);
  });

  test('a label routes to its action; the learner\'s words are not rewritten', async function() {
    const r = await ask({intent: 'EDIT', question: null}, 'make it count by five');
    assert.equal(r.action, 'EDIT_GUIDE');
    assert.isNull(r.reply);
    assert.include(r.client.sent[0].messages[1].content, 'Learner said: "make it count by five"');
  });

  test('off-topic gets the fixed reply; clarification speaks the model\'s question', async function() {
    assert.equal((await ask({intent: 'OFF_TOPIC', question: null})).reply, OFF_TOPIC_REPLY);
    const r = await ask({intent: 'CLARIFICATION', question: 'Do you want to know what the repeat block does, or change it?'});
    assert.isNull(r.action);
    assert.match(r.reply, /repeat block/);
  });

  test('an unknown label or a clarification without a question gets the repair round', async function() {
    const r = await ask([{intent: 'EDIT_GUIDE'}, {intent: 'CLARIFICATION'}, {intent: 'EDIT'}]);
    assert.isTrue(r.repaired);
    assert.isFalse(r.valid);
    assert.match(r.firstProblems[0], /intent must be one of COMPREHEND/);
    assert.match(r.problems[0], /question must be text/);
  });

  test('the request says when the cursor is on a question', async function() {
    const ws = itemWorkspace(items['dev-intent-25']);
    const client = createScriptedAgent([{intent: 'HINT', question: null}]);
    const r = await runIntent(ws, {client, cursor: 'q_grow', learnerSays: 'help'});
    assert.equal(r.action, 'HINT');
    assert.include(client.sent[0].messages[1].content, 'At the cursor: an empty question block');
  });

  test('the eval harness arm applies a run file\'s inference overrides', async function() {
    const item = items['dev-intent-1'];
    const client = createScriptedClient([{intent: 'COMPREHEND', question: null}]);
    const plain = createScriptedClient([{intent: 'COMPREHEND', question: null}]);
    const ctx = {model: 'inception/mercury-2.5', repeat: 0};
    await runHarness(item, itemWorkspace(item), {...ctx, client, inference: {INTENT: {reasoningEffort: 'none'}}});
    await runHarness(item, itemWorkspace(item), {...ctx, client: plain});
    assert.notDeepEqual(client.sent[0].reasoning, plain.sent[0].reasoning);
  });

  test('scoring: v2 needs the exact label, v1 what its 4 labels allow', function() {
    const item = items['dev-intent-20'];
    const harness = {arm: 'harness'};
    assert.isTrue(score(item, {intent: 'SEARCH', question: null}, itemWorkspace(item), [], harness).pass);
    assert.isFalse(score(item, {intent: 'COMPREHEND', question: null}, itemWorkspace(item), [], harness).pass);
    assert.isTrue(score(item, {intent: 'COMPREHEND', confidence: 0.8}, itemWorkspace(item)).pass);
  });
});

suite('Search', function() {
  const ws30 = () => itemWorkspace(items['dev-30-search-1']);

  test('code answers a unique exact text or kind, with the place from the program', function() {
    assert.deepEqual(findExact(loadProgram(18), 'Which block says Done?'),
        {blockIds: ['print_3'], voiceLine: 'The print block that says Done!, block 4 of stack A.'});
    assert.deepEqual(findExact(ws30(), 'Find the if, else if, else block')?.blockIds, ['if_1']);
    assert.match(findExact(ws30(), 'find the if block').voiceLine, /inside block 3 of stack A/);
  });

  test('anything less certain goes to the model', function() {
    assert.isNull(findExact(ws30(), 'Find the if, else if, else block. How many categories does it have?'), 'a second question');
    assert.isNull(findExact(ws30(), 'Find the print block'), 'several print blocks');
    assert.isNull(findExact(loadProgram(18), 'Find the block that adds 4 each time the loop runs.'), 'no exact name');
    assert.isNull(findExact(loadProgram(38), 'Which block decides where the X goes?'), 'one letter is too little to match');
  });

  test('a code answer makes no call; the model path maps ids and checks the speech', async function() {
    const none = createScriptedAgent([]);
    const byCode = await runSearch(loadProgram(18), {client: none, learnerSays: 'Which block says Done?'});
    assert.isTrue(byCode.byCode);
    assert.lengthOf(none.sent, 0);
    const client = createScriptedAgent([{blocks: ['b8'], voiceLine: 'The add block, block 8 of stack A.'},
      {blocks: ['b8'], voiceLine: 'The add block, inside block 3 of stack A.'}]);
    const r = await runSearch(loadProgram(18), {client, learnerSays: 'Find the block that adds 4.'});
    assert.isFalse(r.byCode);
    assert.isTrue(r.repaired);
    assert.isTrue(r.valid);
    assert.deepEqual(r.output.blockIds, ['arith_1']);
  });

  test('scoring: a spoken place must be the found block\'s place', function() {
    const item = items['dev-18-search-1'];
    const ws = itemWorkspace(item);
    assert.isTrue(score(item, {blockIds: ['arith_1'], voiceLine: 'The add block, inside block 3 of stack A.'}, ws).pass);
    assert.isFalse(score(item, {blockIds: ['arith_1'], voiceLine: 'The add block, block 3 of stack A.'}, ws).pass, 'not inside');
    assert.isTrue(score(item, {blockIds: ['arith_1'], voiceLine: 'The add block in the repeat loop.'}, ws).pass, 'described only');
    assert.isTrue(score(item, {blockIds: ['arith_1'], voiceLine: 'It is inside the repeat loop, which is block 3 of stack A.'}, ws).pass,
        'the place of a block holding it, after inside');
    assert.isFalse(score(item, {blockIds: ['arith_1'], voiceLine: 'Block 3 of stack A. It holds the add block inside.'}, ws).pass,
        'inside in another sentence');
  });
});

suite('Hint', function() {
  const hintItem = (id) => expand([items[id]]).find((i) => i.level === 'point');

  test('the request has the level rule and the view; never the hidden reference', async function() {
    const item = hintItem('dev-18-hint-1');
    const client = createScriptedAgent([{hint: 'Which Math idea makes a number grow?'}]);
    const r = await runHint(itemWorkspace(item), {client, gap: item.gap, level: 'point'});
    assert.isTrue(r.valid);
    const user = client.sent[0].messages[1].content;
    assert.include(user, 'Level: point. Name the idea or the toolbox category');
    assert.include(user, 'question (empty, for the learner to answer');
    assert.notInclude(user, 'NUM=4', 'the reference (number + 4) stays hidden');
  });

  test('naming the block below kind level gets a repair with the reason', async function() {
    const item = hintItem('dev-18-hint-1');
    const client = createScriptedAgent([{hint: 'Use the arithmetic block.'}, {hint: 'Look in the Math category.'}]);
    const r = await runHint(itemWorkspace(item), {client, gap: item.gap, level: 'point'});
    assert.isTrue(r.repaired);
    assert.include(r.firstProblems[0], 'Do not name the exact block');
    assert.equal(r.output.hint, 'Look in the Math category.');
  });
});
