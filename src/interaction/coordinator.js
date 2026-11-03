// @ts-check
// The conversation: each submitted message becomes a task that runs through the harness. The coordinator holds
// what it offers, and applies, undoes or withdraws it only on the learner's word. Headless; the app passes the
// cursor and what to do on screen.

import * as Blockly from 'blockly/core';
import {OFF_TOPIC_REPLY, runIntent} from '../agent/harness/intent.js';
import {runComprehend} from '../agent/harness/comprehend.js';
import {PLAN_ACTIONS as PLAN_HANDLERS, runPlanAction} from '../agent/harness/run.js';
import {runSearch} from '../agent/harness/search.js';
import {applyPlan, validatePlan} from '../agent/editor/plan.js';
import {splitSteps} from '../agent/editor/split.js';
import {differenceWords, guidedStep, stepDone} from '../agent/editor/guided.js';
import {blockPositions, snapshot} from '../agent/context/snapshot.js';
import {blockName} from '../blocks/block_names.js';
import {opsInWords} from '../agent/context/ops_in_words.js';
import {workspaceVersion} from '../agent/context/version.js';
import {Activity, EditMode, LearnerLevel, getPolicy, onPolicyChange} from '../blocks/policy.js';
import {QUESTION_TYPE} from '../blocks/question/model.js';
import {getBinding} from '../blocks/question/binding.js';
import {matchCommand} from './commands.js';
import {scopeFor} from './scope.js';
import {answersNow, taskContext} from './task_context.js';
import {AGENT_GROUP} from './events.js';
import {AUTHORSHIP_EVENT} from '../blocks/authorship.js';
import {captureBlocks, blockChanges, recordChanges, recordBlockChanges} from '../blocks/authorship_summary.js';
import {splitSentences} from '../output/sentences.js';

const SAY = {
  failed: "Sorry, I couldn't work that out. Please try again.",
  unclearAnswer: "I didn't understand your answer. Can you say it again?",
  unreachable: "Sorry, I can't connect right now. Please try again later.",
  busy: (name) => `${name} is busy right now. Please try again in a moment.`,
  noChange: "Sorry, I couldn't make a change that works in your program. Please try saying it another way.",
  quiz: "During the quiz I can explain a block, find a block, or open a question's help.",
  quizScope: 'During the quiz I can explain one block at a time. Move to a block, then ask.',
  hintWhere: 'Move to the question you need help with, then ask me again.',
  hintOpen: "Here is this question's help.",
  applyFailed: "The program changed, so this step doesn't fit any more. Ask me again.",
  noUndo: "The program changed since that step, so I can't take it back safely. You can still use undo in the editor.",
  allOff: 'Doing all steps at once is turned off for this task.',
  stopped: 'Okay, I stopped.',
  withdrawn: "Okay, I won't make that change.",
  undoHint: 'Say undo to take back a step.',
  stillFits: 'Your program changed since I offered this. It still fits. Say yes again to do it.',
  noFit: "Your program changed, so this plan doesn't fit any more. Should I make a new one?",
  changedFits: 'Your program changed while I was working. This step still fits.',
  changedNoFit: "Your program changed while I was working, so this plan doesn't fit any more. Should I make a new one?",
  checking: "Your program changed while I was working, so I'm checking again.",
  working: "I'm working on it.",
  stillWorking: "I'm still working on it.",
  stillChanging: "Your program is still changing. Ask me again when you're ready.",
  planEnded: 'This plan has ended.',
  guidedYes: "Do this step in your program; I'll tell you when it's done.",
  guidedStopped: 'Okay, I stopped guiding. Your changes stay.',
  guidedNotYet: "It doesn't match the step yet.",
  consent: 'Should I do it? Say yes or no.',
  consentAll: 'Should I do it? Say yes or no, or all for every step.',
  fixQuestion: 'Do you want to hear the fix? Say yes or no.',
  noStep: "Okay, I won't do it now. Say yes when you're ready, or cancel.",
  noFix: 'Okay. Say yes when you want to hear the fix, or cancel.',
  noGuided: "Okay. Do the step when you're ready, or say cancel.",
  kept: "Okay, I'll keep it.",
  okay: 'Okay.',
  undoChange: (words) => `Undo the change? ${words} Say yes or no.`,
  undoStep: (last) => `Undo step ${last.from + 1}? ${last.words.join(' ')} Say yes or no.`,
  undoSteps: (last) => `Undo steps ${last.from + 1} to ${last.from + last.count}? Say yes or no.`,
  keys: 'Keys: W and S move between blocks, F goes into a block, Q goes out, E switches edit mode, T opens the toolbox, ' +
    'and C says where you are.',
};
// While a field editor is open the learner is still typing; feedback waits.
const FIELD_WAIT_MS = 250;
// A message whose reply isn't ready after a second hears it is being worked on, then again every 10 seconds.
const WORKING_AFTER_MS = 1000;
const STILL_WORKING_MS = 10000;
// What a debug issue does, for a line made in code when the model's line can't be spoken.
const ISSUE_EFFECT = {
  wontRun: 'It stops the program from running.',
  runtimeError: 'It makes the program stop with an error while it runs.',
  wrongResult: 'It makes the program give the wrong result.',
  fragile: 'The program works, but this part could easily break.',
};
// Debug v2 and v3 severities.
const OLD_SEVERITY = {error: 'wontRun', warn: 'wrongResult', info: 'fragile'};
const LABELS = {how: 'How', check: 'Check', yes: 'Yes', no: 'No', cancel: 'Cancel', all: 'Do all steps', undo: 'Undo a step', go: 'Go there', repeat: 'Hear again'};
const QUIZ_ACTIONS = ['COMPREHEND', 'SEARCH', 'HINT'];
const PLAN_ACTIONS = ['DEBUG', 'EDIT_GUIDE'];
const OPEN = ['working', 'applying', 'awaiting'];

/**
 * @param {!PlanView} view
 * @param {number} index  Zero-based step index.
 * @returns {string} The step's stored sentences with the consent question.
 */
export function stepLine(view, index) {
  const head = view.steps.length === 1 ? "Here's the change." : `Step ${index + 1} of ${view.steps.length}.`;
  return `${head} ${view.steps[index].words} ${view.canAll ? SAY.consentAll : SAY.consent}`;
}

/** Drops only the model's closing questions; code asks for consent. */
function summaryOf(line) {
  const sentences = splitSentences(line);
  while (sentences.length && sentences[sentences.length - 1].trim().endsWith('?')) sentences.pop();
  return sentences.join(' ');
}

function withLineage(steps) {
  return structuredClone(steps).map((step, from) => ({...step, split: {from, part: 0, of: 1}}));
}

function mergeParts(steps) {
  const merged = [];
  for (const step of steps) {
    const previous = merged[merged.length - 1];
    if (previous && previous.split.from === step.split.from) previous.ops.push(...step.ops);
    else merged.push({...step, ops: [...step.ops], split: {...step.split, part: 0, of: 1}});
  }
  return merged;
}

/** The question a block belongs to: the question itself, or the answer it is part of. */
function questionAt(block) {
  for (let b = block; b; b = b.getParent()) if (b.type === QUESTION_TYPE || getBinding(b)) return b;
  return null;
}

/**
 * @typedef {{say: string, actions: !Array<{name: string, label: string}>, expectsAnswer: boolean, taskId: ?string,
 *     kind: string}} Reply
 *     say: empty when there is nothing to speak; expectsAnswer: the learner's next words answer this reply;
 *     kind: answer | question | offer | outcome | error, for the output manager
 */

/** @typedef {{block: ?string, field?: ?string, at?: ?{x: number, y: number}}} Cursor */

/**
 * @typedef {{proposalId: string, kind: string, ended: boolean, canAll: boolean,
 *     steps: !Array<{words: string, status: string}>}} PlanView
 *     status: next | waiting | applied | doneByYou | undone | notDone; a step taken back mid-plan is next again
 */

/**
 * @param {{workspace: !Blockly.Workspace, client: !import('../agent/model/agent_client.js').AgentClient,
 *     cursor: function(): Cursor, stackLetters?: function(): ?Map<string, string>,
 *     moveCursor?: function((string|!Cursor), {focus?: boolean}=): void, openQuestion?: function(string): void,
 *     onEvent?: function(string, !Object): void, onProgress?: function(string, string): void,
 *     onPlanChange?: function(?PlanView): void, onReply?: function(!Reply): void}} options
 *     cursor: at is the spot when the cursor is on empty workspace
 *     moveCursor: to a block (or a cursor taken earlier); focus false leaves keyboard focus where it is
 *     onEvent: task events (kind, data); onProgress: a line to say while a task works (text, taskId);
 *     onPlanChange: the step list changed (see plan()); onReply: a reply nobody asked for (a guided step the learner
 *     finished, or a guided plan that no longer fits). Required for automatic Guided completion and the doesn't-fit
 *     line; without it, the learner uses Check.
 */
export function createCoordinator(options) {
  const {workspace: ws, client} = options;
  const stackLetters = () => options.stackLetters?.() || null;
  const onEvent = options.onEvent || (() => {});
  const cache = new Map();
  const messageRequests = new Map();
  let counter = 0;
  /** The debug or edit task: it holds what is offered. */
  let main = null;
  /** The task of the latest message (a short task, a question asked back, or main). */
  let current = null;
  /** Applied steps across tasks, newest last. */
  const receipts = [];
  let found = null;
  let lastSay = '';
  /** The latest offered proposal, kept after it ends for the step list. */
  let lastPlan = null;
  let lastPlanJson = 'null';
  let question = null;

  const newId = (prefix) => `${prefix}${++counter}`;
  const quiz = () => getPolicy(ws).activity === Activity.QUIZ;
  const allowedTypes = () => ws.allowedTypeCatalog || null;
  // Task events carry the action once it is known, so the logs can count by action.
  const emit = (kind, task, data = {}) => onEvent(kind, {taskId: task?.taskId ?? null, revision: task?.revision ?? null,
    ...(kind.startsWith('task.') && task?.action ? {action: task.action} : {}), ...data});

  const working = () => [current, main].find((t) => t && (t.state === 'working' || t.state === 'applying')) || null;
  /** Runs a change in an event group of its own, so the learner's own-work counts leave it out. */
  const asAgent = (task, change) => {
    Blockly.Events.setGroup(`${AGENT_GROUP}${task.taskId}-${newId('g')}`);
    try {
      return change();
    } finally {
      Blockly.Events.setGroup(false);
    }
  };
  const offered = () => (main?.state === 'awaiting' && main.proposal ? main.proposal : null);
  const asking = () => [current, main].find((t) => t?.state === 'awaiting' && t.question) || null;
  const canAll = (p) => !!p && p.presented && !p.guided && getPolicy(ws).wholePlan && p.steps.length - p.next > 1;
  /** The guided step waiting for the learner, when there is one. */
  const guiding = () => {
    const p = offered();
    return p?.guided && p.presented && !p.refit ? p : null;
  };
  const lockNow = () => (working() ? 'frozen' : question ? 'read-only' : guiding() || offered()?.deferred ? 'free' :
    offered() || asking() ? 'read-only' : 'free');

  function newTask(words) {
    question = null;
    const task = {taskId: newId('t'), action: null, revision: 1, state: 'working', abort: new AbortController(),
      request: {words, clarifications: [], corrections: []}, proposal: null, applied: [], question: null, lastSay: ''};
    emit('task.started', task);
    return task;
  }

  function finish(task, state) {
    if (!task || !OPEN.includes(task.state)) return;
    endGuidedStep(task.proposal);
    task.state = state;
    task.question = null;
    emit(`task.${state}`, task);
  }

  function cancelTask(task) {
    task.abort.abort();
    finish(task, 'cancelled');
  }

  function available() {
    if (question) return ['yes', 'no', 'cancel', 'repeat'];
    const names = [];
    const p = offered();
    // In Guided mode the learner does the step, so nothing here applies it.
    if (guiding()) names.push('how', 'check', 'keys');
    else if (p) names.push('yes', 'continue');
    if (canAll(p)) names.push('all');
    if (working() || (p && !asking())) names.push('no');
    if (working() || p || asking()) names.push('cancel');
    if (receipts.length) names.push('undo');
    if (found) names.push('go');
    if (lastSay) names.push('repeat');
    return names;
  }

  const answers = () => answersNow(available(),
      {proposal: offered(), lastApplied: receipts[receipts.length - 1]?.words, working: !!working(), question,
        lastReceipt: receipts[receipts.length - 1]});

  function buttons() {
    const p = offered() || current?.proposal;
    const undo = p === lastPlan && receipts.some((r) => r.proposal === p);
    return available().filter((name) => LABELS[name] && (name !== 'undo' || undo))
        .map((name) => ({name, label: LABELS[name]}));
  }

  /** The presented plan or fix (or the one that just ended), with each step's status. @returns {?PlanView} */
  function planView() {
    const p = lastPlan;
    if (!p?.presented) return null;
    const live = offered() === p;
    const applied = new Set();
    for (const r of receipts) {
      if (r.proposal === p) for (let i = r.from; i < r.from + r.count; i++) applied.add(i);
    }
    const status = (i) => (applied.has(i) ? 'applied' : p.doneByYou.has(i) ? 'doneByYou' : live && i === p.next ? 'next' :
      p.undone.has(i) ? 'undone' : live ? 'waiting' : 'notDone');
    return {proposalId: p.proposalId, kind: p.kind, guided: p.guided, ended: !live, canAll: live && canAll(p),
      steps: p.steps.map((_, i) => ({words: p.words[i], status: status(i)}))};
  }

  /** @returns {!Reply} */
  function reply(say, kind = 'answer', task = current) {
    if (say) {
      lastSay = say;
      if (task) task.lastSay = say;
    }
    const plan = planView();
    if (JSON.stringify(plan) !== lastPlanJson) {
      lastPlanJson = JSON.stringify(plan);
      options.onPlanChange?.(plan);
    }
    return {
      say,
      actions: buttons(),
      expectsAnswer: !!question || !!offered() || !!asking(),
      taskId: task?.taskId ?? null,
      kind,
    };
  }

  /** A reply for a task that was stopped or replaced while it worked: nothing to say. */
  const dropped = (task) => reply('', 'answer', task);
  const stale = (task) => task.abort.signal.aborted;

  /** Same question, same program, same answer; only valid results are kept. */
  // A call that never got an answer (no connection, timeout, model error) isn't the learner's fault.
  const failedSay = (r) => (r.error === 'RATE_LIMIT' ? SAY.busy(options.assistantName || 'Neon') : r.error ? SAY.unreachable : SAY.failed);

  async function cached(key, run) {
    const k = JSON.stringify([...key, workspaceVersion(ws)]);
    if (cache.has(k)) return cache.get(k);
    const result = await run();
    if (result.valid) cache.set(k, result);
    return result;
  }

  /** Keep the batch's location suppression unless the learner changed the program. */
  function stepWords(p) {
    if (workspaceVersion(ws) !== p.workspaceVersion) {
      p.words = [...p.words.slice(0, p.next), ...opsInWords(ws, p.steps.slice(p.next), {stackLetters: stackLetters()})];
    }
    return p.words[p.next];
  }

  function present(p) {
    p.deferred = false;
    if (p.guided) return presentGuided(p);
    stepWords(p);
    return stepLine(planView(), p.next);
  }

  /** A guided step: what the learner does, and the program it should give, to compare their changes with. */
  function presentGuided(p) {
    endGuidedStep(p);
    p.guidedStep = guidedStep(ws, p.steps[p.next], {allowedTypes: allowedTypes(), newStack: p.newStack});
    if (!p.guidedStep) {
      p.refit = true;
      return SAY.noFit;
    }
    p.authorshipBefore = captureBlocks(ws);
    p.authorshipGroup = null;
    emit('guided.step.presented', main, {proposalId: p.proposalId, step: p.next + 1, of: p.steps.length});
    const words = stepWords(p);
    if (p.next > 0) return `Step ${p.next + 1}: ${words}`;
    const n = p.steps.length;
    return n === 1 ? `Let's do it together. The change: ${words} I'll tell you when it's done.` :
      `Let's do it together, in ${n} steps. Step 1: ${words} I'll tell you when it's done.`;
  }

  function endGuidedStep(p) {
    p?.guidedStep?.dispose();
    if (p) { p.guidedStep = null; p.authorshipBefore = null; }
  }

  /** The learner did the guided step: the next one, or the end. */
  function guidedDone(task, p) {
    recordBlockChanges(ws, p.authorshipBefore, {type: 'guidance', task: task.taskId, group: p.authorshipGroup});
    emit('guided.step.done', task, {proposalId: p.proposalId, step: p.next + 1, of: p.steps.length});
    endGuidedStep(p);
    p.doneByYou.add(p.next);
    task.applied.push(p.words[p.next]);
    p.next += 1;
    p.workspaceVersion = workspaceVersion(ws);
    const n = p.steps.length;
    if (p.next < n) return reply(`Step ${p.next} done. ${present(p)}`, 'offer', task);
    finish(task, 'done');
    return reply(n === 1 ? 'Done. You made the change.' : `Step ${n} done. You did all ${n} steps.`, 'outcome', task);
  }

  /** "how": where to go, and the keys for beginners. */
  function guidedHow(p) {
    const op = p.steps[p.next].ops[0] || {};
    const target = op.op === 'insert' ? op.after || op.before || op.parent : op.block;
    const where = typeof target === 'string' ? cursorWords(target) : '';
    const step = where ? `Go to ${where}. Then ${p.words[p.next]}` : `The step: ${p.words[p.next]}`;
    return getPolicy(ws).learnerLevel === LearnerLevel.BEGINNER ? `${step} ${SAY.keys}` : step;
  }

  /** "check": done, or what still differs. */
  async function guidedCheck(p) {
    // Let Blockly deliver the learner's completing change and its undo group first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (guiding() !== p) return reply('');
    if (stepDone(p.guidedStep, ws)) return guidedDone(main, p);
    const differs = differenceWords(p.guidedStep, ws, {stackLetters: stackLetters()});
    return reply(differs || `${SAY.guidedNotYet} The step: ${p.words[p.next]}`, 'answer', main);
  }

  // After the learner's own changes: is the guided step done, and does the rest of the plan still fit?
  let guidedTimer = null;
  function afterLearnerChange() {
    guidedTimer = null;
    const p = guiding();
    if (!options.onReply || !p?.guidedStep) return;
    if (Blockly.WidgetDiv.isVisible() || Blockly.DropDownDiv.isVisible()) {
      guidedTimer = setTimeout(afterLearnerChange, FIELD_WAIT_MS);
      return;
    }
    if (stepDone(p.guidedStep, ws)) {
      options.onReply(guidedDone(main, p));
      return;
    }
    const rest = validatePlan(ws, p.steps.slice(p.next), {allowedTypes: allowedTypes(), newStack: p.newStack});
    rest.result?.dispose();
    if (rest.ok) return;
    p.refit = true;
    endGuidedStep(p);
    options.onReply(reply(SAY.noFit, 'question', main));
  }
  const onWorkspaceChange = (e) => {
    const p = guiding();
    if (!p || e.isUiEvent || e.type === AUTHORSHIP_EVENT || String(e.group || '').startsWith(AGENT_GROUP)) return;
    if (e.recordUndo) {
      if (!e.group) e.group = `learner-${Blockly.utils.idGenerator.genUid()}`;
      p.authorshipGroup = e.group;
    }
    if (!options.onReply || guidedTimer) return;
    // Undo and redo change the program too; Blockly emits them with recordUndo false.
    // One check per change group, once its events are all in.
    guidedTimer = setTimeout(afterLearnerChange, 0);
  };
  ws.addChangeListener(onWorkspaceChange);

  /** Keep an offered step in the current mode without replacing the proposal or losing its progress. */
  function rebuildRemaining(p) {
    const prefix = p.steps.slice(0, p.next);
    let remaining;
    try {
      const pending = p.steps.slice(p.next);
      remaining = p.guided ? mergeParts(pending) : splitSteps(ws, pending).map((step) => ({...step,
        split: {...step.split, from: pending[step.split.from].split.from}}));
      const check = validatePlan(ws, remaining, {allowedTypes: allowedTypes(), newStack: p.newStack});
      check.result?.dispose();
      if (!check.ok) return false;
    } catch (error) {
      return false;
    }
    p.steps = [...prefix, ...remaining];
    p.words = [...p.words.slice(0, p.next), ...opsInWords(ws, remaining, {stackLetters: stackLetters()})];
    p.undone = new Set([...p.undone].filter((index) => index < p.next));
    p.workspaceVersion = workspaceVersion(ws);
    if (p.guided) p.wholeSteps = p.steps;
    else p.splitSteps = p.steps;
    return true;
  }

  function refreshEditMode(p) {
    const guided = getPolicy(ws).editMode === EditMode.GUIDED;
    if (p.guided === guided) return null;
    clearTimeout(guidedTimer);
    guidedTimer = null;
    endGuidedStep(p);
    p.guided = guided;
    if (p.refit) return SAY.noFit;
    if (!rebuildRemaining(p)) {
      p.refit = true;
      return SAY.noFit;
    }
    return p.presented ? present(p) : main.lastSay;
  }

  const stopPolicyChanges = onPolicyChange(ws, (policy, previous) => {
    if (policy.editMode === previous.editMode) return;
    const p = offered();
    if (!p) return;
    const say = refreshEditMode(p);
    if (say !== null) options.onReply?.(reply(question ? undoWords(receipts[receipts.length - 1]) : say,
      question || p.refit ? 'question' : 'offer', main));
  });

  /** After a short task, a reminder of what is still offered. */
  function withReminder(say) {
    const p = offered();
    if (!p || !say) return say;
    if (!p.presented) return `${say} The fix is still waiting. Say yes to hear it, or cancel.`;
    if (guiding()) return `${say} Step ${p.next + 1} is still yours to do. Say how for help, or cancel.`;
    const what = p.steps.length === 1 ? 'The change is' : `Step ${p.next + 1} is`;
    return `${say} ${what} still waiting. Say yes to do it, or cancel.`;
  }

  function offer(task, {splitSteps, wholeSteps, kind, cursor}) {
    task.proposal = {
      proposalId: newId('p'), revision: task.revision, kind, next: 0, presented: kind === 'plan', refit: false,
      wholeSteps, splitSteps, workspaceVersion: workspaceVersion(ws),
      newStack: newStackSpot(cursor), undone: new Set(), doneByYou: new Set(),
      guided: getPolicy(ws).editMode === EditMode.GUIDED, guidedStep: null, deferred: false,
    };
    lastPlan = task.proposal;
    task.state = 'awaiting';
    return task.proposal;
  }

  function withdraw(task) {
    if (task?.proposal && task.state === 'awaiting') emit('proposal.withdrawn', task, {proposalId: task.proposal.proposalId});
    finish(task, 'cancelled');
  }

  function common(task, words, cursor) {
    return {client, cursor: cursor.block, onWorkspace: !cursor.block && !!cursor.at, learnerSays: words,
      stackLetters: stackLetters(), signal: task.abort.signal, taskId: task.taskId, revision: task.revision};
  }

  /** Where a new stack goes: the cursor's spot on empty workspace, else below the cursor's stack. */
  const newStackSpot = (cursor) => (cursor.block ? {near: cursor.block} : cursor.at ? {at: cursor.at} : null);

  /** "the print block, block 1 of stack C" */
  function cursorWords(id) {
    const block = ws.getBlockById(id);
    const place = blockPositions(ws, stackLetters()).get(id);
    if (!block || !place) return '';
    return `the ${blockName(block)} block, ${place.replace(/^stack (\w+), block (\d+)$/, 'block $2 of stack $1')}`;
  }

  /** "I found a problem in the print block, block 3 of stack A. It stops the program from running." */
  function issueWords(issue) {
    const places = (Array.isArray(issue.blocks) ? issue.blocks : []).map(cursorWords).filter(Boolean).slice(0, 2);
    const effect = ISSUE_EFFECT[OLD_SEVERITY[issue.severity] || issue.severity];
    return `I found a problem in ${places.length ? places.join(', and ') : 'your program'}.${effect ? ` ${effect}` : ''}`;
  }

  /** Runs an explanation or search; if the program changed meanwhile, says so and runs it once more. */
  async function fresh(task, run) {
    let result = await run();
    if (stale(task) || result.workspaceVersion === workspaceVersion(ws)) return result;
    options.onProgress?.(SAY.checking, task.taskId);
    result = await run();
    if (!stale(task) && result.workspaceVersion !== workspaceVersion(ws)) return {...result, stillChanging: true};
    return result;
  }

  /** Progress lines while this message's reply isn't ready; stops when it is (or a newer message took over). */
  function progressUntilDone(task) {
    let interval = null;
    const say = (text) => {
      if (task && task === current && !stale(task)) options.onProgress?.(text, task.taskId);
    };
    const first = setTimeout(() => {
      say(SAY.working);
      interval = setInterval(() => say(SAY.stillWorking), STILL_WORKING_MS);
    }, WORKING_AFTER_MS);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }

  // ---- Applying and undoing ------------------------------------------------

  function applyNext(task, count) {
    question = null;
    const p = task.proposal;
    // The live policy is authoritative even if an approval reaches us before the policy listener.
    if (getPolicy(ws).editMode === EditMode.GUIDED) {
      refreshEditMode(p);
      return reply(SAY.guidedYes, 'offer', task);
    }
    const from = p.next;
    task.state = 'applying';
    const before = workspaceVersion(ws);
    const cursorBefore = cursorNow();
    const result = asAgent(task, () => {
      const staged = [];
      const kinds = new Map([...captureBlocks(ws)].map(([id, block]) => [id, block.kind]));
      let beforeStep;
      const applied = applyPlan(ws, p.steps, {from, count, allowedTypes: allowedTypes(), newStack: p.newStack,
        onStep: ({index, phase}) => {
          if (phase === 'before') {
            beforeStep = captureBlocks(ws);
            for (const [id, block] of beforeStep) block.kind = kinds.get(id) || block.kind;
            return;
          }
          const changes = blockChanges(beforeStep, captureBlocks(ws));
          staged.push(...changes.map((change) => ({...change, step: index})));
          for (const change of changes) {
            if (change.action === 'delete') kinds.delete(change.id);
            else if (!kinds.has(change.id) || kinds.get(change.id) === 'learner') {
              kinds.set(change.id, change.action === 'create' ? 'created' : 'assisted');
            }
          }
        }});
      if (applied.ok) recordChanges(ws, staged, {type: task.action === 'DEBUG' ? 'debug' : 'edit', task: task.taskId});
      return applied;
    });
    if (!result.ok) {
      finish(task, 'failed');
      return reply(SAY.applyFailed, 'error', task);
    }
    const words = p.words.slice(from, from + result.applied);
    receipts.push({receiptId: newId('r'), task, proposal: p, proposalId: p.proposalId, from, count: result.applied, total: p.steps.length,
      words, before, after: workspaceVersion(ws), cursorBefore});
    // The cursor follows the change; the learner hears where it is.
    const at = result.focus && options.moveCursor ? cursorWords(result.focus) : '';
    if (at) options.moveCursor(result.focus, {focus: false});
    const cursorLine = at ? ` Your cursor is on ${at}.` : '';
    task.applied.push(...words);
    p.next += result.applied;
    p.workspaceVersion = workspaceVersion(ws);
    emit('step.applied', task, {proposalId: p.proposalId, from, count: result.applied, of: p.steps.length});
    const total = p.steps.length;
    const did = `Done.${cursorLine}`;
    if (p.next < total) {
      task.state = 'awaiting';
      return reply(`${did} ${present(p)}`, 'offer', task);
    }
    finish(task, 'done');
    return reply(`${did} That was the last step. Say undo to take ${total === 1 ? 'it' : 'a step'} back.`, 'outcome', task);
  }

  function undoWords(last) {
    return last.total === 1 ? SAY.undoChange(last.words.join('; ')) :
      last.count === 1 ? SAY.undoStep(last) : SAY.undoSteps(last);
  }

  function askUndo() {
    const last = receipts[receipts.length - 1];
    question = {kind: 'undo', receiptId: last.receiptId};
    emit('undo.asked', last.task, {proposalId: last.proposalId, from: last.from, count: last.count});
    return reply(undoWords(last), 'question', last.task);
  }

  function keepUndo() {
    const last = receipts.find((r) => r.receiptId === question.receiptId);
    question = null;
    if (last) emit('undo.kept', last.task, {proposalId: last.proposalId, from: last.from, count: last.count});
    const p = offered();
    return reply(p ? `${SAY.kept} ${present(p)}` : SAY.kept, p ? 'offer' : 'outcome', main);
  }

  function undoStep() {
    const receiptId = question?.receiptId;
    question = null;
    const last = receipts[receipts.length - 1];
    if (!last || last.receiptId !== receiptId || workspaceVersion(ws) !== last.after) return reply(SAY.noUndo, 'error');
    asAgent(last.task, () => ws.undo(false));
    if (workspaceVersion(ws) !== last.before) {
      asAgent(last.task, () => ws.undo(true));
      return reply(SAY.noUndo, 'error');
    }
    receipts.pop();
    for (let i = last.from; i < last.from + last.count; i++) last.proposal.undone.add(i);
    last.task.applied.splice(-last.count, last.count);
    emit('step.undone', last.task, {proposalId: last.proposalId, from: last.from, count: last.count});
    const back = last.cursorBefore && options.moveCursor &&
      (last.cursorBefore.block ? ws.getBlockById(last.cursorBefore.block) : last.cursorBefore.at);
    if (back) options.moveCursor(last.cursorBefore, {focus: false});
    const what = (last.total === 1 ? 'Took back the change.' : last.count === 1 ? `Took back step ${last.from + 1}.` :
      `Took back steps ${last.from + 1} to ${last.from + last.count}.`) + (back ? ' Your cursor is back where it was.' : '');
    const more = receipts.length ? ' Say undo again to take back the step before.' : '';
    // Mid-plan, the step taken back is offered again; a stopped or finished task stays ended.
    const p = offered();
    if (p && p.proposalId === last.proposalId) {
      p.next = last.from;
      p.workspaceVersion = workspaceVersion(ws);
      if (p.guided && !rebuildRemaining(p)) {
        p.refit = true;
        return reply(`${what} ${SAY.noFit}`, 'question', main);
      }
      return reply(`${what}${more} ${present(p)}`, 'offer', main);
    }
    return reply(`${what}${more}`, 'outcome', last.task);
  }

  /** Yes or all: applies what was offered last, only on the program it was offered for. */
  async function consent(command) {
    const task = main;
    const p = task.proposal;
    if (p.refit) return revise(task);
    if (!p.presented) {
      p.presented = true;
      return reply(present(p), 'offer', task);
    }
    if (workspaceVersion(ws) !== p.workspaceVersion) {
      const check = validatePlan(ws, p.steps.slice(p.next), {allowedTypes: allowedTypes(), newStack: p.newStack});
      check.result?.dispose();
      if (!check.ok) {
        p.refit = true;
        return reply(SAY.noFit, 'question', task);
      }
      // The learner agreed to the old program, so a fresh yes is needed.
      stepWords(p);
      p.workspaceVersion = workspaceVersion(ws);
      p.deferred = false;
      return reply(SAY.stillFits, 'offer', task);
    }
    if (command === 'all' && !getPolicy(ws).wholePlan) return reply(`${SAY.allOff} ${present(p)}`, 'offer', task);
    return applyNext(task, command === 'all' ? Infinity : 1);
  }

  /** A correction ("no, the inner loop"): the same debug or edit task, one revision on, with the task so far. */
  async function reviseWith(task, words, {cursor, messageId}) {
    question = null;
    if (task.state === 'awaiting' && task.proposal) emit('proposal.withdrawn', task, {proposalId: task.proposal.proposalId});
    task.revision += 1;
    task.request.corrections.push(words);
    rememberMessage(messageId, task, {part: 'corrections', index: task.request.corrections.length - 1});
    task.state = 'working';
    task.question = null;
    task.abort = new AbortController();
    endGuidedStep(task.proposal);
    task.proposal = null;
    emit('task.revised', task);
    current = task;
    return runPlan(task, task.action, words, cursor);
  }

  /** A question about the offered change: answered from the task so far; the offer stays. */
  async function askAboutOffer(task, words, cursor) {
    task.action = 'COMPREHEND';
    const context = taskContext(main);
    const r = await cached(['COMPREHEND_PROPOSAL', words, context],
        () => runComprehend(ws, {...common(task, words, cursor), scope: 'proposal', taskContext: context}));
    if (stale(task)) return dropped(task);
    finish(task, r.valid ? 'done' : 'failed');
    if (r.blocked) return reply(r.blocked.say, 'answer', task);
    return r.valid ? reply(withReminder(r.output.voiceLine), 'answer', task) : reply(failedSay(r), 'error', task);
  }

  /** The plan no longer fits and the learner wants a new one: the same request again, one revision on. */
  async function revise(task) {
    question = null;
    task.revision += 1;
    task.state = 'working';
    task.abort = new AbortController();
    endGuidedStep(task.proposal);
    task.proposal = null;
    emit('task.revised', task);
    current = task;
    return runAction(task, task.action, requestWords(task), cursorNow());
  }

  // ---- Routing a message ---------------------------------------------------

  const cursorNow = () => ({block: null, field: null, at: null, ...options.cursor()});
  // A request and its answers go to the model joined; debug and edit also get them in the task so far.
  const requestWords = (task) => [task.request.words, ...task.request.clarifications.map((c) => c.answer)].join(' ');
  /** A revision or an answer to a question asked back sends the task so far; a new request sends what was evaluated. */
  const planContext = (task) => (task.revision > 1 || task.request.clarifications.length ? taskContext(task) : '');

  function rememberMessage(messageId, task, {part = 'words', index = null} = {}) {
    for (const [id, entry] of messageRequests) if (![main, current].includes(entry.task)) messageRequests.delete(id);
    if (!messageId) return;
    messageRequests.set(messageId, {task, part, index});
  }

  /**
   * Changes request words for future context, without touching work already started or offered.
   * @param {string} messageId
   * @param {string} text
   * @returns {boolean} Whether the message still belongs to a held task.
   */
  function reviseWords(messageId, text) {
    const entry = messageRequests.get(messageId);
    if (!entry || ![main, current].includes(entry.task) || typeof text !== 'string' || !text.trim()) return false;
    const request = entry.task.request;
    if (entry.part === 'words') request.words = text;
    else if (entry.part === 'clarifications') request.clarifications[entry.index].answer = text;
    else request.corrections[entry.index] = text;
    return true;
  }

  async function route(text, messageId) {
    const cursor = cursorNow();
    const choices = answers();
    const pendingQuestion = question;
    question = null;
    // The task a message may relate to: the one with an offer, else the latest.
    const related = offered() ? main : current;
    found = null;
    const waiting = asking();
    if (waiting) {
      waiting.request.clarifications.push({asked: waiting.question, answer: text});
      rememberMessage(messageId, waiting, {part: 'clarifications', index: waiting.request.clarifications.length - 1});
      waiting.question = null;
      waiting.state = 'working';
      waiting.abort = new AbortController();
      current = waiting;
      emit('message.routed', waiting, {as: 'answer'});
      const words = requestWords(waiting);
      return waiting.action ? runAction(waiting, waiting.action, words, cursor) : routeIntent(waiting, words, cursor);
    }
    current = newTask(text);
    current.messageId = messageId;
    rememberMessage(messageId, current);
    return routeIntent(current, text, cursor, {answers: choices, related, pendingQuestion});
  }

  async function routeIntent(task, words, cursor, {answers: choices = [], related = null, pendingQuestion = null} = {}) {
    const context = taskContext(related);
    const intent = await cached(['INTENT', cursor.block, words, choices, context],
        () => runIntent(ws, {...common(task, words, cursor), answers: choices, taskContext: context,
          taskAction: related?.action ?? null}));
    if (stale(task)) return dropped(task);
    emit('message.routed', task, {as: 'intent', intent: intent.output?.intent ?? null, relation: intent.output?.relation ?? null});
    if (intent.blocked) {
      finish(task, 'failed');
      return reply(intent.blocked.say, 'answer', task);
    }
    if (!intent.valid) {
      finish(task, 'failed');
      return reply(failedSay(intent), 'error', task);
    }
    if (intent.output.intent === 'ANSWER') {
      messageRequests.delete(task.messageId);
      // A loose or misheard answer ("yes louit"): the same as saying it, if it can still be given.
      finish(task, 'done');
      const command = intent.output.answer;
      question = pendingQuestion;
      if (!command) return reply(SAY.unclearAnswer, 'question', main);
      emit('message.routed', task, {as: 'command', command, byModel: true});
      if (!available().includes(command)) return reply(SAY.unclearAnswer, 'question', main);
      // An inferred answer has the same current task as a directly matched answer.
      current = related || current;
      return act(command);
    }
    if (intent.output.relation === 'revise' && related && PLAN_ACTIONS.includes(related.action)) {
      finish(task, 'done');
      return reviseWith(related, words, {cursor, messageId: task.messageId});
    }
    if (intent.output.relation === 'ask' && intent.output.intent === 'COMPREHEND' && offered()) {
      return askAboutOffer(task, words, cursor);
    }
    if (intent.output.intent === 'OFF_TOPIC') {
      finish(task, 'done');
      return reply(withReminder(OFF_TOPIC_REPLY), 'answer', task);
    }
    if (intent.output.intent === 'CLARIFICATION') {
      task.state = 'awaiting';
      task.question = intent.reply;
      return reply(intent.reply, 'question', task);
    }
    return runAction(task, intent.action, words, cursor);
  }

  async function runAction(task, action, words, cursor) {
    if (quiz() && !QUIZ_ACTIONS.includes(action)) {
      finish(task, 'done');
      return reply(withReminder(SAY.quiz), 'answer', task);
    }
    task.action = action;
    emit('task.stage', task, {stage: 'action'});
    if (PLAN_ACTIONS.includes(action)) return runPlan(task, action, words, cursor);
    switch (action) {
      case 'COMPREHEND': {
        let scope = scopeFor(ws, cursor, words);
        if (quiz() && !['field', 'block'].includes(scope)) {
          if (!cursor.block) {
            finish(task, 'done');
            return reply(withReminder(SAY.quizScope), 'answer', task);
          }
          scope = cursor.field ? 'field' : 'block';
        }
        const r = await fresh(task, () => cached(['COMPREHEND', scope, cursor.block, cursor.field, words],
            () => runComprehend(ws, {...common(task, words, cursor), field: cursor.field, scope})));
        if (stale(task)) return dropped(task);
        finish(task, r.valid ? 'done' : 'failed');
        if (r.blocked) return reply(r.blocked.say, 'answer', task);
        if (r.stillChanging) return reply(SAY.stillChanging, 'answer', task);
        return r.valid ? reply(withReminder(r.output.voiceLine), 'answer', task) : reply(failedSay(r), 'error', task);
      }
      case 'SEARCH': {
        const r = await fresh(task, () => cached(['SEARCH', words], () => runSearch(ws, common(task, words, cursor))));
        if (stale(task)) return dropped(task);
        finish(task, r.valid ? 'done' : 'failed');
        if (r.blocked) return reply(r.blocked.say, 'answer', task);
        if (r.stillChanging) return reply(SAY.stillChanging, 'answer', task);
        if (!r.valid) return reply(failedSay(r), 'error', task);
        found = r.output.blockIds[0] || null;
        const say = found && options.moveCursor ? `${r.output.voiceLine} Say go there to move to it.` : r.output.voiceLine;
        return reply(withReminder(say), 'answer', task);
      }
      case 'HINT': {
        finish(task, 'done');
        const question = questionAt(cursor.block && ws.getBlockById(cursor.block));
        if (!question) return reply(withReminder(SAY.hintWhere), 'answer', task);
        options.openQuestion?.(question.id);
        return reply(withReminder(SAY.hintOpen), 'answer', task);
      }
    }
    finish(task, 'failed');
    return reply(SAY.failed, 'error', task);
  }

  async function runPlan(task, action, words, cursor) {
    // A new fix or plan replaces an offered one; a short question in between doesn't.
    if (main && main !== task) withdraw(main);
    main = task;
    const context = planContext(task);
    const r = await cached([action, cursor.block, !cursor.block && !!cursor.at, words, context],
        () => runPlanAction(action, ws, {...common(task, words, cursor), allowedTypes: allowedTypes(), taskContext: context}));
    if (stale(task)) return dropped(task);
    if (r.blocked) {
      finish(task, 'failed');
      return reply(r.blocked.say, 'answer', task);
    }
    const wholeSteps = withLineage(PLAN_HANDLERS[action].steps(r.output));
    const split = r.split === 'failed' ? withLineage(r.steps) : structuredClone(r.steps);
    // A wrong place is all that's wrong: a debug issue is explained in code instead, the fix still on request.
    const explained = action === 'DEBUG' && !r.valid && r.onlyPlaces && r.output?.issue ? issueWords(r.output.issue) : '';
    const valid = r.valid || !!explained;
    const say = explained || r.output?.voiceLine;
    if (typeof say !== 'string' || !say.trim()) {
      finish(task, 'failed');
      return reply(failedSay(r), 'error', task);
    }
    // The checks dropped the change; its line would offer something that isn't there.
    if (!valid && !wholeSteps.length) {
      finish(task, 'failed');
      return reply(SAY.noChange, 'error', task);
    }
    if (wholeSteps.length) {
      const p = offer(task, {splitSteps: split, wholeSteps, kind: action === 'DEBUG' ? 'fix' : 'plan', cursor});
      p.steps = p.guided ? p.wholeSteps : p.splitSteps;
      p.words = opsInWords(ws, p.steps, {stackLetters: stackLetters()});
      emit('proposal.offered', task, {proposalId: p.proposalId, proposalKind: p.kind, steps: p.steps.length,
        words: p.words, split: r.split});
      // An edit plan whose line names a wrong place: the line isn't spoken, the step is.
      if (!valid) p.presented = true;
      const summary = valid ? summaryOf(say) : '';
      const line = summary ? `${summary} ` : '';
      let lead = '';
      if (r.workspaceVersion !== workspaceVersion(ws)) {
        const check = validatePlan(ws, p.steps, {allowedTypes: allowedTypes()});
        check.result?.dispose();
        if (!check.ok) {
          p.refit = true;
          return reply(SAY.changedNoFit, 'question', task);
        }
        lead = `${SAY.changedFits} `;
      }
      return reply(`${lead}${p.presented ? `${line}${present(p)}` : `${line}${SAY.fixQuestion}`}`, 'offer', task);
    }
    // No steps and a question: the next reply answers it and goes straight back to the action.
    if (action === 'EDIT_GUIDE' && say.trim().endsWith('?')) {
      task.state = 'awaiting';
      task.question = say;
      return reply(say, 'question', task);
    }
    finish(task, 'done');
    return reply(say, 'answer', task);
  }

  // ---- Commands --------------------------------------------------------------

  /** @returns {!Promise<!Reply>} */
  /** Commands that act now; in Guided mode yes and all also answer, with what to do instead. */
  const accepts = (command) => available().includes(command) || (!!guiding() && (command === 'yes' || command === 'all'));

  async function act(command) {
    if (question && command === 'yes') return undoStep();
    if (question && (command === 'no' || command === 'cancel')) return keepUndo();
    const g = guiding();
    if (g && (command === 'yes' || command === 'all')) return reply(SAY.guidedYes, 'offer', main);
    if (g && ['how', 'check', 'keys'].includes(command)) emit('guided.help', main, {help: command});
    switch (command) {
      case 'how':
        return reply(guidedHow(g), 'answer', main);
      case 'check':
        return guidedCheck(g);
      case 'keys':
        return reply(SAY.keys, 'answer', main);
      case 'repeat':
        if (question) return reply(undoWords(receipts.find((r) => r.receiptId === question.receiptId)), 'question');
        if (offered()?.deferred) {
          const p = offered();
          p.deferred = false;
          return p.presented ? consentCheck(p) : reply(SAY.fixQuestion, 'offer', main);
        }
        return reply(lastSay);
      case 'go':
        emit('search.went', current, {blockId: found});
        options.moveCursor?.(found);
        return reply('');
      case 'no': {
        const busy = working();
        if (busy) {
          cancelTask(busy);
          return reply(SAY.stopped, 'outcome', busy);
        }
        const p = offered();
        p.deferred = true;
        return reply(!p.presented ? SAY.noFix : p.guided ? SAY.noGuided : SAY.noStep, 'offer', main);
      }
      case 'cancel': {
        question = null;
        const busy = working();
        if (busy) {
          cancelTask(busy);
          return reply(SAY.stopped, 'outcome', busy);
        }
        const withProposal = !!offered();
        const asked = asking();
        if (asked) finish(asked, 'cancelled');
        if (withProposal) {
          const guided = !!guiding();
          withdraw(main);
          if (guided) return reply(SAY.guidedStopped, 'outcome', main);
          return reply(`${SAY.withdrawn}${receipts.length ? ` ${SAY.undoHint}` : ''}`, 'outcome', main);
        }
        return reply(SAY.okay, 'outcome', asked);
      }
      case 'yes':
      case 'all':
        return consent(command);
      case 'continue': {
        const p = offered();
        if (p.refit) return reply(SAY.noFit, 'question', main);
        p.deferred = false;
        return p.presented ? consentCheck(p) : reply(SAY.fixQuestion, 'offer', main);
      }
      case 'undo':
        return askUndo();
    }
    return reply(SAY.failed, 'error');
  }

  /** Continue: the offered step again, after checking it still fits. */
  function consentCheck(p) {
    if (workspaceVersion(ws) !== p.workspaceVersion) {
      const check = validatePlan(ws, p.steps.slice(p.next), {allowedTypes: allowedTypes(), newStack: p.newStack});
      check.result?.dispose();
      if (!check.ok) {
        p.refit = true;
        return reply(SAY.noFit, 'question', main);
      }
      stepWords(p);
      p.workspaceVersion = workspaceVersion(ws);
    }
    return reply(present(p), 'offer', main);
  }

  return {
    /**
     * A submitted message. A control word that is available now acts in code; a message while a task works stops
     * it and is routed instead (the latest message wins).
     * @param {string} text
     * @param {{messageId?: ?string}=} options Host id for later re-transcription.
     * @returns {!Promise<!Reply>}
     */
    async ask(text, {messageId = null} = {}) {
      const command = matchCommand(text);
      if (command && accepts(command)) {
        emit('message.routed', current, {as: 'command', command});
        return act(command);
      }
      const busy = working();
      if (busy) cancelTask(busy);
      const routed = route(String(text), command ? null : messageId);
      const stopProgress = progressUntilDone(current);
      try {
        return await routed;
      } catch (e) {
        console.warn('[coordinator]', e);
        if (current) finish(current, 'failed');
        return reply(SAY.failed, 'error');
      } finally {
        stopProgress();
      }
    },
    reviseWords,
    /**
     * A button or key: yes, no, cancel, all, undo, repeat, go, continue.
     * @param {{proposalId?: string}=} options  proposalId: yes or all only for that proposal (the step list's)
     * @returns {!Promise<!Reply>}
     */
    async act(command, {proposalId} = {}) {
      if (proposalId && (command === 'yes' || command === 'all') && offered()?.proposalId !== proposalId) {
        return reply(SAY.planEnded, 'outcome');
      }
      return accepts(command) ? act(command) : reply('');
    },
    /** The step list: the presented plan or fix, or the one that just ended; null when there is none. */
    plan: planView,
    /** Esc while a task works. @returns {?Reply} what to say, or null when nothing was working */
    cancel() {
      const busy = working();
      if (!busy) return null;
      question = null;
      cancelTask(busy);
      return reply(SAY.stopped, 'outcome', busy);
    },
    /** Commands that act now (the keys say when one doesn't). */
    available,
    /** For the navigation lock: frozen while working, read-only while an answer is awaited, else free. */
    lock: lockNow,
    /** For the status line and the navigation lock. */
    state() {
      const p = offered();
      const task = current;
      return {
        task: task && {taskId: task.taskId, action: task.action, state: task.state, revision: task.revision},
        proposal: p && {proposalId: p.proposalId, kind: p.kind, step: p.next + 1, of: p.steps.length, presented: p.presented},
        receipts: receipts.length,
        lock: lockNow(),
        context: taskContext(main && main !== current && offered() ? main : task),
      };
    },
    /** Removes the workspace and policy listeners and ends a guided step. */
    dispose() {
      messageRequests.clear();
      question = null;
      ws.removeChangeListener(onWorkspaceChange);
      stopPolicyChanges();
      clearTimeout(guidedTimer);
      endGuidedStep(offered());
    },
    /** The program view a request would send now, for the Log payload setting. */
    view() {
      const cursor = cursorNow();
      return snapshot(ws, {cursor: cursor.block, field: cursor.field, onWorkspace: !cursor.block && !!cursor.at,
        stackLetters: stackLetters()}).text;
    },
  };
}
