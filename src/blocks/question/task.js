/**
 * Task files: which blocks belong to the task (vs. the learner's own),
 * loading a task file, exporting a clean task, and saving a learner's work.
 * A task file carries the activity, whole-plan and voice-fallback settings (root attributes) and the task tests (<tests>).
 */

import * as Blockly from 'blockly/core';
import {withConnectionRulesSuspended} from '../connection_checker.js';
import {Activity, getPolicy, setPolicy} from '../policy.js';
import {getBinding} from './binding.js';
import {QUESTION_TYPE} from './model.js';
import {isQuestion, membersOf, setTaskBlockCheck} from './rules.js';
import {slotToReference} from './reference.js';
import {getTaskTests, setTaskTests, takeTestsFromDom, testsToDom} from './task_tests.js';

/** @type {!WeakMap<!Object, !Set<string>>} Ids of the blocks that belong to the task. */
const taskBlocks = new WeakMap();

/** Blocks that answer a question, and everything inside them, are the learner's. */
function isLearnerAnswer(block) {
  for (let b = block; b; b = b.getParent()) if (getBinding(b)) return true;
  return false;
}

/**
 * Records the workspace's current blocks as the task (call after loading a task,
 * and when leaving teacher mode). Answers and what is inside them are excluded.
 * @param {!Blockly.Workspace} workspace
 */
export function markTaskBlocks(workspace) {
  const ids = new Set();
  for (const block of workspace.getAllBlocks(false)) {
    if (!block.isInsertionMarker?.() && !isLearnerAnswer(block)) ids.add(block.id);
  }
  taskBlocks.set(workspace, ids);
}

/** @returns {boolean} True if the block belongs to the task (not added by the learner). */
export function isTaskBlock(block) {
  return !!block && !!taskBlocks.get(block.workspace)?.has(block.id);
}
setTaskBlockCheck(isTaskBlock);

/**
 * Replaces the workspace with a task file (or a learner's saved work), applies its
 * activity setting and tests, and records its task blocks (answers excluded).
 * Gap rules are suspended while loading.
 * @param {!Blockly.Workspace} workspace
 * @param {string} xmlText
 */
export function loadTaskXml(workspace, xmlText) {
  const dom = Blockly.utils.xml.textToDom(xmlText);
  const activity = dom.getAttribute('activity') === Activity.QUIZ ? Activity.QUIZ : Activity.PRACTICE;
  const wholePlan = dom.getAttribute('whole-plan') === 'true';
  const voiceFallback = dom.getAttribute('voice-fallback') === 'true';
  setTaskTests(workspace, takeTestsFromDom(dom));
  withConnectionRulesSuspended(() => {
    if (workspace.setResizesEnabled) {
      Blockly.Xml.clearWorkspaceAndLoadFromXml(dom, workspace);
    } else { // headless
      workspace.clear();
      Blockly.Xml.domToWorkspace(dom, workspace);
    }
  });
  setPolicy(workspace, {activity, wholePlan, voiceFallback});
  markTaskBlocks(workspace);
}

/**
 * The task as a learner should first see it: a copy of the workspace in which every
 * answered question is turned back into its empty question, and a teacher's answer
 * in a question's slot becomes its hidden reference. The live workspace is untouched.
 * @param {!Blockly.Workspace} workspace
 * @returns {string} Pretty-printed task XML.
 */
export function cleanTaskXml(workspace) {
  const state = Blockly.serialization.workspaces.save(workspace);
  const copy = new Blockly.Workspace(new Blockly.Options({}));
  Blockly.Events.disable();
  try {
    withConnectionRulesSuspended(() => {
      Blockly.serialization.workspaces.load(state, copy, {recordUndo: false});
      const gaps = new Set(copy.getAllBlocks(false).map((b) => getBinding(b)?.gap).filter(Boolean));
      for (const gap of gaps) restoreQuestion(copy, gap);
      for (const question of copy.getAllBlocks(false).filter(isQuestion)) slotToReference(question);
    });
    return Blockly.Xml.domToPrettyText(withTaskInfo(Blockly.Xml.workspaceToDom(copy), workspace));
  } finally {
    Blockly.Events.enable();
    copy.dispose();
  }
}

/**
 * A learner's work as it is, answers included ("Save my work"), for a teacher to
 * import and assess. Includes the activity setting and the task tests.
 * @param {!Blockly.Workspace} workspace
 * @returns {string} Pretty-printed XML.
 */
export function workXml(workspace) {
  return Blockly.Xml.domToPrettyText(withTaskInfo(Blockly.Xml.workspaceToDom(workspace), workspace));
}

/** Adds the activity, whole-plan and voice-fallback attributes and the <tests> element to an exported root. */
function withTaskInfo(dom, workspace) {
  if (getPolicy(workspace).activity === Activity.QUIZ) dom.setAttribute('activity', Activity.QUIZ);
  if (getPolicy(workspace).wholePlan) dom.setAttribute('whole-plan', 'true');
  if (getPolicy(workspace).voiceFallback) dom.setAttribute('voice-fallback', 'true');
  const tests = testsToDom(getTaskTests(workspace));
  if (tests) dom.appendChild(tests);
  return dom;
}

/** Replaces a gap's answer blocks in `workspace` with its empty question. */
function restoreQuestion(workspace, gap) {
  const members = membersOf(workspace, gap);
  if (!members.length) return;
  const {config} = getBinding(members[0]);
  const first = members[0];
  const last = members[members.length - 1];
  const value = !!first.outputConnection;
  const parent = (value ? first.outputConnection : first.previousConnection).targetConnection;
  const position = first.getRelativeToSurfaceXY();

  const below = value ? null : last.getNextBlock();
  below?.unplug(/* healStack= */ false);
  first.dispose(/* healStack= */ false);

  const question = workspace.newBlock(QUESTION_TYPE, workspace.getBlockById(gap) ? undefined : gap);
  question.setQuestionConfig(config);
  if (parent) {
    parent.connect(value ? question.outputConnection : question.previousConnection);
  } else {
    question.moveBy(position.x, position.y);
  }
  if (below) question.nextConnection.connect(below.previousConnection);
}
