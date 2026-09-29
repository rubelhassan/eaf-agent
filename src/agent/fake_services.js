// @ts-check
/**
 * Deterministic stand-in for AgentServices (see contracts.js): canned, valid
 * results with a short delay, so UI flows and tests run without a model.
 * It mirrors what the UI expects from the real agent, not how good the real
 * output will be.
 */

import {AgentError, AgentErrorCode} from './contracts.js';

const HINTS = {
  nudge: [
    'What should this part of the program do? Try saying it in your own words.',
    'Read the blocks just before and after the question. What is missing between them?',
  ],
  point: [
    'Think about which toolbox category has blocks for this kind of job.',
    'Look at what the blocks around it use, and find the category that makes that.',
  ],
  kind: [
    'Try a block that gives what the question needs, then fill in its values.',
    'Pick the block that matches the need, and check each value inside it.',
  ],
};

const SCAFFOLD_TEXT = {
  value: {
    prompt: 'What value belongs here?',
    instruction: 'Work out what this part of the program needs to calculate or compare.',
    hints: ['Read the blocks around this question first.', 'Think about what kind of value fits here.'],
  },
  statement: {
    prompt: 'What should the program do here?',
    instruction: 'Add the step that makes the program do its job at this point.',
    hints: ['Say out loud what should happen at this point.', 'Think about which kind of block does that.'],
  },
  control: {
    prompt: 'How should the program repeat or decide here?',
    instruction: 'Choose the structure that controls the blocks inside it.',
    hints: ['Does something happen many times, or only sometimes?', 'Think about loops and conditions.'],
  },
  sequence: {
    prompt: 'Which steps come next?',
    instruction: 'Add the steps in the right order.',
    hints: ['List the steps in your own words first.', 'Think about which step must happen first.'],
  },
};

/**
 * @param {number} ms
 * @param {AbortSignal=} signal
 */
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AgentError(AgentErrorCode.ABORTED));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new AgentError(AgentErrorCode.ABORTED));
    }, {once: true});
  });
}

/**
 * @param {{delayMs?: number, unavailable?: boolean}=} options
 *     `unavailable` makes every call fail, to exercise the UI's fallbacks.
 * @returns {!import('./contracts.js').AgentServices}
 */
export function createFakeAgentServices({delayMs = 400, unavailable = false} = {}) {
  const guard = async (signal) => {
    await wait(delayMs, signal);
    if (unavailable) throw new AgentError(AgentErrorCode.UNAVAILABLE, 'Fake agent set to unavailable.');
  };

  return {
    async generateHint(request, {signal} = {}) {
      await guard(signal);
      const options = HINTS[request.level] || HINTS.nudge;
      return {hint: options[request.previousHints.length % options.length]};
    },

    async generateScaffold(request, {signal} = {}) {
      await guard(signal);
      const wanted = request.concept === 'auto' ?
        request.spots :
        request.spots.filter((spot) => spot.concepts.includes(request.concept));
      // Concept spots first, then others until the minimum is met.
      const chosen = [];
      const add = (spots, limit) => {
        for (const spot of spots) {
          if (chosen.length >= limit) return;
          if (!chosen.includes(spot) && !chosen.some((c) => spot.overlapsWith.includes(c.id))) chosen.push(spot);
        }
      };
      add(wanted, request.gapCount.max);
      add(request.spots, request.gapCount.min);
      return {
        concept: request.concept === 'auto' ? (chosen[0]?.concepts[0] || 'variables') : request.concept,
        gaps: chosen.map((spot) => ({spotId: spot.id, ...structuredClone(SCAFFOLD_TEXT[spot.kind])})),
      };
    },
  };
}
