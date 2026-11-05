/**
 * Per-workspace activity policy consulted by custom block rules.
 *
 * - activity: 'practice' | 'quiz'  Set by the task teacher. Quiz tightens rules.
 * - teacherMode: boolean            Teachers may edit and move custom blocks; learners may not.
 * - learnerLevel: 'beginner' | 'intermediate' | 'advanced'  Controls feedback detail.
 * - wholePlan: boolean              The assistant may apply a whole edit plan after one yes. Set by the teacher.
 * - editMode: 'stepConfirm' | 'guided'  Guided: the learner does each step of a plan while the assistant guides.
 *                                   Set by the teacher.
 * - voiceFallback: boolean          The browser's speech recognition may stand in when the voice engine can't load
 *                                   (it may send audio to the browser's company). Set by the teacher.
 */

export const Activity = Object.freeze({PRACTICE: 'practice', QUIZ: 'quiz'});
export const EditMode = Object.freeze({STEP_CONFIRM: 'stepConfirm', GUIDED: 'guided'});
export const LearnerLevel = Object.freeze({
  BEGINNER: 'beginner',
  INTERMEDIATE: 'intermediate',
  ADVANCED: 'advanced',
});

const DEFAULT_POLICY = Object.freeze({
  activity: Activity.PRACTICE,
  teacherMode: false,
  learnerLevel: LearnerLevel.BEGINNER,
  wholePlan: false,
  editMode: EditMode.GUIDED,
  voiceFallback: false,
});

/** @type {!WeakMap<!Object, !Object>} */
const policies = new WeakMap();

/** @type {!WeakMap<!Object, !Set<function(!Object, !Object)>>} */
const listeners = new WeakMap();

/**
 * Calls `fn(next, previous)` whenever the workspace's policy changes.
 * @returns {function()} Unsubscribe.
 */
export function onPolicyChange(workspace, fn) {
  const ws = rootWorkspace(workspace);
  if (!listeners.has(ws)) listeners.set(ws, new Set());
  listeners.get(ws).add(fn);
  return () => listeners.get(ws)?.delete(fn);
}

/**
 * Policy lives on the main workspace; flyouts and mutator workspaces resolve to it.
 * @param {?Object} workspace
 * @returns {?Object}
 */
function rootWorkspace(workspace) {
  return workspace?.targetWorkspace || workspace || null;
}

/**
 * @param {?Object} workspace  A Blockly workspace (headless or rendered).
 * @returns {{activity: string, teacherMode: boolean, learnerLevel: string, wholePlan: boolean, editMode: string,
 *     voiceFallback: boolean}}
 */
export function getPolicy(workspace) {
  const ws = rootWorkspace(workspace);
  return {...DEFAULT_POLICY, ...(ws && policies.get(ws))};
}

/**
 * Merges the given fields into the workspace's policy. Unknown values are ignored.
 * @param {!Object} workspace
 * @param {{activity?: string, teacherMode?: boolean, learnerLevel?: string, wholePlan?: boolean, editMode?: string,
 *     voiceFallback?: boolean}} changes
 */
export function setPolicy(workspace, changes) {
  const ws = rootWorkspace(workspace);
  if (!ws) return;
  const next = {...getPolicy(ws)};
  if (Object.values(Activity).includes(changes?.activity)) next.activity = changes.activity;
  if (typeof changes?.teacherMode === 'boolean') next.teacherMode = changes.teacherMode;
  if (typeof changes?.wholePlan === 'boolean') next.wholePlan = changes.wholePlan;
  if (Object.values(EditMode).includes(changes?.editMode)) next.editMode = changes.editMode;
  if (typeof changes?.voiceFallback === 'boolean') next.voiceFallback = changes.voiceFallback;
  if (Object.values(LearnerLevel).includes(changes?.learnerLevel)) next.learnerLevel = changes.learnerLevel;
  const previous = getPolicy(ws);
  policies.set(ws, next);
  const changed = Object.keys(next).some((key) => next[key] !== previous[key]);
  if (changed) for (const fn of listeners.get(ws) || []) fn(next, previous);
}
