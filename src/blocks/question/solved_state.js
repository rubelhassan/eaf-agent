// @ts-check
// Solved flags live only for this task view, never in block data or exported XML.
const states = new WeakMap();
const listeners = new WeakMap();

/** @param {!Object} workspace @param {string} gap @returns {boolean} */
export function isQuestionSolved(workspace, gap) {
  return states.get(workspace)?.has(gap) || false;
}

/** @param {!Object} workspace @param {!Set<string>} gaps */
export function setSolvedGaps(workspace, gaps) {
  const before = states.get(workspace) || new Set();
  if (before.size === gaps.size && [...gaps].every((id) => before.has(id))) return;
  states.set(workspace, new Set(gaps));
  for (const fn of listeners.get(workspace) || []) fn();
}

/** @param {!Object} workspace @param {function(): void} fn @returns {function(): void} */
export function onSolvedChange(workspace, fn) {
  if (!listeners.has(workspace)) listeners.set(workspace, new Set());
  listeners.get(workspace).add(fn);
  return () => listeners.get(workspace)?.delete(fn);
}
