// @ts-check
// Spoken replies must be speech-ready: no ids or markdown, short, real places, and no claim that a change was made.

import {newStackLetters, stackSizes} from '../context/snapshot.js';

export const SPOKEN_WORD_LIMIT = 50;
export const SPOKEN_WORD_LIMIT_MORE = 100;

// Quoted values ("#", "*") are program content, not formatting.
const withoutQuotes = (text) => text.replace(/"[^"]*"|“[^”]*”|‘[^’]*’/g, '""');

// "Done" only as a reply ("Done! ..."), not a program's own "Done!" mid-sentence.
const APPLIED_CLAIM = new RegExp(String.raw`(?:^|[.!?]\s+)(?:done|all set)\b|\bI(?:'ve|’ve| have)?\s+(?:just\s+)?` +
  String.raw`(?:changed|added|removed|deleted|moved|fixed|updated|replaced|put|swapped|inserted|connected|switched)\b|` +
  String.raw`\b(?:has|have) been (?:changed|added|removed|deleted|moved|fixed|updated|replaced)\b`, 'gi');
const QUESTION_BEFORE_I = /\b(?:should|could|can|may|might|would|shall|will|did|have|had)\s+$/i;

// Learners may not see colours or the screen; "above" and "below" are fine, they follow the stack.
const COLOUR = /\b(?:red|orange|yellow|green|blue|purple|pink|teal|cyan|magenta|grey|gray|brown)\b(?:\s+\w+){0,2}\s+blocks?\b/i;
const SCREEN = /\b(?:on|to|at|in) the (?:left|right)\b|\b(?:left|right)[- ]hand\b|\b(?:top|bottom|upper|lower)[- ](?:left|right)\b|\b(?:top|bottom|side|corner|middle) of the screen\b/i;
const VIEW_ID = /\bb\d+\b/;
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|[0-9#*]\uFE0F?\u20E3/u;
// Hint cleanup can join table rows onto one line, leaving adjacent row borders.
const PIPE_TABLE = /^[^\n]*\|[^\n]*\r?\n[^\n]*\||\|[ \t]*\|/m;

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const NUMBER = String.raw`(\d+)(?:st|nd|rd|th)?|(${ORDINALS.join('|')})`;
// "block 3 of stack A", "the second block in stack A", "stack A, block 3"
const PLACE = new RegExp(String.raw`\b(?:block (?:${NUMBER})|(?:${NUMBER}) block) (?:of|in) stack ([A-Z])\b|\bstack ([A-Z]),? block (\d+)\b`, 'gi');

/**
 * @returns {!Array<{text: string, n: number, stack: string, inside: boolean, before: string}>} the places a text names;
 *     before: the same sentence up to the place
 */
export function spokenPlaces(text) {
  const plain = withoutQuotes(text);
  return [...plain.matchAll(PLACE)].map((m) => {
    const word = m[2] || m[4];
    const head = plain.slice(0, m.index);
    return {
      text: m[0],
      before: head.slice(head.search(/[^.!?]*$/)),
      n: Number(m[1] || m[3] || m[7]) || (word ? ORDINALS.indexOf(word.toLowerCase()) + 1 : 0),
      stack: (m[5] || m[6]).toUpperCase(),
      inside: /\binside (?:of )?(?:the )?$/i.test(plain.slice(0, m.index)),
    };
  });
}

/** Future places use the validated result; other replies describe the current program. */
function placeSizes(workspace, {stackLetters = null, newStacks = 0, plannedWorkspace = null} = {}) {
  if (plannedWorkspace) return stackSizes(plannedWorkspace, stackLetters);
  const sizes = stackSizes(workspace, stackLetters);
  if (newStacks) {
    // A count alone establishes only the first block; longer places need a dry-run workspace.
    for (const letter of newStackLetters(workspace, stackLetters, newStacks)) sizes.set(letter, 1);
  }
  return sizes;
}

/**
 * Places that can't exist, like "block 22 of stack A" when stack A has 4 blocks (often a view id read as a number).
 * @returns {!Array<string>} the impossible places as written
 */
export function impossiblePlaces(text, workspace, options = {}) {
  const sizes = placeSizes(workspace, options);
  return spokenPlaces(text).filter((p) => !sizes.has(p.stack) || p.n < 1 || p.n > sizes.get(p.stack)).map((p) => p.text);
}

/** True when a reply says a change was already made (nothing is applied before the learner approves). */
export function claimsApplied(text) {
  const plain = withoutQuotes(text);
  return [...plain.matchAll(APPLIED_CLAIM)].some((match) =>
    !/^I\b/i.test(match[0]) || !QUESTION_BEFORE_I.test(plain.slice(0, match.index)));
}

/** Ordinary words such as "cheer" are ids only when explicitly introduced as identifiers. */
function namesId(text, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (/^[a-z]+$/i.test(id)) {
    return new RegExp(`\\b(?:id|identifier)\\s*(?:(?:is|:|=)\\s*)?${escaped}\\b`, 'i').test(text);
  }
  return new RegExp(`(^|[^\\w])${escaped}([^\\w]|$)`).test(text);
}

/**
 * @param {string} text
 * @param {!Blockly.Workspace} workspace  Its block ids must not be spoken.
 * @param {{limit?: number, stackLetters?: ?Map<string, string>}=} options  stackLetters: as the app labels stacks
 */
export function speechChecks(text, workspace, {limit = SPOKEN_WORD_LIMIT, stackLetters = null} = {}) {
  const ids = workspace.getAllBlocks(false).map((b) => b.id).filter((id) => id.length > 2);
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const plain = withoutQuotes(text);
  return {
    hasText: words > 0,
    noRawIds: !VIEW_ID.test(plain) && !ids.some((id) => namesId(plain, id)),
    // A # mid-sentence is usually program content ("change X to #"); at a line start it's a heading.
    noMarkdown: !/[*_`]|^\s*#|^\s*[-•]\s/m.test(plain) && !PIPE_TABLE.test(plain),
    noEmoji: !EMOJI.test(plain),
    noVisualRefs: !COLOUR.test(plain) && !SCREEN.test(plain),
    realPlaces: !impossiblePlaces(text, workspace, {stackLetters}).length,
    words,
    withinWordLimit: words <= limit,
  };
}

/**
 * What a spoken reply breaks, worded for a repair round.
 * @param {{limit?: number, stackLetters?: ?Map<string, string>, newStacks?: number,
 *     plannedWorkspace?: ?Blockly.Workspace}=} options
 *     plannedWorkspace: the validated plan's result, to ground places in new stacks
 */
export function speechProblems(text, workspace, {limit = SPOKEN_WORD_LIMIT, stackLetters = null, newStacks = 0,
  plannedWorkspace = null} = {}) {
  const c = speechChecks(text, workspace, {limit, stackLetters});
  const problems = [];
  if (!c.hasText) return ['voiceLine must be text'];
  if (!c.withinWordLimit) problems.push(`voiceLine has ${c.words} words; use at most ${limit}`);
  if (!c.noRawIds) problems.push('voiceLine names a block id; name blocks by kind and place instead');
  if (!c.noMarkdown) problems.push('voiceLine has markdown or a list; use plain sentences');
  if (!c.noEmoji) problems.push('voiceLine has emoji; use plain words');
  if (!c.noVisualRefs) problems.push('voiceLine mentions a colour or screen position; use kind and place in the program');
  if (claimsApplied(text)) problems.push('voiceLine says a change was made; nothing is changed');
  problems.push(...placeProblems(text, workspace, {stackLetters, newStacks, plannedWorkspace}));
  return problems;
}

/** The place check alone, worded for a repair round. */
export function placeProblems(text, workspace, options = {}) {
  const sizes = placeSizes(workspace, options);
  const stacks = [...sizes].map(([letter, n]) => `stack ${letter} has ${n} block${n === 1 ? '' : 's'}`).join(', ');
  return impossiblePlaces(text, workspace, options).map((place) =>
    `voiceLine says "${place}", which doesn't exist (${stacks}). Ids are not block numbers; ` +
    'a block nested in numbered block N is "inside block N"');
}
