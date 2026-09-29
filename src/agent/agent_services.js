// @ts-check
/**
 * AgentServices (contracts.js) backed by the prototype AgentController.
 *
 * TODO(agentic phase): replace with the evaluated harness (prompt versions, model
 * choice, retries, caching). Hints use the prototype hint.v1 call as is; scaffolds
 * use the fake until a scaffold prompt exists.
 */

import {AgentError, AgentErrorCode} from './contracts.js';
import {createFakeAgentServices} from './fake_services.js';

/**
 * @param {!Object} controller  An AgentController.
 * @returns {!import('./contracts.js').AgentServices}
 */
export function createAgentServices(controller) {
  const fake = createFakeAgentServices();
  return {
    async generateHint(request, {signal} = {}) {
      if (signal?.aborted) throw new AgentError(AgentErrorCode.ABORTED);
      try {
        const hint = await controller.generateHint(request);
        if (typeof hint !== 'string' || !hint.trim()) throw new AgentError(AgentErrorCode.INVALID_OUTPUT);
        return {hint};
      } catch (e) {
        throw e instanceof AgentError ? e : new AgentError(AgentErrorCode.UNAVAILABLE, e?.message);
      }
    },
    generateScaffold: (request, options) => fake.generateScaffold(request, options),
  };
}
