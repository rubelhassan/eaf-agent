// @ts-check
// Capture question results privately, without publishing Quiz feedback or reference data.
import * as Blockly from 'blockly/core';
import {Activity, setPolicy} from '../policy.js';
import {questionStatuses} from './check.js';
import {AiHintLevel} from './model.js';
import {aiHintsGiven, revealedHints} from './session.js';
import {isSolved} from './solved.js';
import {loadTaskXml, workXml} from './task.js';

/** @param {!Blockly.Workspace} workspace
 * @param {{execute: function(!Blockly.Workspace, !Array<string>): !Promise<!Object>}} host
 * @returns {!Promise<!Array<!Object>>} Submission-time results, with no question ids or text.
 */
export async function submissionQuestions(workspace, {execute}) {
  const statuses = questionStatuses(workspace);
  const rows = statuses.map((status, index) => ({number: index + 1, solved: /** @type {?boolean} */ (null),
    writtenHints: revealedHints(workspace, status.gap), aiHints: {count: aiHintsGiven(workspace, status.gap).length,
      levels: Object.values(AiHintLevel).filter(level => aiHintsGiven(workspace, status.gap, [level]).length > 0)}}));
  let copy = null;
  try {
    copy = new Blockly.Workspace();
    Blockly.Events.disable();
    try {
      loadTaskXml(copy, workXml(workspace));
      setPolicy(copy, {activity: Activity.PRACTICE, teacherMode: false});
    } finally { Blockly.Events.enable(); }
    for (const [index, status] of statuses.entries()) rows[index].solved = await isSolved(copy, status.gap, execute);
  } catch {
    // A failed private check must not prevent handing in the learner's work.
    for (const row of rows) row.solved = null;
  } finally { copy?.dispose(); }
  return rows;
}
