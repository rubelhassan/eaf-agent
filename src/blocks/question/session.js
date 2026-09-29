/**
 * Per-question session state: whether the question has been
 * answered at least once (which unlocks hints), how many written hints the
 * learner revealed, and the AI hints they were given.
 * Kept in memory per workspace, keyed by gap id, so it survives the question
 * being answered, removed, and restored. Not saved in task files.
 */

/** @type {!WeakMap<!Object, !Map<string, {attempted: boolean, revealed: number, ai: !Array<string>}>>} */
const sessions = new WeakMap();

function stateFor(workspace, gap) {
  if (!sessions.has(workspace)) sessions.set(workspace, new Map());
  const states = sessions.get(workspace);
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

/** @returns {!Array<string>} AI hints given so far, in order (a copy). */
export function aiHintsGiven(workspace, gap) {
  return [...stateFor(workspace, gap).ai];
}

/** Records an AI hint the learner was given. */
export function addAiHint(workspace, gap, text) {
  stateFor(workspace, gap).ai.push(text);
}

/** @type {!WeakMap<!Object, {gap: string, remove: !Array<string>, names: !Array<string>, types: !Set<string>}>} */
const pendingChoices = new WeakMap();

/**
 * Remembers that the learner opened choices on an answer that doesn't fit: when a
 * block of one of `types` lands in the gap, the wrong blocks `remove` go.
 */
export function setPendingChoice(workspace, pending) {
  pendingChoices.set(workspace, pending);
}

/**
 * The pending choice for `gap`, if a newly placed block of `type` answers it. Consumed.
 * @returns {?{gap: string, remove: !Array<string>, names: !Array<string>, types: !Set<string>}}
 */
export function takePendingChoice(workspace, gap, type) {
  const pending = pendingChoices.get(workspace);
  if (!pending || pending.gap !== gap || !pending.types.has(type)) return null;
  pendingChoices.delete(workspace);
  return pending;
}
