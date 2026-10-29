/**
 * The agent client contract: the fakes, the agent server's call handler, and how the harness uses them.
 * The server's own tests (server/test) run the same contract over HTTP with the browser's server client.
 */
import {assert} from 'chai';
import {loadProgram} from '../eval/runner/programs.js';
import {tuned} from '../eval/runner/arms/raw.js';
import {createFakeAgentClient, createOfflineAgentClient, createScriptedClient} from '../src/agent/model/fake.js';
import {createScriptedAgent} from './helpers/scripted_agent.js';
import {createAgentCore} from '../server/dist/core.js';
import {fixedRouting} from '../server/dist/models/router.js';
import {renderRequest} from '../server/src/prompts/render.js';
import {MODEL_SETTINGS, TASK_SETTINGS} from '../server/src/models/settings.js';
import {runIntent} from '../src/agent/harness/intent.js';
import {runPlanAction} from '../src/agent/harness/run.js';
import {createCoordinator} from '../src/interaction/coordinator.js';
import {setPolicy} from '../src/blocks/policy.js';

const CALL = {requestId: 'r_1', task: 'COMPREHEND', learnerText: 'what is this', input: {scope: 'program', wordLimit: 50, program: 'Stacks: none'}};

suite('Agent client contract', function() {
  const clients = {
    'fake': () => createFakeAgentClient([{voiceLine: 'Fine.'}]),
    'offline': () => createOfflineAgentClient(),
    'server core': () => createScriptedAgent([{voiceLine: 'Fine.'}]),
  };
  for (const [name, make] of Object.entries(clients)) {
    test(`${name}: a call returns ok with the reply text and meta, for the same request id`, async function() {
      const client = make();
      const r = await client.call(CALL);
      assert.equal(r.requestId, 'r_1');
      assert.equal(r.status, 'ok');
      assert.isString(r.reply);
      assert.isObject(r.meta);
      assert.doesNotThrow(() => client.result({requestId: 'r_1', valid: true, problems: []}));
    });
  }
});

suite('Server core', function() {
  test('routes the model per task and reports the prompt version that answered', async function() {
    const model = createScriptedClient([{intent: 'COMPREHEND', question: null}]);
    const agent = createAgentCore({routing: {...fixedRouting({model: 'big', provider: model, promptVersions: {DEBUG: 'v3'}}),
      model: (task) => (task === 'INTENT' ? 'small' : 'big')}});
    const intent = await agent.call({...CALL, task: 'INTENT', input: {atCursor: 'nothing', program: 'p'}});
    const debug = await agent.call({...CALL, requestId: 'r_2', task: 'DEBUG', input: {program: 'p'}});
    assert.deepEqual(model.sent.map((p) => p.model), ['small', 'big']);
    assert.equal(intent.meta.promptVersion, 'v2');
    assert.equal(debug.meta.promptVersion, 'v3');
  });

  test('the repair round continues the first request with the reply and the problems', async function() {
    const agent = createScriptedAgent(['not json', {voiceLine: 'Fine.'}]);
    await agent.call(CALL);
    await agent.call({...CALL, repair: {problems: ['the reply must be one JSON object']}});
    const repair = agent.sent[1];
    assert.deepEqual(repair.messages.slice(0, 2), agent.sent[0].messages);
    assert.deepEqual(repair.messages[2], {role: 'assistant', content: 'not json'});
    assert.include(repair.messages[3].content, '- the reply must be one JSON object');
  });

  test('a repair with no first call, a timeout and an abort come back as errors', async function() {
    const agent = createScriptedAgent([{voiceLine: 'x'}]);
    assert.include(await agent.call({...CALL, repair: {problems: ['x']}}), {status: 'error', code: 'INVALID_ENVELOPE'});
    for (const [error, code] of [['timeout', 'TIMEOUT'], ['aborted', 'ABORTED'], ['HTTP 500: error', 'MODEL']]) {
      const failing = createAgentCore({routing: fixedRouting({model: 'm', provider: {complete: async () => ({text: '', usage: {}, latencyMs: 1, error})}})});
      assert.include(await failing.call(CALL), {status: 'error', code});
    }
  });

  test('an envelope with unknown fields or wrong types is refused before any model call', async function() {
    const model = createScriptedClient([{voiceLine: 'x'}]);
    const core = createAgentCore({routing: fixedRouting({model: 'm', provider: model})});
    const bad = [{...CALL, extra: 1}, {...CALL, input: {...CALL.input, wordLimit: '50'}}, {...CALL, task: 'SING'},
      {...CALL, input: {scope: 'program', program: 'p'}}];
    for (const call of bad) assert.include(await core.call(call), {status: 'error', code: 'INVALID_ENVELOPE'});
    assert.isEmpty(model.sent);
  });

  test('inference overrides give the same request the eval built before', function() {
    const inputs = {INTENT: {atCursor: 'nothing'}, COMPREHEND: {scope: 'program', wordLimit: 50}, HINT: {level: 'nudge', levelRule: 'r',
      learnerLevel: 'beginner', question: 'q', instruction: '', needs: 'one block', intended: [], earlierHints: []}};
    const overrides = [{reasoningEffort: 'none'}, {temperature: 0.7}, {max_tokens: 100, reasoningEffort: 'minimal'}];
    for (const task of Object.keys(TASK_SETTINGS)) {
      for (const model of [...Object.keys(MODEL_SETTINGS), 'other/model']) {
        for (const o of overrides) {
          const call = {...CALL, task, input: {...inputs[task], program: 'p'}};
          const before = tuned(renderRequest(call, {model}).payload, task, {[task]: o});
          assert.equal(JSON.stringify(renderRequest(call, {model, overrides: o}).payload), JSON.stringify(before), `${task} ${model}`);
        }
      }
    }
  });
});

suite('Harness on the contract', function() {
  test('one request id for the call and its repair, the policy goes along, and the result is reported once', async function() {
    const ws = loadProgram(18);
    setPolicy(ws, {activity: 'quiz'});
    const agent = createFakeAgentClient([{intent: 'NOPE', question: null}, {intent: 'DEBUG', question: null}]);
    const r = await runIntent(ws, {client: agent, learnerSays: 'fix it'});
    assert.isTrue(r.valid);
    assert.equal(agent.calls[0].requestId, agent.calls[1].requestId);
    assert.deepEqual(agent.calls[0].policy, {activity: 'quiz', wholePlan: false});
    assert.include(agent.calls[1].repair.problems[0], 'intent must be one of');
    assert.deepEqual(agent.results, [{requestId: agent.calls[0].requestId, valid: true, problems: []}]);
  });

  test('a blocked call gets no repair round and no model reply', async function() {
    const say = "I'm sorry you're feeling that way.";
    const agent = createFakeAgentClient([() => ({status: 'blocked', say, reason: 'distress'})]);
    const r = await runIntent(loadProgram(18), {client: agent, learnerSays: 'words'});
    assert.lengthOf(agent.calls, 1);
    assert.isFalse(r.valid);
    assert.deepEqual(r.blocked, {say, reason: 'distress'});
  });

  test('a failed call gets no repair round and offers nothing', async function() {
    const agent = createFakeAgentClient([() => ({status: 'error', code: 'TIMEOUT'})]);
    const r = await runPlanAction('DEBUG', loadProgram(18), {client: agent, learnerSays: 'fix it'});
    assert.lengthOf(agent.calls, 1);
    assert.isNull(r.output);
    assert.deepEqual(r.problems, ['model error: TIMEOUT']);
  });

  test('the assistant says the blocked reply and asks again next time instead of caching it', async function() {
    const say = "I'm sorry you're feeling that way.";
    const agent = createFakeAgentClient([() => ({status: 'blocked', say, reason: 'distress'})]);
    const assistant = createCoordinator({workspace: loadProgram(18), client: agent, cursor: () => ({block: null})});
    assert.equal((await assistant.ask('words')).say, say);
    assert.equal((await assistant.ask('words')).say, say);
    assert.lengthOf(agent.calls, 2);
  });

  test('offline: the intent is routed by the learner\'s words', async function() {
    const offline = createOfflineAgentClient();
    const intent = async (text) => JSON.parse((await offline.call({...CALL, task: 'INTENT', learnerText: text})).reply).intent;
    assert.equal(await intent('it is broken'), 'DEBUG');
    assert.equal(await intent('add a print block'), 'EDIT');
    assert.equal(await intent('where is the loop'), 'SEARCH');
    assert.equal(await intent('what does this do'), 'COMPREHEND');
  });
});
