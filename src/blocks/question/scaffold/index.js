/**
 * Structured scaffold for teachers: turn the program on the workspace into a
 * partial program with questions at the parts that carry the lesson's concept.
 */

import * as Blockly from 'blockly/core';
import {getPolicy} from '../../policy.js';
import {GENERATED_GROUP_PREFIX} from '../model.js';
import {wrapGaps} from './apply.js';
import {chooseGaps} from './request.js';
import {findSpots, gapPlan, programLength} from './spots.js';

export {CONCEPTS} from './spots.js';

/**
 * The spots a level may use in this program, and how many questions it gets.
 * @returns {{min: number, max: number, kinds: !Array<string>, spots: !Array<!Object>}}
 */
export function previewScaffold(workspace, level) {
  const length = programLength(workspace);
  const all = findSpots(workspace);
  const {kinds} = gapPlan(level, length, all.length);
  const spots = all.filter((s) => kinds.includes(s.kind));
  return {...gapPlan(level, length, spots.length), spots};
}

/**
 * Chooses gaps (agent first, rules as fallback) and wraps them in questions as
 * one undoable step. Teacher mode only.
 * @param {!Blockly.WorkspaceSvg} workspace
 * @param {{concept: string, level: string, agent: ?Object}} options  concept is 'auto' or one of CONCEPTS.
 * @returns {!Promise<{questions: !Array<!Blockly.Block>, concept: string, source: string}>}
 */
export async function makeScaffold(workspace, {concept, level, agent}) {
  if (!getPolicy(workspace).teacherMode) throw new Error('Scaffolds are made in teacher mode.');
  const preview = previewScaffold(workspace, level);
  const {spots} = preview;
  if (!preview.max) return {questions: [], concept, source: 'rules'};

  const plan = {concept, level, gapCount: {min: preview.min, max: preview.max}};
  const {gaps, concept: chosenConcept, source} = await chooseGaps(workspace, spots, plan, agent);
  // The program may have changed while the agent was thinking.
  if (gaps.some((g) => g.spot.blocks.some((b) => b.isDisposed?.() || b.workspace !== workspace))) {
    throw new Error('The program changed while the scaffold was being made. Try again.');
  }
  Blockly.Events.setGroup(GENERATED_GROUP_PREFIX + Blockly.utils.idGenerator.genUid());
  try {
    return {questions: wrapGaps(gaps), concept: chosenConcept, source};
  } finally {
    Blockly.Events.setGroup(false);
  }
}
