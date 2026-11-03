// @ts-check
// Whole replies only: No keeps a step waiting; Cancel, Stop and Never mind end the task.

const WORDS = {
  yes: ['yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'do it', 'go ahead', 'next', 'next step', 'yes please'],
  all: ['all', 'do all', 'all of it', 'do all of it', 'do everything', 'all steps', 'do all steps'],
  no: ['no', 'nope', 'nah', 'no thanks', 'not now', 'not yet'],
  cancel: ['cancel', 'cancel that', 'stop', 'never mind', 'nevermind', 'forget it'],
  undo: ['undo', 'undo that', 'take it back', 'take that back'],
  repeat: ['repeat', 'again', 'say that again', 'say it again', 'repeat that'],
  go: ['go there', 'take me there', 'jump there', 'go to it'],
  continue: ['continue', 'go on', 'carry on'],
  // Guided mode
  how: ['how', 'help', 'how do i do it', 'how do i do that', 'what do i do'],
  check: ['check', 'check it', 'check my work', 'is it right', 'did i do it', 'is it done', 'done'],
  keys: ['which keys', 'what keys', 'keys', 'which keys do i press'],
};

const LOOKUP = new Map(Object.entries(WORDS).flatMap(([command, words]) => words.map((w) => [w, command])));

/** @returns {?string} yes | no | cancel | all | undo | repeat | go | continue | how | check | keys, or null for a request. */
export function matchCommand(text) {
  const words = String(text).toLowerCase().replace(/[^a-z\s']/g, ' ').replace(/\b(please|neon)\b/g, ' ')
      .replace(/\s+/g, ' ').trim();
  // "okay do it", "yes go ahead"
  return LOOKUP.get(words) || LOOKUP.get(words.replace(/^(ok|okay|yes) /, '')) || null;
}
