// Versioned system prompts. Never edit a registered version; add a new one and switch the default after an eval.
// The prototype's v1 prompts live with the eval baseline (eval/runner/baseline/prompts).

import intentV2 from './intent.v2.js';
import intentV3 from './intent.v3.js';
import comprehendV2 from './comprehend.v2.js';
import comprehendProposalV1 from './comprehend_proposal.v1.js';
import editV2 from './edit.v2.js';
import editV3 from './edit.v3.js';
import editV4 from './edit.v4.js';
import editV5 from './edit.v5.js';
import debugV2 from './debug.v2.js';
import debugV3 from './debug.v3.js';
import debugV4 from './debug.v4.js';
import hintV2 from './hint.v2.js';
import searchV2 from './search.v2.js';

/** @type {Record<string, Record<string, string>>} mode → version → prompt text */
export const PROMPTS = {
  INTENT: {v2: intentV2, v3: intentV3},
  COMPREHEND: {v2: comprehendV2},
  COMPREHEND_PROPOSAL: {v1: comprehendProposalV1},
  EDIT_GUIDE: {v2: editV2, v3: editV3, v4: editV4, v5: editV5},
  DEBUG: {v2: debugV2, v3: debugV3, v4: debugV4},
  HINT: {v2: hintV2},
  SEARCH: {v2: searchV2},
};

/** @type {Record<string, string>} mode → version used when none is requested */
export const DEFAULT_PROMPT_VERSIONS = {
  INTENT: 'v2',
  COMPREHEND: 'v2',
  COMPREHEND_PROPOSAL: 'v1',
  EDIT_GUIDE: 'v4',
  DEBUG: 'v4',
  HINT: 'v2',
  SEARCH: 'v2',
};

/**
 * @param {string} mode INTENT | COMPREHEND | COMPREHEND_PROPOSAL | EDIT_GUIDE | DEBUG | HINT | SEARCH
 * @param {string=} version Defaults to DEFAULT_PROMPT_VERSIONS[mode]
 * @returns {string}
 */
export function getPrompt(mode, version) {
  const v = version || DEFAULT_PROMPT_VERSIONS[mode];
  const text = PROMPTS[mode]?.[v];
  if (!text) throw new Error(`No prompt registered for ${mode} ${v}`);
  return text;
}
