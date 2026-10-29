// The agent server's own call handler over a scripted model, for tests that check the rendered requests (in `sent`).
// Needs the server built (npm test builds it first).

import {createAgentCore} from '../../server/dist/core.js';
import {createGuard} from '../../server/dist/guard/index.js';
import {fixedRouting} from '../../server/dist/models/router.js';
import {createScriptedClient} from '../../src/agent/model/fake.js';

/**
 * @param {!Array<string|!Object>} replies
 * @param {!Object<string, string>=} promptVersions
 * @param {{guarded?: boolean}=} options  guarded: the server's screening and masking (patterns and cues, no name model)
 */
export function createScriptedAgent(replies, promptVersions = {}, {guarded = false} = {}) {
  const model = createScriptedClient(replies);
  const guard = guarded ? createGuard({ner: null}) : null;
  return Object.assign(createAgentCore({routing: fixedRouting({model: 'm', provider: model, promptVersions}), guard}), {sent: model.sent});
}
