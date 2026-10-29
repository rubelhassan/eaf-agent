// @ts-check
// The conversation: each submitted message becomes a task that runs through the harness. The coordinator holds
// what it offers, and applies, undoes or withdraws it only on the learner's word. Headless; the app passes the
// cursor and what to do on screen.

import * as Blockly from 'blockly/core';
import {OFF_TOPIC_REPLY, runIntent} from '../agent/harness/intent.js';
import {runComprehend} from '../agent/harness/comprehend.js';
import {runPlanAction} from '../agent/harness/run.js';
import {runSearch} from '../agent/harness/search.js';
import {applyPlan, validatePlan} from '../agent/editor/plan.js';
import {blockPositions, snapshot} from '../agent/context/snapshot.js';
import {blockTypeName} from '../blocks/block_names.js';
import {opsInWords} from '../agent/context/ops_in_words.js';
import {workspaceVersion} from '../agent/context/version.js';
import {Activity, getPolicy} from '../blocks/policy.js';
import {QUESTION_TYPE} from '../blocks/question/model.js';
import {getBinding} from '../blocks/question/binding.js';
import {matchCommand} from './commands.js';
import {scopeFor} from './scope.js';
import {answersNow, taskContext} from './task_context.js';
import {AGENT_GROUP} from './events.js';

const SAY = {
  failed: "Sorry, I couldn't work that out. Please try again.",
  unclearAnswer: "I didn't understand your answer. Can you say it again?",
  unreachable: "Sorry, I can't connect right now. Please try again later.",
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
  stillChanging: "Your program is still changing. Ask me again when you're ready.",
};
const LABELS = {yes: 'Yes', all: 'Do all steps', stop: 'Stop', undo: 'Undo a step', go: 'Go there', repeat: 'Hear again'};
const QUIZ_ACTIONS = ['COMPREHEND', 'SEARCH', 'HINT'];
const PLAN_ACTIONS = ['DEBUG', 'EDIT_GUIDE'];
const OPEN = ['working', 'applying', 'awaiting'];

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
 * @param {{workspace: !Blockly.Workspace, client: !import('../agent/model/agent_client.js').AgentClient,
 *     cursor: function(): Cursor, stackLetters?: function(): ?Map<string, string>,
 *     moveCursor?: function((string|!Cursor), {focus?: boolean}=): void, openQuestion?: function(string): void,
 *     onEvent?: function(string, !Object): void, onProgress?: function(string, string): void}} options
 *     cursor: at is the spot when the cursor is on empty workspace
 *     moveCursor: to a block (or a cursor taken earlier); focus false leaves keyboard focus where it is
 *     onEvent: task events (kind, data); onProgress: a line to say while a task works (text, taskId)
 */
export function createCoordinator(options) {
  const {workspace: ws, client} = options;
  const stackLetters = () => options.stackLetters?.() || null;
  const onEvent = options.onEvent || (() => {});
  const cache = new Map();
  let counter = 0;
  /** The debug or edit task: it holds what is offered. */
  let main = null;
  /** The task of the latest message (a short task, a question asked back, or main). */
  let current = null;
  /** Applied steps across tasks, newest last. */
  const receipts = [];
  let found = null;
  let lastSay = '';

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
  const canAll = (p) => !!p && p.presented && getPolicy(ws).wholePlan && p.steps.length - p.next > 1;

  function newTask(words) {
    const task = {taskId: newId('t'), action: null, revision: 1, state: 'working', abort: new AbortController(),
      request: {words, clarifications: [], corrections: []}, proposal: null, applied: [], question: null, lastSay: ''};
    emit('task.started', task);
    return task;
  }

  function finish(task, state) {
    if (!task || !OPEN.includes(task.state)) return;
    task.state = state;
    task.question = null;
    emit(`task.${state}`, task);
  }

  function cancelTask(task) {
    task.abort.abort();
    finish(task, 'cancelled');
  }

  function available() {
    const names = [];
    const p = offered();
    if (p) names.push('yes', 'continue');
    if (canAll(p)) names.push('all');
    if (working() || p || asking()) names.push('stop');
    if (receipts.length) names.push('undo');
    if (found) names.push('go');
    if (lastSay) names.push('repeat');
    return names;
  }

  const answers = () => answersNow(available(),
      {proposal: offered(), lastApplied: receipts[receipts.length - 1]?.words, working: !!working()});

  /** @returns {!Reply} */
  function reply(say, kind = 'answer', task = current) {
    if (say) {
      lastSay = say;
      if (task) task.lastSay = say;
    }
    return {
      say,
      actions: available().filter((name) => LABELS[name]).map((name) => ({name, label: LABELS[name]})),
      expectsAnswer: !!offered() || !!asking(),
      taskId: task?.taskId ?? null,
      kind,
    };
  }

  /** A reply for a task that was stopped or replaced while it worked: nothing to say. */
  const dropped = (task) => reply('', 'answer', task);
  const stale = (task) => task.abort.signal.aborted;

  /** Same question, same program, same answer; only valid results are kept. */
  // A call that never got an answer (no connection, timeout, model error) isn't the learner's fault.
  const failedSay = (r) => (r.error ? SAY.unreachable : SAY.failed);

  async function cached(key, run) {
    const k = JSON.stringify([...key, workspaceVersion(ws)]);
    if (cache.has(k)) return cache.get(k);
    const result = await run();
    if (result.valid) cache.set(k, result);
    return result;
  }

  function present(p) {
    // Spoken from the ops on the program as it is now, never from the model's title (kept in the data only).
    p.words[p.next] = opsInWords(ws, [p.steps[p.next]], {stackLetters: stackLetters()})[0];
    const step = p.words[p.next];
    const head = p.steps.length === 1 ? `The change: ${step}.` : `Step ${p.next + 1} of ${p.steps.length}: ${step}.`;
    return `${head} Say yes to do it${canAll(p) ? ', all to do every step' : ''}, or stop.`;
  }

  /** After a short task, a reminder of what is still offered. */
  function withReminder(say) {
    const p = offered();
    if (!p || !say) return say;
    if (!p.presented) return `${say} The fix is still waiting. Say yes to hear it, or stop.`;
    const what = p.steps.length === 1 ? 'The change is' : `Step ${p.next + 1} is`;
    return `${say} ${what} still waiting. Say yes to do it, or stop.`;
  }

  function offer(task, steps, kind, cursor) {
    task.proposal = {
      proposalId: newId('p'), revision: task.revision, kind, steps, next: 0, presented: kind === 'plan', refit: false,
      words: opsInWords(ws, steps, {stackLetters: stackLetters()}), workspaceVersion: workspaceVersion(ws),
      newStack: newStackSpot(cursor),
    };
    task.state = 'awaiting';
    emit('proposal.offered', task, {proposalId: task.proposal.proposalId, proposalKind: kind, steps: steps.length,
      words: task.proposal.words});
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
    return `the ${blockTypeName(block.type)} block, ${place.replace(/^stack (\w+), block (\d+)$/, 'block $2 of stack $1')}`;
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

  // ---- Applying and undoing ------------------------------------------------

  function applyNext(task, count) {
    const p = task.proposal;
    const from = p.next;
    task.state = 'applying';
    const before = workspaceVersion(ws);
    const cursorBefore = cursorNow();
    const result = asAgent(task, () => applyPlan(ws, p.steps, {from, count, allowedTypes: allowedTypes(), newStack: p.newStack}));
    if (!result.ok) {
      finish(task, 'failed');
      return reply(SAY.applyFailed, 'error', task);
    }
    const words = p.words.slice(from, from + result.applied);
    receipts.push({receiptId: newId('r'), task, proposalId: p.proposalId, from, count: result.applied, total: p.steps.length,
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
    const did = (total === 1 ? 'Done.' : result.applied === 1 ? `Did step ${from + 1}.` : `Did steps ${from + 1} to ${p.next}.`) +
      cursorLine;
    if (p.next < total) {
      task.state = 'awaiting';
      return reply(`${did} ${present(p)}`, 'offer', task);
    }
    finish(task, 'done');
    return reply(`${did} That was the last step. Say undo to take ${total === 1 ? 'it' : 'a step'} back.`, 'outcome', task);
  }

  function undoStep() {
    const last = receipts[receipts.length - 1];
    if (workspaceVersion(ws) !== last.after) return reply(SAY.noUndo, 'error');
    asAgent(last.task, () => ws.undo(false));
    if (workspaceVersion(ws) !== last.before) {
      asAgent(last.task, () => ws.undo(true));
      return reply(SAY.noUndo, 'error');
    }
    receipts.pop();
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
      p.workspaceVersion = workspaceVersion(ws);
      return reply(SAY.stillFits, 'offer', task);
    }
    if (command === 'all' && !getPolicy(ws).wholePlan) return reply(`${SAY.allOff} ${present(p)}`, 'offer', task);
    return applyNext(task, command === 'all' ? Infinity : 1);
  }

  /** A correction ("no, the inner loop"): the same debug or edit task, one revision on, with the task so far. */
  async function reviseWith(task, words, cursor) {
    if (task.state === 'awaiting' && task.proposal) emit('proposal.withdrawn', task, {proposalId: task.proposal.proposalId});
    task.revision += 1;
    task.request.corrections.push(words);
    task.state = 'working';
    task.question = null;
    task.abort = new AbortController();
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
    task.revision += 1;
    task.state = 'working';
    task.abort = new AbortController();
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

  async function route(text) {
    const cursor = cursorNow();
    const choices = answers();
    // The task a message may relate to: the one with an offer, else the latest.
    const related = offered() ? main : current;
    found = null;
    const waiting = asking();
    if (waiting) {
      waiting.request.clarifications.push({asked: waiting.question, answer: text});
      waiting.question = null;
      waiting.state = 'working';
      waiting.abort = new AbortController();
      current = waiting;
      emit('message.routed', waiting, {as: 'answer'});
      const words = requestWords(waiting);
      return waiting.action ? runAction(waiting, waiting.action, words, cursor) : routeIntent(waiting, words, cursor);
    }
    current = newTask(text);
    return routeIntent(current, text, cursor, {answers: choices, related});
  }

  async function routeIntent(task, words, cursor, {answers: choices = [], related = null} = {}) {
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
      // A loose or misheard answer ("yes louit"): the same as saying it, if it can still be given.
      finish(task, 'done');
      const command = intent.output.answer;
      if (!command) return reply(SAY.unclearAnswer, 'question', main);
      emit('message.routed', task, {as: 'command', command, byModel: true});
      return available().includes(command) ? act(command) : reply(SAY.unclearAnswer, 'question', main);
    }
    if (intent.output.relation === 'revise' && related && PLAN_ACTIONS.includes(related.action)) {
      finish(task, 'done');
      return reviseWith(related, words, cursor);
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
    const say = r.output?.voiceLine;
    if (typeof say !== 'string' || !say.trim()) {
      finish(task, 'failed');
      return reply(failedSay(r), 'error', task);
    }
    const steps = action === 'DEBUG' ? (r.output.fix?.ops?.length ? [r.output.fix] : []) : (r.output.steps || []);
    // The checks dropped the change; its line would offer something that isn't there.
    if (!r.valid && !steps.length) {
      finish(task, 'failed');
      return reply(SAY.noChange, 'error', task);
    }
    if (steps.length) {
      const p = offer(task, steps, action === 'DEBUG' ? 'fix' : 'plan', cursor);
      // Only a wrong place in the line keeps an invalid plan; the line isn't spoken, the step is.
      if (!r.valid) p.presented = true;
      const line = r.valid ? `${say} ` : '';
      let lead = '';
      if (r.workspaceVersion !== workspaceVersion(ws)) {
        const check = validatePlan(ws, steps, {allowedTypes: allowedTypes()});
        check.result?.dispose();
        if (!check.ok) {
          p.refit = true;
          return reply(SAY.changedNoFit, 'question', task);
        }
        lead = `${SAY.changedFits} `;
      }
      return reply(`${lead}${p.presented ? `${line}${present(p)}` : say}`, 'offer', task);
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
  async function act(command) {
    switch (command) {
      case 'repeat':
        return reply(lastSay);
      case 'go':
        emit('search.went', current, {blockId: found});
        options.moveCursor?.(found);
        return reply('');
      case 'stop': {
        const busy = working();
        if (busy) {
          cancelTask(busy);
          return reply(SAY.stopped, 'outcome', busy);
        }
        const withProposal = !!offered();
        const question = asking();
        if (question) finish(question, 'cancelled');
        if (withProposal) {
          withdraw(main);
          return reply(`${SAY.withdrawn}${receipts.length ? ` ${SAY.undoHint}` : ''}`, 'outcome', main);
        }
        return reply('Okay.', 'outcome', question);
      }
      case 'yes':
      case 'all':
        return consent(command);
      case 'continue': {
        const p = offered();
        if (p.refit) return reply(SAY.noFit, 'question', main);
        return p.presented ? consentCheck(p) : reply('The fix is still waiting. Say yes to hear it, or stop.', 'offer', main);
      }
      case 'undo':
        return undoStep();
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
      p.workspaceVersion = workspaceVersion(ws);
    }
    return reply(present(p), 'offer', main);
  }

  return {
    /**
     * A submitted message. A control word that is available now acts in code; a message while a task works stops
     * it and is routed instead (the latest message wins).
     * @returns {!Promise<!Reply>}
     */
    async ask(text) {
      const command = matchCommand(text);
      if (command && available().includes(command)) {
        emit('message.routed', current, {as: 'command', command});
        return act(command);
      }
      const busy = working();
      if (busy) cancelTask(busy);
      try {
        return await route(String(text));
      } catch (e) {
        console.warn('[coordinator]', e);
        if (current) finish(current, 'failed');
        return reply(SAY.failed, 'error');
      }
    },
    /** A button or key: yes, all, stop, undo, repeat, go, continue. @returns {!Promise<!Reply>} */
    async act(command) {
      return available().includes(command) ? act(command) : reply('');
    },
    /** Esc while a task works. @returns {?Reply} what to say, or null when nothing was working */
    cancel() {
      const busy = working();
      if (!busy) return null;
      cancelTask(busy);
      return reply(SAY.stopped, 'outcome', busy);
    },
    /** Commands that act now (the keys say when one doesn't). */
    available,
    /** For the navigation lock: frozen while working, read-only while an answer is awaited, else free. */
    lock: () => (working() ? 'frozen' : offered() || asking() ? 'read-only' : 'free'),
    /** For the status line and the navigation lock. */
    state() {
      const p = offered();
      const task = current;
      return {
        task: task && {taskId: task.taskId, action: task.action, state: task.state, revision: task.revision},
        proposal: p && {proposalId: p.proposalId, kind: p.kind, step: p.next + 1, of: p.steps.length, presented: p.presented},
        receipts: receipts.length,
        lock: working() ? 'frozen' : p || asking() ? 'read-only' : 'free',
        context: taskContext(main && main !== current && offered() ? main : task),
      };
    },
    /** The program view a request would send now, for the Log payload setting. */
    view() {
      const cursor = cursorNow();
      return snapshot(ws, {cursor: cursor.block, field: cursor.field, onWorkspace: !cursor.block && !!cursor.at,
        stackLetters: stackLetters()}).text;
    },
  };
}
