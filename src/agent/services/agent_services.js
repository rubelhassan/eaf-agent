// @ts-check
// AgentServices on the harness. Scaffolds use the fake for now.

import {AgentError, AgentErrorCode} from './contracts.js';
import {createFakeAgentServices} from './fake_services.js';
import {runHint} from '../harness/hint.js';

/**
 * @param {{client: !import('../model/agent_client.js').AgentClient, workspace: function(): !Blockly.Workspace}} options
 *     workspace: the program the questions are in (read at call time)
 * @returns {!import('./contracts.js').AgentServices}
 */
export function createAgentServices({client, workspace}) {
  const fake = createFakeAgentServices();
  return {
    async generateHint(request, {signal} = {}) {
      if (signal?.aborted) throw new AgentError(AgentErrorCode.ABORTED);
      let result;
      try {
        result = await runHint(workspace(), {
          client, signal, gap: request.gap, level: request.level, previousHints: request.previousHints || [],
        });
      } catch (e) {
        throw new AgentError(signal?.aborted ? AgentErrorCode.ABORTED : AgentErrorCode.UNAVAILABLE, e?.message);
      }
      if (signal?.aborted) throw new AgentError(AgentErrorCode.ABORTED);
      // No model answer (refused or failed) is not a bad answer: the UI falls back quietly.
      if (result.blocked || result.error) throw new AgentError(AgentErrorCode.UNAVAILABLE, result.problems.join('; '));
      if (!result.valid) throw new AgentError(AgentErrorCode.INVALID_OUTPUT, result.problems.join('; '));
      return {hint: result.output.hint};
    },
    generateScaffold: (request, options) => fake.generateScaffold(request, options),
  };
}
