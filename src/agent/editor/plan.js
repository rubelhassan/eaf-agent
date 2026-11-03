// @ts-check
// Plans are steps of ops ([{title, ops}]). Dry-run on a copy first; applying is all or nothing.

import * as Blockly from 'blockly/core';
import {applyOp, OpError} from './ops.js';
import {getPolicy, setPolicy} from '../../blocks/policy.js';
import {withConnectionRulesSuspended} from '../../blocks/connection_checker.js';

/**
 * @typedef {{title?: string, ops: !Array<!Object>}} PlanStep
 * @typedef {{step: number, op: number, message: string}} PlanError
 */

/** A headless copy of a workspace with the same blocks, ids, variables, rules and policy. */
export function cloneWorkspace(ws) {
  const options = new Blockly.Options(/** @type {*} */ ({plugins: {connectionChecker: ws.connectionChecker.constructor}}));
  const copy = new Blockly.Workspace(options);
  setPolicy(copy, getPolicy(ws));
  withConnectionRulesSuspended(() => Blockly.serialization.workspaces.load(Blockly.serialization.workspaces.save(ws), copy));
  return copy;
}

/** @returns {?string} What's wrong with a step's shape, or null. */
function shapeProblem(step) {
  if (!step || typeof step !== 'object' || !Array.isArray(step.ops)) return 'each step needs an ops list';
  if (!step.ops.length) return 'a step needs at least one op';
  return null;
}

function runSteps(ws, steps, options) {
  /** @type {!Array<PlanError>} */
  const errors = [];
  const ctx = {...options, removed: new Map()};
  let focus = null;
  steps.forEach((step, i) => {
    if (errors.length) return;
    ctx.step = i;
    const problem = shapeProblem(step);
    if (problem) return errors.push({step: i, op: -1, message: problem});
    options.onStep?.({index: i + (options.from || 0), step, phase: 'before'});
    step.ops.forEach((op, j) => {
      if (errors.length) return;
      try {
        focus = applyOp(ws, op, ctx) ?? focus;
      } catch (e) {
        if (!(e instanceof OpError)) console.warn('plan op failed unexpectedly', e);
        errors.push({step: i, op: j, message: e.message});
      }
    });
    if (!errors.length) options.onStep?.({index: i + (options.from || 0), step, phase: 'after'});
  });
  return {errors, focus};
}

/**
 * Dry-runs steps on a copy of the workspace. Later steps see earlier steps' changes.
 * @param {!Blockly.Workspace} ws
 * @param {!Array<PlanStep>} steps
 * @param {import('./ops.js').OpContext=} ctx
 * @returns {{ok: boolean, errors: !Array<PlanError>, result: ?Blockly.Workspace}}  result: the copy after the steps (dispose it).
 */
export function validatePlan(ws, steps, ctx = {}) {
  if (!Array.isArray(steps) || !steps.length) return {ok: false, errors: [{step: -1, op: -1, message: 'the plan has no steps'}], result: null};
  const copy = cloneWorkspace(ws);
  let errors;
  Blockly.Events.disable();
  try {
    ({errors} = runSteps(copy, steps, ctx));
  } finally {
    Blockly.Events.enable();
  }
  if (errors.length) {
    copy.dispose();
    return {ok: false, errors, result: null};
  }
  return {ok: true, errors, result: copy};
}

/**
 * Applies steps [from, from + count) to the learner's program as one undo group,
 * after dry-running every remaining step from `from` on the current program (it
 * may have changed since the plan was made). Nothing is changed if that fails.
 * @param {!Blockly.Workspace} ws
 * @param {!Array<PlanStep>} steps
 * @param {{from?: number, count?: number, allowedTypes?: ?Array<string>, newStack?: import('./ops.js').OpContext['newStack'],
 *     onStep?: function({index: number, step: !PlanStep, phase: string}): void}=} options
 *     onStep: reads the live workspace around each chosen step; never runs during validation and must not change blocks.
 * @returns {{ok: boolean, applied: number, errors: !Array<PlanError>, focus?: ?string}}
 *     focus: the block the cursor goes to (the last one the applied steps added or changed)
 */
export function applyPlan(ws, steps, {from = 0, count = Infinity, allowedTypes = null, newStack = null, onStep} = {}) {
  const remaining = Array.isArray(steps) ? steps.slice(from) : [];
  const check = validatePlan(ws, remaining, {allowedTypes, newStack});
  check.result?.dispose();
  if (!check.ok) return {ok: false, applied: 0, errors: check.errors.map((e) => ({...e, step: e.step < 0 ? e.step : e.step + from}))};

  const chosen = remaining.slice(0, count);
  const saved = Blockly.serialization.workspaces.save(ws);
  const group = Blockly.Events.getGroup();
  if (!group) Blockly.Events.setGroup(true);
  let errors;
  let focus;
  try {
    ({errors, focus} = runSteps(ws, chosen, {allowedTypes, newStack, from, onStep}));
  } finally {
    if (!group) Blockly.Events.setGroup(false);
  }
  if (errors.length) {
    // Shouldn't happen after a clean dry run; put the program back as it was.
    Blockly.Events.disable();
    try {
      ws.clear();
      withConnectionRulesSuspended(() => Blockly.serialization.workspaces.load(saved, ws));
    } finally {
      Blockly.Events.enable();
    }
    return {ok: false, applied: 0, errors: errors.map((e) => ({...e, step: e.step + from}))};
  }
  return {ok: true, applied: chosen.length, errors: [], focus: focus && ws.getBlockById(focus) ? focus : null};
}
