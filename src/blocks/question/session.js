/**
 * Per-question session state: whether the question has been
 * answered at least once (which unlocks hints), how many written hints the
 * learner revealed, and the AI hints they were given.
 * Kept in memory per task instance and gap id, so it survives the question
 * being answered, removed, and restored. Not saved in task files.
 */

/** @typedef {{gap: string, remove: !Array<string>, names: !Array<string>, types: !Set<string>}} PendingChoice */
/** @typedef {{attempted: boolean, revealed: number, ai: !Array<{text: string, level: string}>}} QuestionSession */
/** @type {!WeakMap<!Object, {instance: number, questions: !Map<string, !QuestionSession>, pending: ?PendingChoice}>} */
const sessions = new WeakMap();

function taskFor(workspace) {
  if (!sessions.has(workspace)) sessions.set(workspace, {instance: 0, questions: new Map(), pending: null});
  return sessions.get(workspace);
}

/** @returns {number} The current task instance, unchanged by answering or undo. */
export function currentTaskInstance(workspace) {
  return taskFor(workspace).instance;
}

/** Starts a fresh attempt when a task file replaces the workspace. @returns {number} */
export function startTaskInstance(workspace) {
  const instance = currentTaskInstance(workspace) + 1;
  sessions.set(workspace, {instance, questions: new Map(), pending: null});
  return instance;
}

function stateFor(workspace, gap) {
  const states = taskFor(workspace).questions;
  if (!states.has(gap)) states.set(gap, {attempted: false, revealed: 0, ai: []});
  return states.get(gap);
}

/** Records that the question was answered at least once. */
export function markAttempted(workspace, gap) {
  stateFor(workspace, gap).attempted = true;
}

/** @returns {boolean} */
export function isAttempted(workspace, gap) {
  return stateFor(workspace, gap).attempted;
}

/** @returns {number} How many hints have been revealed so far. */
export function revealedHints(workspace, gap) {
  return stateFor(workspace, gap).revealed;
}

/**
 * Reveals the next hint if hints are unlocked and any remain.
 * @param {!Object} workspace
 * @param {string} gap
 * @param {number} total  Number of written hints.
 * @returns {number} The number revealed after the call.
 */
export function revealNextHint(workspace, gap, total) {
  const state = stateFor(workspace, gap);
  if (state.attempted && state.revealed < total) state.revealed++;
  return state.revealed;
}

/** @returns {!Array<string>} Given AI hints, optionally limited to the allowed levels and count. */
export function aiHintsGiven(workspace, gap, levels = null) {
  const given = stateFor(workspace, gap).ai;
  const allowed = levels === null ? given : given.filter((hint) => levels.includes(hint.level)).slice(0, levels.length);
  return allowed.map((hint) => hint.text);
}

/** Records an AI hint with its disclosure level. @param {{text: string, level: string}} hint */
export function addAiHint(workspace, gap, hint) {
  stateFor(workspace, gap).ai.push({...hint});
}

/**
 * Remembers that the learner opened choices on an answer that doesn't fit: when a
 * block of one of `types` lands in the gap, the wrong blocks `remove` go.
 */
export function setPendingChoice(workspace, pending) {
  taskFor(workspace).pending = pending;
}

/**
 * The pending choice for `gap`, if a newly placed block of `type` answers it. Consumed.
 * @returns {?{gap: string, remove: !Array<string>, names: !Array<string>, types: !Set<string>}}
 */
export function takePendingChoice(workspace, gap, type) {
  const task = taskFor(workspace);
  const pending = task.pending;
  if (!pending || pending.gap !== gap || !pending.types.has(type)) return null;
  task.pending = null;
  return pending;
}
