// @ts-check
// Block histories follow the undo group of the change that caused them.
// No record means the learner made the block; a pasted copy drops the record, so it is the learner's.

import * as Blockly from 'blockly/core';

export const AGENT_GROUP = 'agent-';
export const AUTHORSHIP_EVENT = 'eaf_authorship';
const DELETED_EVENT = 'eaf_ai_deleted';
export const Creator = Object.freeze({LEARNER: 'learner', ASSISTANT: 'assistant'});
const DATA_KEY = 'eafMadeBy';
const HISTORY_LIMIT = 20;
const FIELD_MERGE_MS = 2000;
const ACTIONS = ['create', 'field', 'shape', 'move', 'reorder'];
const TYPES = ['edit', 'debug', 'guidance'];
const deletedByWorkspace = new WeakMap();

/** @param {!Blockly.Workspace} workspace @returns {!Array<!Object>} */
export function deletedBlocks(workspace) {
  return structuredClone(deletedByWorkspace.get(workspace) || []);
}

/** Restore saved metadata without creating an editing action. @param {!Blockly.Workspace} workspace @param {!Array} entries */
export function setDeletedBlocks(workspace, entries) {
  deletedByWorkspace.set(workspace, structuredClone(entries.filter((entry) => entry &&
    ['learner', 'created', 'assisted'].includes(entry.priorKind) && entry.by === 'ai' && entry.action === 'delete' &&
    TYPES.includes(entry.type) && typeof entry.blockType === 'string' && typeof entry.task === 'string' &&
    typeof entry.at === 'string' && Number.isFinite(Date.parse(entry.at)))));
}

/** @param {!Blockly.Workspace} workspace @param {!Array<!Object>} entries */
export function appendDeletedBlocks(workspace, entries) {
  if (!entries.length) return;
  const before = deletedBlocks(workspace);
  const after = [...before, ...entries];
  setDeletedBlocks(workspace, after);
  if (Blockly.Events.isEnabled()) Blockly.Events.fire(new DeletedBlocksChange(workspace, before, after));
}

class DeletedBlocksChange extends Blockly.Events.Abstract {
  constructor(workspace, before = [], after = []) {
    super();
    this.type = DELETED_EVENT;
    this.workspaceId = workspace?.id;
    this.before = before;
    this.after = after;
  }
  toJson() { return {...super.toJson(), before: this.before, after: this.after}; }
  static fromJson(json, workspace, event) {
    const change = super.fromJson(json, workspace, event || new DeletedBlocksChange(workspace));
    change.before = json.before || [];
    change.after = json.after || [];
    return change;
  }
  isNull() { return JSON.stringify(this.before) === JSON.stringify(this.after); }
  run(forward) { setDeletedBlocks(this.getEventWorkspace_(), forward ? this.after : this.before); }
}
Blockly.registry.register(Blockly.registry.Type.EVENT, DELETED_EVENT, DeletedBlocksChange, true);

function readData(data) {
  try {
    const parsed = JSON.parse(data || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function owner(block) {
  let current = block;
  while (current?.isShadow() && current.getParent()) current = current.getParent();
  return current;
}

function actionCounts(value) {
  return Object.fromEntries(ACTIONS.filter((action) => Number.isSafeInteger(value?.[action]) && value[action] > 0)
      .map((action) => [action, value[action]]));
}

function addCount(counts, entry) {
  const side = counts[entry.by];
  side[entry.action] = (side[entry.action] || 0) + 1;
  if (entry.by === 'ai' && TYPES.includes(entry.type)) {
    const typed = counts.aiTypes[entry.type] ||= {};
    typed[entry.action] = (typed[entry.action] || 0) + 1;
  }
}

function readEntry(entry) {
  if (!entry || !['ai', 'learner'].includes(entry.by) || !ACTIONS.includes(entry.action)) return null;
  return {by: entry.by, action: entry.action,
    ...(TYPES.includes(entry.type) ? {type: entry.type} : {}),
    ...(typeof entry.field === 'string' ? {field: entry.field} : {}),
    ...(typeof entry.task === 'string' ? {task: entry.task} : {}),
    ...(typeof entry.at === 'string' && Number.isFinite(Date.parse(entry.at)) ? {at: entry.at} : {})};
}

function recordOf(block) {
  const target = owner(block);
  const raw = target && readData(target.data)[DATA_KEY];
  if (!raw || typeof raw !== 'object') return null;
  if (raw.by === Creator.ASSISTANT) {
    const history = [{by: 'ai', action: 'create'}];
    if (raw.edited === true) history.push({by: 'learner', action: 'field'});
    const counts = {ai: {}, learner: {}, aiTypes: {}};
    history.forEach((entry) => addCount(counts, entry));
    return {kind: 'created', history, counts};
  }
  if (!['created', 'assisted'].includes(raw.kind) || !Array.isArray(raw.history)) return null;
  const history = raw.history.map(readEntry).filter(Boolean);
  const counts = {ai: actionCounts(raw.counts?.ai), learner: actionCounts(raw.counts?.learner), aiTypes: {}};
  for (const type of TYPES) {
    const actions = actionCounts(raw.counts?.aiTypes?.[type]);
    if (Object.keys(actions).length) counts.aiTypes[type] = actions;
  }
  if (!raw.counts) history.forEach((entry) => addCount(counts, entry));
  return {kind: raw.kind, history: structuredClone(history.slice(-HISTORY_LIMIT)), counts};
}

/** @param {?Blockly.Block} block @returns {'created'|'assisted'|'learner'} */
export function authorshipOf(block) {
  return recordOf(block)?.kind || 'learner';
}

/** @param {?Blockly.Block} block @returns {string} */
export function creatorOf(block) {
  return authorshipOf(block) === 'created' ? Creator.ASSISTANT : Creator.LEARNER;
}

/** @param {?Blockly.Block} block @returns {!Array<!Object>} */
export function historyOf(block) {
  return recordOf(block)?.history || [];
}

/** All actions, including history entries folded away. @param {?Blockly.Block} block @returns {!Object} */
export function countsOf(block) {
  return recordOf(block)?.counts || {ai: {}, learner: {}, aiTypes: {}};
}

/** @param {?Blockly.Block} block @returns {boolean} */
export function editedByLearner(block) {
  return Object.values(countsOf(block).learner).some((count) => count > 0);
}

function setRecord(block, record, {group = null, immediate = false} = {}) {
  const data = readData(block.data);
  data[DATA_KEY] = record;
  const before = block.data || null;
  const after = JSON.stringify(data);
  if (before === after) return;
  block.data = after;
  if (!Blockly.Events.isEnabled()) return;
  const event = new AuthorshipChange(block, before, after);
  if (group !== null) event.group = group;
  // A learner event is already on the undo stack; put its note beside it before the next group arrives.
  if (immediate) block.workspace.fireChangeListener(event);
  else Blockly.Events.fire(event);
}

function appendEntry(block, entry, {kind = 'assisted', group = null, immediate = false} = {}) {
  const target = owner(block);
  if (!target || target.isShadow()) return;
  const record = recordOf(target) || {kind, history: [], counts: {ai: {}, learner: {}, aiTypes: {}}};
  const last = record.history[record.history.length - 1];
  const merge = entry.by === 'learner' && entry.action === 'field' && last?.by === 'learner' &&
    last.action === 'field' && last.field === entry.field &&
    Date.parse(entry.at) - Date.parse(last.at) >= 0 && Date.parse(entry.at) - Date.parse(last.at) <= FIELD_MERGE_MS;
  if (merge) record.history[record.history.length - 1] = entry;
  else {
    record.history.push(entry);
    addCount(record.counts, entry);
    record.history = record.history.slice(-HISTORY_LIMIT);
  }
  setRecord(target, record, {group, immediate});
}

/** @param {!Blockly.Block} block @param {!Object=} entry */
export function markCreated(block, entry = {}) {
  appendEntry(block, {by: 'ai', action: 'create', ...entry, at: entry.at || new Date().toISOString()}, {kind: 'created'});
}

/** @param {!Blockly.Block} block @param {!Object} entry @param {{group?: ?string}=} options */
export function markAssisted(block, entry, options = {}) {
  appendEntry(block, {by: 'ai', ...entry, at: entry.at || new Date().toISOString()}, options);
}

/** @param {!Array<!Blockly.Block>} blocks */
export function markMadeByAssistant(blocks) {
  for (const block of blocks) if (!block.isShadow()) markCreated(block);
}

export class AuthorshipChange extends Blockly.Events.BlockBase {
  /** @param {!Blockly.Block=} block @param {?string=} oldData @param {?string=} newData */
  constructor(block, oldData, newData) {
    super(block);
    this.type = AUTHORSHIP_EVENT;
    this.oldData = oldData ?? null;
    this.newData = newData ?? null;
  }

  toJson() {
    const json = super.toJson();
    json.oldData = this.oldData;
    json.newData = this.newData;
    return json;
  }

  static fromJson(json, workspace, event) {
    const change = super.fromJson(json, workspace, event ?? new AuthorshipChange());
    change.oldData = json.oldData ?? null;
    change.newData = json.newData ?? null;
    return change;
  }

  isNull() {
    return this.oldData === this.newData;
  }

  run(forward) {
    const block = this.getEventWorkspace_().getBlockById(this.blockId);
    if (block) block.data = forward ? this.newData : this.oldData;
  }
}

Blockly.registry.register(Blockly.registry.Type.EVENT, AUTHORSHIP_EVENT, AuthorshipChange, true);

function withoutConnectionAuthorship(connection) {
  const copy = {...connection};
  for (const key of ['block', 'shadow']) {
    if (copy[key]) copy[key] = withoutAuthorship(copy[key]);
  }
  return copy;
}

/** Returns a saved block tree without creator records, preserving the original and other data keys.
 * @param {!Object} state @returns {!Object}
 */
export function withoutAuthorship(state) {
  const copy = {...state};
  const data = readData(copy.data);
  if (Object.hasOwn(data, DATA_KEY)) {
    delete data[DATA_KEY];
    if (Object.keys(data).length) copy.data = JSON.stringify(data);
    else delete copy.data;
  }
  if (copy.inputs) {
    copy.inputs = Object.fromEntries(Object.entries(copy.inputs).map(([name, connection]) =>
      [name, withoutConnectionAuthorship(connection)]));
  }
  if (copy.next) copy.next = withoutConnectionAuthorship(copy.next);
  return copy;
}

export class LearnerCopyPaster extends Blockly.clipboard.BlockPaster {
  paste(copyData, workspace, coordinate) {
    return super.paste({...copyData, blockState: withoutAuthorship(copyData.blockState)}, workspace, coordinate);
  }
}

Blockly.registry.register(Blockly.registry.Type.PASTER, Blockly.clipboard.BlockPaster.TYPE, new LearnerCopyPaster(), true);

/** @param {!Blockly.Workspace} workspace @returns {{dispose: function(): void}} */
export function trackLearnerEdits(workspace) {
  const placesNow = () => new Map(workspace.getAllBlocks(false).map((block) => [block.id, authorshipPlace(block)]));
  let places = placesNow();
  let groupPlaces = places;
  let moveGroup = null;
  const listener = (event) => {
    if ([Blockly.Events.BLOCK_MOVE, Blockly.Events.BLOCK_CREATE, Blockly.Events.BLOCK_DELETE].includes(event.type)) {
      // A disconnect and reconnect arrive as separate events for the same move.
      if (!event.group || event.group !== moveGroup) { groupPlaces = places; moveGroup = event.group; }
      places = placesNow();
    }
    const before = groupPlaces;
    if (!event.recordUndo || String(event.group || '').startsWith(AGENT_GROUP)) return;
    const block = owner(workspace.getBlockById(event.blockId));
    if (!recordOf(block)) return;
    let entry;
    if (event.type === Blockly.Events.BLOCK_CHANGE && ['field', 'mutation'].includes(event.element)) {
      entry = {by: 'learner', action: event.element === 'field' ? 'field' : 'shape',
        ...(event.element === 'field' ? {field: event.name} : {}), at: new Date().toISOString()};
    } else if (event.type === Blockly.Events.BLOCK_MOVE) {
      const learnerMove = event.reason?.some((reason) => ['drag', 'connect', 'disconnect', 'cleanup'].includes(reason));
      // Loading XML positions its new roots; that is not a later learner edit.
      if (event.reason?.includes('create') && !learnerMove) return;
      const oldPlace = before.get(event.blockId);
      const newPlace = places.get(event.blockId);
      const sameList = oldPlace && newPlace && (oldPlace.container || oldPlace.root) ===
        (newPlace.container || before.get(newPlace.root)?.container || before.get(newPlace.root)?.root || newPlace.root);
      entry = {by: 'learner', action: sameList && oldPlace.previous !== newPlace.previous ? 'reorder' : 'move', at: new Date().toISOString()};
    } else return;
    // Give an ungrouped edit a group before adding its undoable note.
    if (!event.group) event.group = `learner-${Blockly.utils.idGenerator.genUid()}`;
    appendEntry(block, entry, {group: event.group, immediate: true});
  };
  workspace.addChangeListener(listener);
  return {dispose: () => workspace.removeChangeListener(listener)};
}

/** The owning statement list or value input, independent of a block's position within it. @param {!Blockly.Block} block */
export function authorshipPlace(block) {
  let first = block;
  let previous = first.previousConnection?.targetConnection;
  while (previous && previous.getSourceBlock().nextConnection === previous) {
    first = previous.getSourceBlock();
    previous = first.previousConnection?.targetConnection;
  }
  const target = first.outputConnection?.targetConnection || previous;
  const parent = target?.getSourceBlock();
  const input = parent?.inputList.find((candidate) => candidate.connection === target)?.name;
  const predecessor = block.previousConnection?.targetConnection?.getSourceBlock();
  return {root: first.id, container: parent ? `${parent.id}:${input}` : null,
    previous: predecessor && predecessor.nextConnection === block.previousConnection?.targetConnection ? predecessor.id : null};
}
