// @ts-check
/**
 * Contracts between the learning features (question blocks, hints, scaffolds)
 * and the agent. The plugin depends only on these shapes; prompts, models and the
 * harness behind them can change freely.
 *
 * A host passes an AgentServices object to attachCustomBlocks({agent}).
 * fake_services.js implements it deterministically for UI work and tests.
 *
 * Rules every implementation follows:
 * - Same request → same result (low temperature and/or a cache keyed by the request).
 * - Resolve with the result shape below, or reject with an AgentError. Never
 *   resolve with partial or unvalidated data; the plugin still checks the output
 *   and falls back to safe text, but relies on the shape.
 * - Honour `signal` (AbortSignal): reject with AgentErrorCode.ABORTED.
 * - Never put a question's hidden reference answer into any prompt.
 */

/** @typedef {'nudge' | 'point' | 'kind'} HintLevel */

/**
 * One AI hint for a question, built by the plugin (src/blocks/question/ai_hints.js).
 * @typedef {Object} HintRequest
 * @property {HintLevel} level  How much the hint may reveal.
 * @property {string} levelRule  Plain-language limit for this level.
 * @property {string} learnerLevel  'beginner' | 'intermediate' | 'advanced'
 * @property {{kind: 'value' | 'statement', prompt: string, instruction: string, needs: string,
 *     intendedBlocks: !Array<string>}} question  Readable block names, no type ids.
 * @property {string} programMarker  Marker comment where the question sits in `program`.
 * @property {string} program  The whole program as JavaScript.
 * @property {?string} learnerAnswer  The learner's current answer as code, or null.
 * @property {!Array<string>} previousHints  Hints already given, oldest first.
 * @property {string} teacherNote  Teacher's guidance for the AI ('' if none).
 * @property {string=} retryReason  Why the previous output was rejected (one retry).
 */

/**
 * @typedef {Object} HintResult
 * @property {string} hint  At most 2 short sentences, speech-ready (no code, markdown,
 *     emoji, colours or screen positions). Below 'kind' it must not name the exact block.
 */

/**
 * A place in the program that could become a question, found by the plugin's rules.
 * @typedef {Object} ScaffoldSpot
 * @property {string} id
 * @property {'value' | 'statement' | 'control' | 'sequence'} kind
 * @property {string} code  The spot's code (JavaScript), for the model to judge its role.
 * @property {!Array<string>} concepts  Concepts the spot's blocks belong to, e.g. ['loops'].
 * @property {!Array<string>} overlapsWith  Ids of spots sharing blocks with this one; never pick two of them.
 */

/**
 * @typedef {Object} ScaffoldRequest
 * @property {string} program  The whole program as JavaScript.
 * @property {!Array<!ScaffoldSpot>} spots  Only these may become questions.
 * @property {string} concept  'auto' or one of: variables, input-output, conditionals,
 *     loops, lists, text, math, functions.
 * @property {string} level  Learner level the scaffold is for.
 * @property {{min: number, max: number}} gapCount  How many spots to pick.
 * @property {string=} retryReason  Why the previous output was rejected (one retry).
 */

/**
 * @typedef {Object} ScaffoldGap
 * @property {string} spotId  One of the request's spot ids; no two gaps share or nest.
 * @property {string} prompt  Short question the learner hears ("How much does number grow each time?").
 * @property {string} instruction  One or two sentences of guidance, no code.
 * @property {!Array<string>} hints  Exactly 2 written hints, gentlest first; none names the exact block.
 */

/**
 * @typedef {Object} ScaffoldResult
 * @property {string} concept  The key concept the gaps were chosen for.
 * @property {!Array<!ScaffoldGap>} gaps  Within gapCount, in program order.
 */

/**
 * @typedef {Object} AgentCallOptions
 * @property {AbortSignal=} signal
 */

/**
 * @typedef {Object} AgentServices
 * @property {function(!HintRequest, AgentCallOptions=): !Promise<!HintResult>} generateHint
 * @property {function(!ScaffoldRequest, AgentCallOptions=): !Promise<!ScaffoldResult>} generateScaffold
 */

export const AgentErrorCode = Object.freeze({
  /** No model configured, offline, or the service refused. The UI falls back quietly. */
  UNAVAILABLE: 'unavailable',
  TIMEOUT: 'timeout',
  /** The model's output didn't match the result shape (after the implementation's own retry). */
  INVALID_OUTPUT: 'invalid-output',
  ABORTED: 'aborted',
});

export class AgentError extends Error {
  /**
   * @param {string} code  One of AgentErrorCode.
   * @param {string=} message
   */
  constructor(code, message) {
    super(message || code);
    this.name = 'AgentError';
    this.code = code;
  }
}

/** How long the UI waits before it gives up and uses its fallback. */
export const AGENT_TIMEOUT_MS = 15000;
