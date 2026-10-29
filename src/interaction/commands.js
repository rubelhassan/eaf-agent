// @ts-check
// Control words, matched as whole replies so "yes but use 5" stays a request. Stop, no, cancel and never mind
// all mean one thing: end the open task.

const WORDS = {
  yes: ['yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'do it', 'go ahead', 'next', 'next step', 'yes please'],
  all: ['all', 'do all', 'all of it', 'do all of it', 'do everything', 'all steps', 'do all steps'],
  stop: ['stop', 'no', 'nope', 'no thanks', 'cancel', 'cancel that', 'never mind', 'nevermind'],
  undo: ['undo', 'undo that', 'take it back', 'take that back'],
  repeat: ['repeat', 'again', 'say that again', 'say it again', 'repeat that'],
  go: ['go there', 'take me there', 'jump there', 'go to it'],
  continue: ['continue', 'go on', 'carry on'],
};

const LOOKUP = new Map(Object.entries(WORDS).flatMap(([command, words]) => words.map((w) => [w, command])));

/** @returns {?string} yes | all | stop | undo | repeat | go | continue, or null when the reply is a request. */
export function matchCommand(text) {
  const words = String(text).toLowerCase().replace(/[^a-z\s']/g, ' ').replace(/\b(please|neon)\b/g, ' ')
      .replace(/\s+/g, ' ').trim();
  // "okay do it", "yes go ahead"
  return LOOKUP.get(words) || LOOKUP.get(words.replace(/^(ok|okay|yes) /, '')) || null;
}
