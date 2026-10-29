/**
 * The fake agent must honour the same contract as the real one (src/agent/services/contracts.js).
 */

import {assert} from 'chai';
import {AgentError, AgentErrorCode} from '../src/agent/services/contracts.js';
import {createFakeAgentServices} from '../src/agent/services/fake_services.js';
import {createAgentServices} from '../src/agent/services/agent_services.js';
import {createScriptedAgent} from './helpers/scripted_agent.js';
import {loadItems} from '../eval/runner/items.js';
import {itemWorkspace} from '../eval/runner/programs.js';

suite('Fake agent services', function() {
  const agent = createFakeAgentServices({delayMs: 0});
  const spot = (id, kind, code, concepts, overlapsWith = []) => ({id, kind, code, concepts, overlapsWith});
  const spots = [
    spot('a', 'value', '0', ['math']),
    spot('b', 'value', 'number + 4', ['math', 'variables'], ['d']),
    spot('c', 'statement', 'window.alert(number);', ['input-output'], ['d']),
    spot('d', 'control', 'for (...) { number = number + 4; }', ['loops'], ['b', 'c']),
  ];

  test('hints follow the level and differ from previous ones', async function() {
    const request = {level: 'point', previousHints: []};
    const first = await agent.generateHint(request);
    const second = await agent.generateHint({...request, previousHints: [first.hint]});
    assert.isString(first.hint);
    assert.notEqual(first.hint, second.hint);
  });

  test('a scaffold picks known spots within the gap count, without overlap', async function() {
    const result = await agent.generateScaffold({program: '', spots, concept: 'auto', level: 'beginner', gapCount: {min: 1, max: 2}});
    assert.isAtMost(result.gaps.length, 2);
    assert.isAtLeast(result.gaps.length, 1);
    for (const gap of result.gaps) {
      assert.include(spots.map((s) => s.id), gap.spotId);
      assert.lengthOf(gap.hints, 2);
    }
    const ids = result.gaps.map((g) => g.spotId);
    assert.isFalse(ids.some((id) => spots.find((s) => s.id === id).overlapsWith.some((o) => ids.includes(o))), 'no overlap');
  });

  test('a scaffold prefers spots of the requested concept', async function() {
    const result = await agent.generateScaffold({program: '', spots, concept: 'loops', level: 'intermediate', gapCount: {min: 1, max: 1}});
    assert.deepEqual(result.gaps.map((g) => g.spotId), ['d']);
    assert.equal(result.concept, 'loops');
  });

  test('calls can be aborted and can simulate an unavailable agent', async function() {
    const slow = createFakeAgentServices({delayMs: 50});
    const controller = new AbortController();
    const call = slow.generateHint({level: 'nudge', previousHints: []}, {signal: controller.signal});
    controller.abort();
    const aborted = await call.catch((e) => e);
    assert.instanceOf(aborted, AgentError);
    assert.equal(aborted.code, AgentErrorCode.ABORTED);

    const down = createFakeAgentServices({delayMs: 0, unavailable: true});
    const error = await down.generateHint({level: 'nudge', previousHints: []}).catch((e) => e);
    assert.equal(error.code, AgentErrorCode.UNAVAILABLE);
  });
});

suite('Agent services on the harness', function() {
  const item = loadItems('dev').find((i) => i.id === 'dev-18-hint-1');

  test('a hint request runs the harness hint on the program; a bad hint fails with invalid-output', async function() {
    const ws = itemWorkspace(item);
    const good = createScriptedAgent([{hint: 'Look in the Math category.'}]);
    const agent = createAgentServices({client: good, workspace: () => ws});
    const result = await agent.generateHint({gap: item.gap, level: 'point', previousHints: []});
    assert.equal(result.hint, 'Look in the Math category.');
    assert.include(good.sent[0].messages[1].content, 'Level: point');

    const bad = createAgentServices({client: createScriptedAgent([{hint: 'Use the arithmetic block.'}]), workspace: () => ws});
    const error = await bad.generateHint({gap: item.gap, level: 'point', previousHints: []}).catch((e) => e);
    assert.equal(error.code, AgentErrorCode.INVALID_OUTPUT);
  });

  test('an aborted call rejects with aborted', async function() {
    const controller = new AbortController();
    controller.abort();
    const agent = createAgentServices({client: createScriptedAgent([{hint: 'x'}]), workspace: () => itemWorkspace(item)});
    const error = await agent.generateHint({gap: item.gap, level: 'nudge', previousHints: []}, {signal: controller.signal}).catch((e) => e);
    assert.equal(error.code, AgentErrorCode.ABORTED);
  });
});
