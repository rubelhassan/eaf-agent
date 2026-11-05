/**
 * The eval scorers must judge known-good and known-bad answers correctly before
 * any model output is scored with them.
 */

import {assert} from 'chai';
import {checkItem, learnerLineProblems, loadItems} from '../eval/runner/items.js';
import {itemWorkspace} from '../eval/runner/programs.js';
import {score, ungroundedIds} from '../eval/runner/scorers.js';

const items = Object.fromEntries(loadItems('dev').map((i) => [i.id, i]));
const scoreItem = (id, output, calls = [], extra = {}) => {
  const item = {...items[id], ...extra};
  return score(item, output, itemWorkspace(item), calls);
};
const fix = (ops, related) => ({
  diagnostics: {issues: [{message: 'The start value is wrong.', relatedIds: related, severity: 'error', type: 'logic'}],
    proposedFixes: [{title: 'Fix', patch: {operations: ops}}]},
  voiceLine: 'The number starts at 4, so the first number printed is 8.',
});

suite('Eval scorers', function() {
  test('debug: a correct fix passes, a wrong fix or a missed bug fails', function() {
    const good = scoreItem('dev-18-debug-1', fix([{op: 'setField', blockId: 'num_0', field: 'NUM', value: 0}], ['num_0']));
    assert.isTrue(good.pass, JSON.stringify(good.checks));
    const wrong = scoreItem('dev-18-debug-1', fix([{op: 'setField', blockId: 'num_4', field: 'NUM', value: 3}], ['num_0']));
    assert.isFalse(wrong.pass);
    assert.isFalse(wrong.checks.outputCorrectAfterFix);
    const missed = scoreItem('dev-18-debug-1', fix([{op: 'setField', blockId: 'num_0', field: 'NUM', value: 0}], ['print_3']));
    assert.isFalse(missed.checks.foundBug);
  });

  test('ids: existing blocks must be named by their ids; new blocks may have any id', function() {
    const ws = itemWorkspace(items['dev-18-edit-2']);
    assert.deepEqual(ungroundedIds(ws, [
      {op: 'createBlock', blockType: 'text_print', targetBlockId: 'my_new_print'},
      {op: 'connect', parentConn: {blockId: 'print_2', kind: 'NEXT'}, childConn: {blockId: 'my_new_print', kind: 'PREVIOUS'}},
    ]), []);
    assert.deepEqual(ungroundedIds(ws, [{op: 'setField', blockId: 'the_print_block', field: 'TEXT', value: 'x'}]), ['the_print_block']);
  });

  test('edit: a plan that creates blocks applies headless', function() {
    const plan = {editPlan: {steps: [{title: 'Add Next!', patch: {operations: [
      {op: 'createBlock', blockType: 'text', targetBlockId: 'new_text', fields: {TEXT: 'Next!'}},
      {op: 'createBlock', blockType: 'text_print', targetBlockId: 'new_print'},
      {op: 'connect', parentConn: {blockId: 'new_print', kind: 'INPUT', inputName: 'TEXT'}, childConn: {blockId: 'new_text', kind: 'OUTPUT'}},
      {op: 'connect', parentConn: {blockId: 'print_2', kind: 'NEXT'}, childConn: {blockId: 'new_print', kind: 'PREVIOUS'}},
    ]}}]}, voiceLine: 'Added a print block after the number.'};
    const result = scoreItem('dev-18-edit-2', plan);
    assert.isTrue(result.checks.planApplied, JSON.stringify(result.checks.planErrors));
    assert.isTrue(result.checks.grounded);
    assert.isTrue(result.pass, JSON.stringify(result.checks));
  });

  test('debug: the no-bug control passes only with no issue', function() {
    const quiet = {diagnostics: {issues: [], proposedFixes: []}, voiceLine: 'Your program looks right.'};
    assert.isTrue(scoreItem('dev-18-debug-3', quiet).pass);
    assert.isFalse(scoreItem('dev-18-debug-3', fix([], ['num_0'])).pass, 'a false alarm fails');
  });

  test('edit: a plan that reaches the goal passes; one that breaks untouched blocks fails', function() {
    const plan = (ops) => ({editPlan: {steps: [{title: 'Change', patch: {operations: ops}}]}, voiceLine: 'Changed it.'});
    const good = scoreItem('dev-38-edit-1', plan([{op: 'setField', blockId: 'num_3', field: 'NUM', value: 4}]));
    assert.isTrue(good.pass, JSON.stringify(good.checks));
    const off = scoreItem('dev-38-edit-1', plan([{op: 'setField', blockId: 'num_3', field: 'NUM', value: 5}]));
    assert.isFalse(off.checks.outputMatchesGoal);
    const unknown = scoreItem('dev-38-edit-1', plan([{op: 'updateFields', targetBlockId: 'num_3', fields: {NUM: 4}}]));
    assert.isFalse(unknown.checks.planApplied, 'the prototype op mismatch shows up as a failed plan');
  });

  test('search: the best match must be accepted; spoken text must not leak ids', function() {
    assert.isTrue(scoreItem('dev-18-search-1', {blockIds: ['arith_1'], voiceLine: 'It is the math block inside the repeat loop.'}).pass);
    assert.isFalse(scoreItem('dev-18-search-1', {blockIds: ['print_3'], voiceLine: 'Here it is.'}).pass);
    const leak = scoreItem('dev-18-search-1', {blockIds: ['arith_1'], voiceLine: 'It is block arith_1.'});
    assert.isFalse(leak.checks.noRawIds);
  });

  test('hint: level rules are checked in code; quality waits for the judges', function() {
    const ok = scoreItem('dev-18-hint-1', {hint: 'What changes each time the loop runs?'}, [], {level: 'nudge'});
    assert.isNull(ok.pass);
    assert.isTrue(ok.checks.levelRules);
    const code = scoreItem('dev-18-hint-1', {hint: 'Write number = number + 4;'}, [], {level: 'nudge'});
    assert.isFalse(code.pass);
  });

  test('guardrails: personal info in an outgoing request fails', function() {
    const item = Object.values(items).find((i) => i.task === 'guardrails' && i.category === 'pii-chat');
    const leaked = [{payload: {messages: [{role: 'user', content: item.learnerSays}]}}];
    assert.isFalse(scoreItem(item.id, {}, leaked).checks.noPersonalInfoSent);
    assert.isTrue(scoreItem(item.id, {}, [{payload: {messages: [{role: 'user', content: 'why is my loop wrong?'}]}}]).checks.noPersonalInfoSent);
  });

  test("intent: the raw arm accepts the labels today's classifier can give", function() {
    const search = Object.values(items).find((i) => i.task === 'intent' && i.expected.intent === 'SEARCH');
    assert.isTrue(scoreItem(search.id, {intent: 'COMPREHEND'}).pass);
    assert.isFalse(scoreItem(search.id, {intent: 'EDIT_GUIDE'}).pass);
  });
});

suite('Inference settings', function() {
  test('task settings: debug and edit get 2048 tokens; reasoning is low effort and excluded', async function() {
    const {PromptBuilder} = await import('../eval/runner/baseline/prompt_builder.js');
    const builder = new PromptBuilder({model: 'some/other-model'});
    const debug = builder.buildChatPayload({mode: 'DEBUG', input: {}});
    assert.equal(debug.max_tokens, 2048);
    assert.deepEqual(debug.reasoning, {effort: 'low', exclude: true});
    assert.deepEqual(debug.response_format, {type: 'json_object'});
    assert.notProperty(debug, 'include_reasoning');
    assert.deepEqual(debug.provider, {data_collection: 'deny'}, 'models not listed are not pinned, and no provider keeps the data');
    assert.equal(builder.buildChatPayload({mode: 'EDIT_GUIDE', input: {}}).max_tokens, 2048);
    assert.equal(builder.buildIntentPayload({userInput: 'hi', contextSummary: {}}).max_tokens, 800);
  });

  test('model settings: pinned endpoint, no fallbacks, temperature only where supported', async function() {
    const {inferenceFor} = await import('../server/src/models/settings.js');
    const deepseek = inferenceFor('DEBUG', {model: 'deepseek/deepseek-v4.1-flash'});
    assert.deepEqual(deepseek.provider, {order: ['deepinfra/fp8'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny'});
    assert.equal(deepseek.temperature, 0.25);
    const gpt = inferenceFor('DEBUG', {model: 'openai/gpt-5.6-luna-pro'});
    assert.deepEqual(gpt.provider.order, ['azure']);
    assert.notProperty(gpt, 'temperature', 'the Azure endpoint does not accept temperature');
    assert.deepEqual(gpt.reasoning, {effort: 'low', exclude: true});
    assert.deepEqual(inferenceFor('INTENT', {model: 'inception/mercury-2.5'}).provider.order, ['inception']);
  });

  test('a budget-only model gets at most 30% of max_tokens for reasoning', async function() {
    const {TASK_SETTINGS, reasoningFor} = await import('../server/src/models/settings.js');
    const budgetModel = {endpoint: 'x', temperature: true, reasoning: 'budget'};
    for (const task of Object.values(TASK_SETTINGS)) {
      const reasoning = reasoningFor(task, budgetModel);
      assert.notProperty(reasoning, 'effort', 'effort and a budget are never sent together');
      assert.isAtMost(reasoning.max_tokens, task.max_tokens * 0.3);
    }
    assert.deepEqual(reasoningFor(TASK_SETTINGS.DEBUG, {reasoning: 'effort'}), {effort: 'low', exclude: true});
  });
});

suite('Learner lines', function() {
  const run = (lines, inputs = []) => [{inputs, lines}];
  test('what the learner sees must be printed now, what they want by the reference', function() {
    const before = run(['75', '80', 'HOT!', '85', 'HOT!']);
    const reference = run(['75', '80', 'WARM', '85', 'WARM']);
    assert.isEmpty(learnerLineProblems('Now 80 degrees says HOT instead of WARM! Why?', before, reference));
    assert.deepEqual(learnerLineProblems('Now 90 degrees says WARM instead of HOT! Why?', before, reference), [
      'learner says they see 90, but the program never prints it',
      'learner says they see WARM, but the program never prints it',
      'learner wants HOT, but the correct program never prints it',
    ]);
  });
  test('numbers match whole, words may sit inside text, typed input counts as seen', function() {
    assert.isNotEmpty(learnerLineProblems('It says 5.', run(['15']), run([])));
    assert.isEmpty(learnerLineProblems('I typed 4 but it says 5.', run(['5'], ['4']), run([])));
    assert.isEmpty(learnerLineProblems('Rows start with undefined.', run(['undefinedXOO']), run([])));
  });
  test('every dev item passes check-items', function() {
    // Builds and runs every item's programs.
    this.timeout(20000);
    for (const item of loadItems('dev')) assert.deepEqual(checkItem(item).problems, [], item.id);
  });
});
