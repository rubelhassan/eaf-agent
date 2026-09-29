/**
 * Prompt registry: versioned system prompts per mode.
 *
 * Add a new version as a new file (e.g. debug.v2.js), register it below, and switch
 * DEFAULT_PROMPT_VERSIONS only after it has been evaluated against the eval set.
 * Never edit a registered version in place; eval results reference it by id.
 */

import intentV1 from './intent.v1.js';
import comprehendV1 from './comprehend.v1.js';
import editV1 from './edit.v1.js';
import debugV1 from './debug.v1.js';
import hintV1 from './hint.v1.js';

/** @type {Record<string, Record<string, string>>} mode → version → prompt text */
export const PROMPTS = {
    INTENT: { v1: intentV1 },
    COMPREHEND: { v1: comprehendV1 },
    EDIT_GUIDE: { v1: editV1 },
    DEBUG: { v1: debugV1 },
    HINT: { v1: hintV1 },
};

/** @type {Record<string, string>} mode → version used when none is requested */
export const DEFAULT_PROMPT_VERSIONS = {
    INTENT: 'v1',
    COMPREHEND: 'v1',
    EDIT_GUIDE: 'v1',
    DEBUG: 'v1',
    HINT: 'v1',
};

/**
 * @param {string} mode INTENT | COMPREHEND | EDIT_GUIDE | DEBUG | HINT
 * @param {string=} version Defaults to DEFAULT_PROMPT_VERSIONS[mode]
 * @returns {string}
 */
export function getPrompt(mode, version) {
    const v = version || DEFAULT_PROMPT_VERSIONS[mode];
    const text = PROMPTS[mode]?.[v];
    if (!text) throw new Error(`No prompt registered for ${mode} ${v}`);
    return text;
}
