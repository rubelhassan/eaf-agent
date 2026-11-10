// @ts-check
// Compare block structure without keeping field values in the saved assistance history.

import * as Blockly from 'blockly/core';
import {blockPositions} from '../agent/context/snapshot.js';
import {authorshipOf, authorshipPlace, countsOf, historyOf, markCreated, markAssisted, deletedBlocks, appendDeletedBlocks} from './authorship.js';
import {blockTypeName} from './block_names.js';
import {isTaskBlock} from './question/task.js';

function inputName(parent, connection) {
  return parent?.inputList.find((input) => input.connection === connection)?.name || null;
}

function fieldsOf(block, prefix = '') {
  const fields = {};
  for (const input of block.inputList) {
    for (const field of input.fieldRow) {
      if (field.name) fields[`${prefix}${field.name}`] = {field: field.name, value: field.getValue()};
    }
    const child = input.connection?.targetBlock();
    if (child?.isShadow()) Object.assign(fields, fieldsOf(child, `${prefix}${input.name}/`));
  }
  return fields;
}

/** An in-memory comparison point; never sent to a model or stored with the work. @param {!Blockly.Workspace} workspace */
export function captureBlocks(workspace) {
  return new Map(workspace.getAllBlocks(false).filter((block) => !block.isShadow() && !block.isInsertionMarker?.()).map((block) => {
    const connection = block.outputConnection?.targetConnection || block.previousConnection?.targetConnection;
    const parent = connection?.getSourceBlock();
    const xy = block.getRelativeToSurfaceXY();
    return [block.id, {type: block.type, kind: authorshipOf(block), fields: fieldsOf(block),
      shape: Blockly.Events.BlockChange.getExtraBlockState_(block), list: authorshipPlace(block),
      parent: parent?.id || null, input: inputName(parent, connection),
      previous: parent && parent.nextConnection === connection ? parent.id : null, xy: {x: xy.x, y: xy.y}}];
  }));
}

function listKey(place, before) {
  return place.container || before.get(place.root)?.list.container || before.get(place.root)?.list.root || place.root;
}

function changedActions(before, after, allBefore) {
  const actions = [];
  for (const [key, field] of Object.entries(after.fields)) {
    if (before.fields[key] && JSON.stringify(before.fields[key].value) !== JSON.stringify(field.value)) {
      actions.push({action: 'field', field: field.field, fieldKey: key});
    }
  }
  if (before.shape !== after.shape) actions.push({action: 'shape'});
  const sameList = listKey(before.list, allBefore) === listKey(after.list, allBefore);
  const moved = before.parent !== after.parent || before.input !== after.input ||
    (!before.parent && !after.parent && JSON.stringify(before.xy) !== JSON.stringify(after.xy));
  if (moved) actions.push({action: sameList && before.previous !== after.previous ? 'reorder' : 'move'});
  return actions;
}

/** Read-only differences, staged until application succeeds. @param {!Map} before @param {!Map} after */
export function blockChanges(before, after) {
  const changes = [];
  for (const [id, current] of after) {
    const previous = before.get(id);
    const actions = previous ? changedActions(previous, current, before) : [{action: 'create'}];
    for (const action of actions) changes.push({id, ...action});
  }
  for (const [id, block] of before) if (!after.has(id)) changes.push({id, action: 'delete', blockType: block.type, priorKind: block.kind});
  return changes;
}

function guidedOwner(step, id) {
  let block = step.before.getBlockById(id) || step.expected.getBlockById(id);
  while (block?.isShadow() && block.getParent()) block = block.getParent();
  return block?.id;
}

function changeKey(change) {
  return JSON.stringify([change.id, change.action, change.fieldKey || change.field || null]);
}

/** Only actions described by the step, using its matched insert ids. @param {!Object} step
 * @param {!Blockly.Workspace} actual @param {{ops: !Array<!Object>, inserted: !Map<string,string>}} options
 */
export function guidedChanges(step, actual, {ops, inserted}) {
  const before = captureBlocks(step.before);
  const wanted = blockChanges(before, captureBlocks(step.expected)).filter((change) => {
    if (change.action === 'create' || change.action === 'delete') return true;
    return ops.some((op) => guidedOwner(step, op.block) === change.id && (
      (change.action === 'field' && op.op === 'setField' && op.field === change.field) ||
      (change.action === 'shape' && op.op === 'addBranch') ||
      (['move', 'reorder'].includes(change.action) && op.op === 'move')));
  });
  const allowed = new Set(wanted.flatMap((change) => {
    const id = change.action === 'create' ? inserted.get(change.id) : change.id;
    return id ? [changeKey({...change, id})] : [];
  }));
  return blockChanges(before, captureBlocks(actual)).filter((change) => allowed.has(changeKey(change)));
}

/** Commit staged entries in their originating group. @param {!Blockly.Workspace} workspace @param {!Array<!Object>} changes
 * @param {{type: string, task: string, group?: ?string}} entry
 */
export function recordChanges(workspace, changes, {type, task, group = null}) {
  const at = new Date().toISOString();
  const deleted = [];
  for (const {id, action, field, blockType, priorKind} of changes) {
    if (action === 'delete') {
      if (type !== 'guidance') deleted.push({blockType, priorKind, by: 'ai', type, action, task, at});
      continue;
    }
    const block = workspace.getBlockById(id);
    if (!block) continue;
    const entry = {type, task, action, at, ...(field ? {field} : {})};
    if (action === 'create' && type !== 'guidance') markCreated(block, entry);
    else markAssisted(block, entry, {group});
  }
  appendDeletedBlocks(workspace, deleted);
}

/** No field values, question prompts or hidden references. @param {!Blockly.Workspace} workspace
 * @param {{session?: !Object, stackLetters?: ?Map<string,string>}=} options
 */
export function authorshipSummary(workspace, {session = {}, stackLetters = null} = {}) {
  const positions = blockPositions(workspace, stackLetters);
  const counts = {blocks: {learner: 0, created: 0, assisted: 0}, aiActions: {}, learnerActionsOnAiBlocks: {},
    learnerChangedAiBlocks: 0, deleted: {learner: {}, created: {}, assisted: {}}, learnerDeleted: 0};
  const blocks = workspace.getAllBlocks(false).filter((block) => !block.isShadow() && !block.isInsertionMarker?.()).map((block) => {
    const kind = authorshipOf(block);
    counts.blocks[kind]++;
    const actions = countsOf(block);
    for (const [type, byAction] of Object.entries(actions.aiTypes)) {
      const typed = counts.aiActions[type] ||= {};
      for (const [action, count] of Object.entries(byAction)) typed[action] = (typed[action] || 0) + count;
    }
    for (const [action, count] of Object.entries(actions.ai)) {
      const known = Object.values(actions.aiTypes).reduce((total, typed) => total + (typed[action] || 0), 0);
      if (count > known) {
        const unknown = counts.aiActions.unknown ||= {};
        unknown[action] = (unknown[action] || 0) + count - known;
      }
    }
    const learnerActions = Object.values(actions.learner).reduce((total, count) => total + count, 0);
    if (kind !== 'learner' && learnerActions) counts.learnerChangedAiBlocks++;
    for (const [action, count] of Object.entries(actions.learner)) {
      counts.learnerActionsOnAiBlocks[action] = (counts.learnerActionsOnAiBlocks[action] || 0) + count;
    }
    const place = positions.get(block.id) || '';
    return {id: block.id, type: block.type, stack: /stack (\w+)/.exec(place)?.[1] || null,
      number: Number(/block (\d+)/.exec(place)?.[1]) || null, kind, added: !isTaskBlock(block), history: historyOf(block), counts: actions};
  });
  const deleted = deletedBlocks(workspace);
  for (const entry of deleted) {
    const byKind = counts.deleted[entry.priorKind];
    byKind[entry.blockType] = (byKind[entry.blockType] || 0) + 1;
    if (entry.priorKind === 'learner') counts.learnerDeleted++;
    const typed = counts.aiActions[entry.type] ||= {};
    typed.delete = (typed.delete || 0) + 1;
  }
  return {blocks, deleted, counts, session: {...session}};
}

/** Teacher assessment from the same summary stored with a save. @param {!Object} summary @param {string=} name */
export function authorshipLine(summary, name = 'Neon') {
  const {blocks, counts} = summary;
  const details = blocks.filter((block) => block.kind === 'assisted').map((block) => {
    const actions = Object.keys(block.counts.ai).filter((action) => action !== 'create');
    if (Object.values(block.counts.aiTypes.guidance || {}).some((count) => count > 0)) actions.push('guidance');
    return `stack ${block.stack} block ${block.number}: ${actions.join(', ')}`;
  });
  const deleted = counts.learnerDeleted;
  const types = Object.keys(counts.deleted.learner).map(blockTypeName);
  return `Blocks: ${counts.blocks.learner} by the learner, ${counts.blocks.created} made by ${name}, ` +
    `${counts.blocks.assisted} assisted by ${name}${details.length ? ` (${details.join('; ')})` : ''}. ` +
    `${name} deleted ${deleted} learner block${deleted === 1 ? '' : 's'}${deleted ? ` (${types.join(', ')})` : ''}. ` +
    `You changed ${counts.learnerChangedAiBlocks} of ${name}'s blocks.`;
}
