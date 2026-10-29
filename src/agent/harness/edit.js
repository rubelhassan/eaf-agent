// @ts-check
// Edit reply: {steps: [{title, ops}], voiceLine}. Empty steps when the model asks a question.

// The newest edit prompt (on the server).
const LATEST = 'v4';

const isText = (v) => typeof v === 'string' && v.trim().length > 0;

export const EDIT_GUIDE = {
  version: LATEST,
  /** @returns {!Array<string>} */
  shape(o) {
    const problems = [];
    if (!isText(o.voiceLine)) problems.push('voiceLine must be text');
    if (!Array.isArray(o.steps)) problems.push('steps must be a list (empty when you ask a question)');
    return problems;
  },
  steps: (o) => (Array.isArray(o?.steps) ? o.steps : []),
  withoutSteps: (o) => ({...o, steps: []}),
  blockRefs: () => null,
};
