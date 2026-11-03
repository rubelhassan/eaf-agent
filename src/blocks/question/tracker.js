/**
 * Gap tracker: keeps question blocks and their answers consistent as the learner
 * edits.
 *
 * After each batch of workspace events it:
 *   1. unbinds answer blocks that left their gap (dragged away, deleted, or copies);
 *   2. docks answers put into a question's slot: the question vanishes and the
 *      answer takes its place;
 *   3. fills a statement question that a learner run landed directly above;
 *   4. binds a learner block placed where a gap's question or answer used to be
 *      (value sockets: the question or old answer was displaced);
 *   5. binds runs that joined a statement gap (below an answer block, or above the first);
 *   6. restores the question where a gap lost all its answer blocks.
 *
 * Only connect events count as the learner placing a block (loading a file creates
 * blocks already connected and must not fill anything). The tracker's own changes
 * join the triggering event group, so one undo reverts an action and its
 * consequences; the batch of events they produce is not re-processed as learner
 * actions. Undo/redo replays are not re-processed either. In teacher mode,
 * questions are ordinary blocks and nothing is filled or bound.
 */

import * as Blockly from 'blockly/core';
import {withConnectionRulesSuspended} from '../connection_checker.js';
import {vanish} from '../effects.js';
import {getPolicy} from '../policy.js';
import {BINDING_EVENT, getBinding, setBinding} from './binding.js';
import {ANSWER_INPUT, Expects, QUESTION_TYPE, normalizeConfig} from './model.js';
import {chainFrom, evaluateInsert, gapOf, isQuestion, membersOf} from './rules.js';
import {markAttempted, takePendingChoice} from './session.js';
import {placedText} from './speech.js';
import {AGENT_GROUP} from '../authorship.js';

/**
 * Where a gap sits: the connection its question or first answer block hangs from.
 * @typedef {({parentId: string, inputName: ?string}|{standalone: true, x: number, y: number})} GapLocation
 */

/**
 * @param {!Blockly.Block} block
 * @returns {!GapLocation} A parent connection, or the standalone position.
 */
export function locationOf(block) {
  const parentConnection = (block.outputConnection || block.previousConnection)?.targetConnection;
  if (!parentConnection) {
    const {x, y} = block.getRelativeToSurfaceXY();
    return {standalone: true, x, y};
  }
  const parent = parentConnection.getSourceBlock();
  const input = parent.inputList.find((i) => i.connection === parentConnection);
  return {parentId: parent.id, inputName: input ? input.name : null};
}

function sameLocation(a, b) {
  if (!a || !b) return false;
  if (a.standalone || b.standalone) return !!a.standalone && !!b.standalone;
  return a.parentId === b.parentId && a.inputName === b.inputName;
}

/** @returns {?Blockly.Connection} The live connection at a location, if its parent still exists. */
function connectionAt(workspace, location) {
  if (location?.standalone) return null;
  const parent = location && workspace.getBlockById(location.parentId);
  if (!parent || parent.isDeadOrDying?.()) return null;
  return location.inputName ? parent.getInput(location.inputName)?.connection ?? null : parent.nextConnection;
}

/** The block directly above a statement block in its stack (not an enclosing container). */
function predecessorOf(block) {
  const above = block?.previousConnection?.targetConnection;
  if (!above) return null;
  const owner = above.getSourceBlock();
  return above === owner.nextConnection ? owner : null;
}

/** @returns {?Blockly.Block} The question whose answer slot `connection` is. */
function questionOfSlot(connection) {
  const owner = connection?.getSourceBlock();
  return isQuestion(owner) && owner.getInput(ANSWER_INPUT)?.connection === connection ? owner : null;
}


export class GapTracker {
  /**
   * @param {!Blockly.Workspace} workspace
   * @param {{announce?: function(string): void}=} options  `announce` speaks to the learner.
   */
  constructor(workspace, options = {}) {
    this.workspace = workspace;
    this.announce_ = options.announce || (() => {});
    /** @type {!Map<string, {config: !Object, location: ?GapLocation, answered: boolean, first?: string}>} */
    this.gaps = new Map();
    this.scheduled_ = false;
    /** True after the tracker changed the workspace: the next batch of events is its own. */
    this.expectOwnBatch_ = false;
    this.listener_ = (event) => this.onEvent_(event);
    this.resetBatch_();
  }

  /** @returns {!GapTracker} */
  attach() {
    this.snapshot_();
    this.workspace.addChangeListener(this.listener_);
    return this;
  }

  dispose() {
    this.workspace.removeChangeListener(this.listener_);
  }

  resetBatch_() {
    /** @type {!Set<string>} Blocks connected to a parent this batch (the learner placed them). */
    this.placed_ = new Set();
    /** @type {!Set<string>} Blocks being dragged, or dropped, this batch. */
    this.dragged_ = new Set();
    /** @type {!Set<string>} Blocks created this batch (e.g. a pasted stack). */
    this.created_ = new Set();
    /** @type {!Map<string, !GapLocation>} Where blocks were unplugged from this batch. */
    this.leftFrom_ = new Map();
    /** @type {!Map<string, !Object>} Serialized state of blocks deleted this batch. */
    this.deleted_ = new Map();
    this.group_ = null;
    this.replay_ = false;
    this.ownBatch_ = false;
  }

  onEvent_(event) {
    if (event.workspaceId !== this.workspace.id || event.type === BINDING_EVENT) return;
    const E = Blockly.Events;
    if (event.type === E.FINISHED_LOADING) {
      // Loaded bindings rebuild the snapshot; they are not pasted answers.
      this.gaps.clear();
      this.replay_ = true;
      this.schedule_();
      return;
    }
    if (![E.BLOCK_MOVE, E.BLOCK_CREATE, E.BLOCK_DRAG, E.BLOCK_DELETE, E.BLOCK_CHANGE].includes(event.type)) return;
    if (this.expectOwnBatch_) {
      this.ownBatch_ = true;
    } else {
      this.record_(event);
    }
    this.schedule_();
  }

  record_(event) {
    const E = Blockly.Events;
    switch (event.type) {
      case E.BLOCK_MOVE:
        if (event.newParentId) this.placed_.add(event.blockId);
        if (event.oldParentId && !this.leftFrom_.has(event.blockId)) {
          this.leftFrom_.set(event.blockId, {parentId: event.oldParentId, inputName: event.oldInputName ?? null});
        }
        break;
      case E.BLOCK_CREATE:
        for (const id of event.ids || [event.blockId]) this.created_.add(id);
        break;
      case E.BLOCK_DRAG:
        for (const block of event.blocks || []) this.dragged_.add(block.id);
        break;
      case E.BLOCK_DELETE:
        if (event.oldJson) this.deleted_.set(event.blockId, event.oldJson);
        break;
    }
    // Undo/redo replays run with recordUndo off. Only structural events are a
    // reliable signal: UI events (drag, selection) and some change events (e.g.
    // Blockly's "inline" change) are never recorded either.
    const structural = [E.BLOCK_MOVE, E.BLOCK_CREATE, E.BLOCK_DELETE].includes(event.type);
    if (structural && event.recordUndo === false) this.replay_ = true;
    if (event.group) this.group_ = event.group;
  }

  schedule_() {
    if (this.scheduled_) return;
    this.scheduled_ = true;
    setTimeout(() => {
      this.scheduled_ = false;
      this.reconcile();
    }, 0);
  }

  /** Processes the pending batch. */
  reconcile() {
    if (!this.workspace.getAllBlocks) return;
    const ownBatch = this.ownBatch_;
    this.expectOwnBatch_ = false;
    if (!ownBatch && !this.replay_ && !getPolicy(this.workspace).teacherMode) {
      const previousGroup = Blockly.Events.getGroup();
      Blockly.Events.setGroup(this.group_ || true);
      try {
        withConnectionRulesSuspended(() => this.apply_());
      } finally {
        Blockly.Events.setGroup(previousGroup || false);
      }
    }
    this.resetBatch_();
    this.snapshot_();
  }

  apply_() {
    this.learnFromEvents_();
    const runs = this.placedRuns_();
    const answerRuns = this.group_?.startsWith(AGENT_GROUP) ? [] : runs;
    this.unbindDepartures_(new Set(runs.flat()));
    this.dockSlotAnswers_(answerRuns);
    this.fillStatementQuestions_(answerRuns);
    this.bindAtKnownLocations_(answerRuns);
    this.joinStatementGaps_(answerRuns);
    this.replaceWrongAnswers_(runs);
    this.restoreEmptiedGaps_();
  }

  /** A block picked from Show choices replaces the answer blocks that didn't fit. */
  replaceWrongAnswers_(runs) {
    for (const block of runs.flat()) {
      const binding = getBinding(block);
      const pending = binding && takePendingChoice(this.workspace, binding.gap, block.type);
      if (!pending) continue;
      for (const id of pending.remove) {
        const old = this.workspace.getBlockById(id);
        if (!old || old === block) continue;
        this.changed_();
        old.dispose(/* healStack= */ true);
      }
      const names = [...new Set(pending.names)].map((n) => `the ${n} block`).join(' and ');
      this.announce_(`Replaced ${names} with your choice. ${placedText([block], gapOf(block), this.workspace)}`);
      return;
    }
  }

  /** Marks that the tracker changed blocks, so the resulting events are not learner actions. */
  changed_() {
    this.expectOwnBatch_ = true;
  }

  /**
   * Where a question or first answer block was unplugged from this batch is
   * where its gap is. This takes precedence over the last snapshot, which may be
   * missing (program built with events off) or already reflect this batch's changes.
   */
  learnFromEvents_() {
    for (const [id, location] of this.leftFrom_) {
      const block = this.workspace.getBlockById(id);
      const json = this.deleted_.get(id);
      if (block ? isQuestion(block) : json?.type === QUESTION_TYPE) {
        const config = this.gaps.get(id)?.config ??
          (block ? block.getQuestionConfig() : normalizeConfig(json.extraState));
        this.gaps.set(id, {config, location, answered: false});
        continue;
      }
      const binding = block ? getBinding(block) : getBinding({data: json?.data});
      if (!binding) continue;
      const parent = this.workspace.getBlockById(location.parentId);
      const parentBinding = parent ? getBinding(parent) : getBinding({data: this.deleted_.get(location.parentId)?.data});
      // Healing after a member was deleted does not move the remaining answer out of its gap.
      if (parentBinding?.gap === binding.gap) continue;
      this.gaps.set(binding.gap, {config: binding.config, location, answered: true});
    }
  }

  /**
   * A block that slid up because the block above it was removed or dragged away
   * (Blockly heals the stack) was not placed by the learner.
   */
  isHeal_(id) {
    const previous = this.leftFrom_.get(id)?.parentId;
    return !!previous && (this.leftFrom_.has(previous) || this.deleted_.has(previous)) && !this.dragged_.has(id);
  }

  travelled_(block) {
    return this.dragged_.has(block.id) || this.created_.has(block.id);
  }

  /**
   * Runs the learner placed this batch: each placed block plus the followers that
   * travelled with it. A question that got attached below a dragged stack (the
   * stack was dropped onto its top) yields the stack above it.
   */
  placedRuns_() {
    const runs = [];
    for (const id of this.placed_) {
      const block = this.workspace.getBlockById(id);
      if (!block || block.isShadow() || !block.getParent() || this.isHeal_(id)) continue;
      if (isQuestion(block)) {
        const run = [];
        for (let p = predecessorOf(block); p && !isQuestion(p) && this.travelled_(p); p = predecessorOf(p)) {
          run.unshift(p);
        }
        if (run.length) runs.push(run);
        continue;
      }
      const run = [block];
      if (block.previousConnection) {
        for (let p = predecessorOf(block); p && !isQuestion(p) && this.travelled_(p); p = predecessorOf(p)) {
          run.unshift(p);
        }
        for (const next of chainFrom(block).slice(1)) {
          if (isQuestion(next) || !this.travelled_(next)) break;
          run.push(next);
        }
      }
      runs.push(run);
    }
    return runs;
  }

  /**
   * A loose answer moves with its gap. Connected answers lose their binding when they leave it.
   */
  unbindDepartures_(placed) {
    const bound = this.workspace.getAllBlocks(false).filter((b) => !b.isInsertionMarker?.() && getBinding(b));
    const byGap = new Map();
    for (const block of bound) {
      const {gap} = getBinding(block);
      if (!byGap.has(gap)) byGap.set(gap, []);
      byGap.get(gap).push(block);
    }
    for (const [gap, members] of byGap) {
      const known = this.gaps.get(gap);
      const root = this.workspace.getBlockById(known?.first) || members[0];
      // Remember the original head so a detached follower or a copy cannot become the loose gap.
      const loose = known?.location?.standalone && !root.getParent() &&
        !placed.has(root) && !this.created_.has(root.id) ? new Set(chainFrom(root)) : new Set();
      const staying = new Set(members.filter((m) =>
        loose.has(m) || m.getParent() && !placed.has(m) && !this.dragged_.has(m.id)));
      for (let changed = true; changed;) {
        changed = false;
        for (const m of staying) {
          const parent = m.getParent();
          if (members.includes(parent) && !staying.has(parent)) {
            staying.delete(m);
            changed = true;
          }
        }
      }
      for (const m of members) if (!staying.has(m)) setBinding(m, null);
    }
  }

  /**
   * Answers put into a question's slot: the question vanishes and the answer
   * (with any blocks after it in the slot) docks where the question was.
   */
  dockSlotAnswers_(runs) {
    const questions = new Set();
    for (const run of runs) {
      const top = run[0];
      const question = questionOfSlot((top.outputConnection || top.previousConnection)?.targetConnection);
      if (question) questions.add(question);
    }
    for (const question of questions) this.dock_(question);
  }

  dock_(question) {
    const first = question.getInputTargetBlock(ANSWER_INPUT);
    if (!first) return;
    const gap = question.id;
    const config = question.getQuestionConfig();
    const value = !!question.outputConnection;
    const answers = value ? [first] : chainFrom(first);
    const parentConnection = (value ? question.outputConnection : question.previousConnection).targetConnection;
    const below = value ? null : question.getNextBlock();
    const position = question.getRelativeToSurfaceXY();

    this.changed_();
    first.unplug(/* healStack= */ false);
    vanish(question); // after the answer is lifted out, so only the empty question fades
    question.dispose(/* healStack= */ true);
    const own = value ? first.outputConnection : first.previousConnection;
    if (parentConnection) {
      parentConnection.connect(own);
    } else {
      const at = first.getRelativeToSurfaceXY();
      first.moveBy(position.x - at.x, position.y - at.y);
      if (below && !below.getParent()) answers[answers.length - 1].nextConnection.connect(below.previousConnection);
    }
    this.bind_(answers, gap, config);
    this.announce_(placedText(answers, gapOf(answers[0]), this.workspace));
  }

  /**
   * A learner run that landed directly above or below an empty statement question
   * replaces it: dropping a little off the slot is still an answer.
   */
  fillStatementQuestions_(runs) {
    const empty = (b) => isQuestion(b) && !b.getInputTargetBlock(ANSWER_INPUT);
    for (const run of runs) {
      if (getBinding(run[0])) continue;
      const question = [run[run.length - 1].getNextBlock(), predecessorOf(run[0])].find(empty);
      if (!question) continue;
      const config = question.getQuestionConfig();
      const {activity} = getPolicy(this.workspace);
      if (!evaluateInsert(config, run.map((b) => b.type), [], activity).ok) continue;
      const gap = question.id;
      this.removeQuestion_(question);
      this.bind_(run, gap, config);
      this.announce_(placedText(run, gapOf(run[0]), this.workspace));
    }
  }

  /**
   * A learner block now hangs where a gap sat, and the gap's question or answer
   * is gone from there (displaced, bumped, or deleted): it takes over the gap.
   */
  bindAtKnownLocations_(runs) {
    for (const run of runs) {
      if (getBinding(run[0])) continue;
      const location = locationOf(run[0]);
      for (const [gap, known] of this.gaps) {
        if (!sameLocation(location, known.location)) continue;
        if (membersOf(this.workspace, gap).length) continue;
        const question = this.workspace.getBlockById(gap);
        if (isQuestion(question)) {
          if (sameLocation(locationOf(question), known.location)) continue;
          this.removeQuestion_(question);
        }
        this.bind_(run, gap, known.config);
        this.announce_(placedText(run, gapOf(run[0]), this.workspace));
        break;
      }
    }
  }

  /** Runs placed below a statement answer block, or right above the first one, join its gap. */
  joinStatementGaps_(runs) {
    for (const run of runs) {
      if (getBinding(run[0])) continue;
      const above = getBinding(predecessorOf(run[0]));
      const below = getBinding(run[run.length - 1].getNextBlock());
      const binding = above || below;
      if (!binding || binding.config.expects === Expects.VALUE) continue;
      this.bind_(run, binding.gap, binding.config);
    }
  }

  /**
   * Gaps that lost every answer block get their question back at the same spot.
   * (A question the learner deleted or moved while unanswered is not restored.)
   */
  restoreEmptiedGaps_() {
    for (const [gap, known] of this.gaps) {
      if (!known.answered) continue;
      if (membersOf(this.workspace, gap).length || isQuestion(this.workspace.getBlockById(gap))) continue;
      const standalone = known.location?.standalone;
      const connection = connectionAt(this.workspace, known.location);
      if (!standalone && !connection) continue;
      // A drag preview may be sitting in the spot; try again after the drop.
      if (connection?.targetBlock()?.isInsertionMarker()) continue;
      const value = connection?.type === Blockly.ConnectionType.INPUT_VALUE;
      if (value && connection.isConnected()) continue;

      this.changed_();
      const question = this.workspace.newBlock(QUESTION_TYPE, this.workspace.getBlockById(gap) ? undefined : gap);
      question.setQuestionConfig(known.config);
      if (question.initSvg) {
        question.initSvg();
        question.render();
      }
      if (standalone) {
        const at = question.getRelativeToSurfaceXY();
        question.moveBy(known.location.x - at.x, known.location.y - at.y);
      } else {
        connection.connect(value ? question.outputConnection : question.previousConnection);
      }
      this.announce_('The question is open again.');
    }
  }

  /** Removes a question block, healing the stack below it. */
  removeQuestion_(question) {
    this.changed_();
    vanish(question);
    question.dispose(/* healStack= */ true);
  }

  bind_(run, gap, config) {
    for (const block of run) setBinding(block, {gap, config});
    markAttempted(this.workspace, gap);
  }

  /** Records every gap's config and location for the next batch. */
  snapshot_() {
    const gaps = new Map();
    for (const block of this.workspace.getAllBlocks(false)) {
      if (block.isInsertionMarker?.()) continue;
      if (isQuestion(block)) {
        gaps.set(block.id, {config: block.getQuestionConfig(), location: locationOf(block), answered: false});
      } else {
        const binding = getBinding(block);
        if (binding && membersOf(this.workspace, binding.gap)[0] === block) {
          markAttempted(this.workspace, binding.gap);
          gaps.set(binding.gap, {config: binding.config, location: locationOf(block), answered: true, first: block.id});
        }
      }
    }
    // Answered gaps that were emptied but not yet restored (e.g. mid-drag) are kept.
    for (const [gap, known] of this.gaps) {
      if (!gaps.has(gap) && known.answered &&
          (known.location?.standalone || connectionAt(this.workspace, known.location))) gaps.set(gap, known);
    }
    this.gaps = gaps;
  }
}
