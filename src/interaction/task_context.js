// @ts-check
// The task context: a few lines built by code from the coordinator's task, never by a model, so the same state
// always gives the same request.

const ACTIONS = {COMPREHEND: 'comprehend', DEBUG: 'debug', EDIT_GUIDE: 'edit', SEARCH: 'search', HINT: 'hint'};
const STATES = {working: 'working', applying: 'working', awaiting: 'waiting for an answer', done: 'done',
  cancelled: 'stopped', failed: 'failed'};
const LAST_SAID_WORDS = 60;

const quote = (text) => JSON.stringify(String(text));
const cut = (text, words) => {
  const all = String(text).trim().split(/\s+/);
  return all.length > words ? `${all.slice(0, words).join(' ')}...` : all.join(' ');
};

/**
 * @typedef {Object} TaskForContext
 * @property {?string} action  COMPREHEND | DEBUG | EDIT_GUIDE | SEARCH | HINT, or null while only a question was asked
 * @property {number} revision
 * @property {string} state  working | applying | awaiting | done | cancelled | failed
 * @property {{words: string, clarifications: !Array<{asked: string, answer: string}>, corrections: !Array<string>}} request
 * @property {?{kind: string, steps: !Array, next: number, presented: boolean, words: !Array<string>}} proposal
 *     words: the steps in words (ops_in_words.js); presented: false while a debug fix is only explained
 * @property {!Array<string>} applied  Steps applied in this task, in words, newest last; undone steps are left out.
 * @property {string} lastSay
 */

/**
 * @param {?TaskForContext} task
 * @returns {string} Empty when there is no task.
 */
export function taskContext(task) {
  if (!task) return '';
  const lines = [`Task: ${ACTIONS[task.action] || 'not decided yet'}, revision ${task.revision}, ${STATES[task.state] || task.state}`];
  lines.push(`Learner asked: ${quote(task.request.words)}`);
  for (const c of task.request.clarifications.slice(-3)) lines.push(`You asked: ${quote(c.asked)} Learner answered: ${quote(c.answer)}`);
  for (const c of task.request.corrections.slice(-3)) lines.push(`Correction: ${quote(c)}`);
  const p = task.proposal;
  if (p && task.state === 'awaiting') {
    if (p.kind === 'fix' && !p.presented) lines.push(`Offered: the fix: ${p.words[0] || 'a change'}`);
    else lines.push(`Offered: step ${p.next + 1} of ${p.steps.length}, ${p.words[p.next] || 'a change'}`);
  }
  if (task.action === 'DEBUG' || task.action === 'EDIT_GUIDE') {
    lines.push(`Applied: ${task.applied.length ? task.applied.join('; ') : 'none'}`);
  }
  if (task.lastSay) lines.push(`You last said: ${quote(cut(task.lastSay, LAST_SAID_WORDS))}`);
  return lines.join('\n');
}

/**
 * The answers the learner can give now, with what each does, for the intent step to map loose or misheard replies
 * onto. Repeat is left out: it is nearly always available, and the code match knows its usual words.
 * @param {!Array<string>} names  available commands
 * @param {{proposal?: ?Object, lastApplied?: ?Array<string>, working?: boolean}=} state
 *     proposal: the offered one (TaskForContext.proposal); lastApplied: the last applied step's words
 * @returns {!Array<{name: string, does: string}>}
 */
export function answersNow(names, {proposal: p = null, lastApplied = null, working = false} = {}) {
  const step = p && (p.kind === 'fix' && !p.presented ? 'hear the fix' :
    p.steps.length === 1 ? `make the change: ${p.words[0]}` : `do step ${p.next + 1} of ${p.steps.length}: ${p.words[p.next]}`);
  const does = {
    yes: step,
    all: 'do all the remaining steps',
    stop: p ? "don't make the offered change" : working ? 'stop the work' : 'drop the question',
    undo: lastApplied && `take back the last change: ${lastApplied.join('; ')}`,
    continue: 'hear the offered step again',
    go: 'move to the block just found',
  };
  return names.filter((name) => does[name]).map((name) => ({name, does: does[name]}));
}
