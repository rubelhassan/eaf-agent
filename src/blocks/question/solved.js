// @ts-check
// Private copies and host-supplied runs judge one answer without exposing the reference.
import * as Blockly from 'blockly/core';
import {getPolicy, Activity, setPolicy} from '../policy.js';
import {AGENT_GROUP} from '../authorship.js';
import {withConnectionRulesSuspended} from '../connection_checker.js';
import {questionStatuses} from './check.js';
import {restoreQuestion} from './task.js';
import {getBinding} from './binding.js';
import {isQuestion} from './rules.js';
import {ANSWER_INPUT} from './model.js';
import {referenceToSlot} from './reference.js';
import {getTaskTests, runTests} from './task_tests.js';
import {isQuestionSolved, setSolvedGaps} from './solved_state.js';

const coverageCache = new WeakMap();
const BUSY_DELAY_MS = 250;
const DEFAULT_DELAY_MS = 600;
const practice = (ws) => { const p = getPolicy(ws); return !p.teacherMode && p.activity === Activity.PRACTICE; };

function referenceFor(status) {
  if (status.config.reference) return status.config.reference;
  const slot = isQuestion(status.block) && status.block.getInputTargetBlock(ANSWER_INPUT);
  return slot ? Blockly.serialization.blocks.save(slot, {addCoordinates: false}) : null;
}

function taskKey(workspace) {
  return JSON.stringify([getTaskTests(workspace), questionStatuses(workspace).map((s) => [s.gap, s.config, referenceFor(s)])]);
}

/** The caller owns the copy and must dispose it. Null means a needed reference is absent.
 * @param {!Blockly.Workspace} workspace @param {?string} gap  Keep only this learner answer; null fills every reference.
 * @returns {?Blockly.Workspace}
 */
export function checkProgram(workspace, gap) {
  const statuses = questionStatuses(workspace);
  if (statuses.some((s) => s.gap !== gap && !referenceFor(s))) return null;
  const state = Blockly.serialization.workspaces.save(workspace);
  const copy = new Blockly.Workspace();
  Blockly.Events.disable();
  try {
    withConnectionRulesSuspended(() => {
      Blockly.serialization.workspaces.load(state, copy, {recordUndo: false});
      setPolicy(copy, {teacherMode: true});
      const bound = new Set(copy.getAllBlocks(false).map((b) => getBinding(b)?.gap).filter(Boolean));
      for (const id of bound) if (id !== gap) restoreQuestion(copy, id);
      for (const question of copy.getAllBlocks(false).filter(isQuestion)) {
        if (question.id === gap) continue;
        if (question.getQuestionConfig().reference) question.getInputTargetBlock(ANSWER_INPUT)?.dispose(false);
        referenceToSlot(question);
      }
    });
    return copy;
  } catch (error) { copy.dispose(); throw error; }
  finally { Blockly.Events.enable(); }
}

async function passes(workspace, tests, execute) {
  const results = await runTests(tests, (inputs) => execute(workspace, inputs));
  return results.length > 0 && results.every((result) => result.ok);
}

async function coverage(workspace, execute) {
  const key = taskKey(workspace);
  const saved = coverageCache.get(workspace);
  if (saved?.key === key) return saved.result;
  const result = (async () => {
    const covered = new Set();
    const uncovered = new Set();
    const tests = getTaskTests(workspace);
    if (!tests.length) return {covered, uncovered};
    for (const status of questionStatuses(workspace)) {
      const copy = checkProgram(workspace, null);
      if (!copy) continue;
      try {
        Blockly.Events.disable();
        try { copy.getBlockById(status.gap)?.getInputTargetBlock(ANSWER_INPUT)?.dispose(false); }
        finally { Blockly.Events.enable(); }
        if (!await passes(copy, tests, execute)) covered.add(status.gap);
        else uncovered.add(status.gap);
      } finally { copy.dispose(); }
    }
    return {covered, uncovered};
  })();
  coverageCache.set(workspace, {key, result});
  try { return await result; }
  catch (error) { if (coverageCache.get(workspace)?.result === result) coverageCache.delete(workspace); throw error; }
}

/** @param {!Blockly.Workspace} workspace @param {function(!Blockly.Workspace, !Array<string>): !Promise<!Object>} execute
 * @returns {!Promise<!Array<number>>} Question numbers whose empty answer still passes every test.
 */
export async function uncoveredQuestions(workspace, execute) {
  if (!getTaskTests(workspace).length) return [];
  const {uncovered} = await coverage(workspace, execute);
  return questionStatuses(workspace).flatMap((s, i) => uncovered.has(s.gap) ? [i + 1] : []);
}

/** @param {!Blockly.Workspace} workspace @param {string} gap
 * @param {function(!Blockly.Workspace, !Array<string>): (!Object|!Promise<!Object>)} execute
 * @returns {!Promise<boolean>}
 */
export async function isSolved(workspace, gap, execute) {
  const status = questionStatuses(workspace).find((s) => s.gap === gap);
  if (!practice(workspace) || !status?.members.length || !referenceFor(status) || !getTaskTests(workspace).length) return false;
  if (!(await coverage(workspace, execute)).covered.has(gap)) return false;
  const copy = checkProgram(workspace, gap);
  if (!copy) return false;
  try { return await passes(copy, getTaskTests(workspace), execute); }
  finally { copy.dispose(); }
}

function answerSignature(status) {
  const strip = (value) => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(strip);
    return Object.fromEntries(Object.entries(value).filter(([key]) =>
      !(value.type && ['id', 'x', 'y', 'data'].includes(key))).map(([key, child]) => [key, strip(child)]));
  };
  return JSON.stringify(status.members.map((block) => {
    const state = Blockly.serialization.blocks.save(block, {addCoordinates: false});
    delete state.next;
    return strip(state);
  }));
}

/** @param {!Blockly.Workspace} workspace
 * @param {{execute: function(!Blockly.Workspace, !Array<string>): (!Object|!Promise<!Object>),
 * onSolved?: function(!Array<!Object>): void, onChange?: function(!Set<string>): void,
 * isBusy?: function(): boolean, delayMs?: number}} options
 */
export function createSolvedWatcher(workspace, {execute, onSolved = () => {}, onChange = () => {},
  isBusy = () => false, delayMs = DEFAULT_DELAY_MS}) {
  let timer; let generation = 0; let disposed = false; let running = false; let silent = true;
  let signatures = new Map(); let previousTask = ''; let published = new Set();
  const publish = (next) => {
    setSolvedGaps(workspace, next);
    const changed = published.size !== next.size || [...published].some((id) => !next.has(id));
    published = new Set(next);
    if (changed) onChange(new Set(next));
  };
  const schedule = (delay = delayMs) => { clearTimeout(timer); if (!disposed) timer = setTimeout(check, delay); };
  async function check() {
    if (disposed) return;
    if (running || isBusy() || workspace.isDragging?.() || String(Blockly.Events.getGroup()).startsWith(AGENT_GROUP)) {
      schedule(BUSY_DELAY_MS); return;
    }
    if (!practice(workspace)) { publish(new Set()); return; }
    running = true;
    const revision = generation;
    const baseline = silent;
    try {
      const key = taskKey(workspace);
      const statuses = questionStatuses(workspace);
      if (key !== previousTask && statuses.length) await coverage(workspace, execute);
      if (disposed || generation !== revision) return;
      const next = new Set(); const nextSignatures = new Map(); const solved = [];
      for (const [index, status] of statuses.entries()) {
        const signature = answerSignature(status);
        nextSignatures.set(status.gap, signature);
        const wasSolved = isQuestionSolved(workspace, status.gap);
        const changed = key !== previousTask || signatures.get(status.gap) !== signature;
        const ok = changed ? await isSolved(workspace, status.gap, execute) : wasSolved;
        if (disposed || generation !== revision) return;
        if (ok) next.add(status.gap);
        if (ok && !wasSolved) solved.push({gap: status.gap, number: index + 1, block: status.block});
      }
      signatures = nextSignatures; previousTask = key; silent = false;
      publish(next);
      if (!baseline && solved.length) onSolved(solved);
    } catch (error) { if (!disposed && generation === revision) publish(new Set()); }
    finally { running = false; }
  }
  const changed = (event) => { if (!event.isUiEvent) { generation++; schedule(); } };
  workspace.addChangeListener(changed);
  const reset = () => {
    generation++; silent = true; signatures = new Map(); previousTask = '';
    coverageCache.delete(workspace); publish(new Set()); schedule();
  };
  reset();
  return {reset, dispose() {
    disposed = true; generation++; clearTimeout(timer);
    workspace.removeChangeListener(changed); publish(new Set());
  }};
}
