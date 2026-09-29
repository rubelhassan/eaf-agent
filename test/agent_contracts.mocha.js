/**
 * The fake agent must honour the same contract as the real one (src/agent/contracts.js).
 */

import {assert} from 'chai';
import {AgentError, AgentErrorCode} from '../src/agent/contracts.js';
import {createFakeAgentServices} from '../src/agent/fake_services.js';

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
