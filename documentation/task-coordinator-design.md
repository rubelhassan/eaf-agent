# Task coordinator design

Status: **agreed 2026-10-28, built** as `specs/task-coordinator.md`. Tables headed "Today" or "now" describe the code before that build. The coordinator runs the conversation in the browser: it turns each submitted message into a task, runs it through the harness, holds what it offers, and applies, undoes or withdraws it. It replaces `src/interaction/assistant.js`. Behavior seen by the learner is in `voice-interaction-flow/voice-interaction-design.md` (sections 4, 7 to 11); what each model call gets is in `ai-system-design.md` (7.2).

## 1. Decisions *(decided 2026-10-28)*

- Lives in the browser, headless (no DOM), in `src/interaction/`; the server only logs its events.
- Split by job: `coordinator.js`, `task_context.js`, `commands.js`, `scope.js`, and `src/agent/context/ops_in_words.js`. `assistant.js` goes away.
- A side question while a step is offered is its own short task; the step stays offered and the reply reminds the learner of it.
- Stop, no, cancel and never mind all mean one thing: end the open task. "Stop talking" only silences the voice.
- A message submitted while a task is working aborts the running call, then is routed with the task context: latest message wins.

## 2. Modules

| File | Job |
|---|---|
| `src/interaction/coordinator.js` | Tasks, states, revisions, proposals, consent, receipts, undo, events. `createCoordinator()` keeps the `ask`, `act` and `view` API of `createAssistant`. |
| `src/interaction/task_context.js` | Builds the task context lines from a task (`ai-system-design.md` 7.2). |
| `src/interaction/commands.js` | Control words (more words, section 6). |
| `src/interaction/scope.js` | Scope from the cursor and words (unchanged). |
| `src/interaction/events.js` | Event sender: ids, sequence numbers, batches to the server, retry buffer. |
| `src/agent/context/ops_in_words.js` | Describes ops in plain words with structural places, for the task context and the proposal scope. |

## 3. Data

```
Session    sessionId, tasks (current and the last one ended), receipts (newest last), found, lastSay
Task       taskId, action, revision, state, stage,
           request: {words, clarifications: [{asked, answer}], corrections: [words]},
           proposal (or null), abort (for the running call), startedAt
Proposal   proposalId, revision, kind (fix | plan), steps, next, workspaceVersion
Receipt    receiptId, taskId, proposalId, from, count, before, after
```

- `workspaceVersion` is a hash of the serialized program, as the cache uses now.
- `before` and `after` are the serialized program around an applied step, as `applied` is today, so undo can check nothing else changed.
- A task is kept after it ends (done, cancelled, failed) until a new task starts or the session suspends, so its context can answer "why did you do that?".

## 4. Task states and stages

States are those of the voice design (4.2): working, awaiting answer, applying, done, cancelled, failed. Stages (voice design 9) are recorded on the task for events and progress: understand, clarify, generate, validate, present, confirm, apply, verify (later), report.

| Action | Path |
|---|---|
| Comprehend, search, hint | working, then done (hint opens the question's help) |
| Comprehend, proposal scope | working, then done; the open task's proposal is untouched |
| Debug | working; awaiting with the explanation (proposal kind `fix`, not yet a step); yes presents the fix as a step; awaiting; yes applies; done |
| Edit | working; awaiting with step 1; yes applies; awaiting with the next step; ... done |
| Clarification | awaiting with the question; the answer goes into the task and the action reruns |

## 5. Handling a submitted message

In order:

1. **Control word** that is available now (section 6): act in code. Done.
2. **A task is working:** abort its call (its result is dropped when it arrives).
3. **The open task asked a question** (clarification): the message is its answer. It is added to the task as `{asked, answer}` and the task's action reruns. No intent call.
4. **Intent** (v3 with the task context when a task is open or just ended; v2 shape otherwise):
   - off-topic: the fixed redirect;
   - clarification: a new task awaiting its question;
   - relation `ask`: comprehend with the proposal scope, as a short task;
   - relation `revise`: the open debug or edit task gets `revision + 1`, the correction is added, its proposal is withdrawn, and the action reruns with the task context;
   - relation `new` (or no task context):
     - debug or edit: a new task; an offered proposal is withdrawn and the old task is cancelled;
     - comprehend, search, hint: a short task; an offered proposal stays.
5. **Quiz policy** is checked before any action runs (as now).

**Reminder after a side task:** when a proposal is still offered, the reply ends with "Step 2 is still waiting. Say yes to do it, or stop." (or "The fix is still waiting...").

## 6. Control words

Matched as whole replies, after removing "please" and "Neon".

| Command | Words | Available when | Effect |
|---|---|---|---|
| yes | yes, yeah, sure, okay, do it, go ahead, next | a proposal is offered | consent (section 7) |
| all | all, do all, do everything, all steps | a plan with more than one step left, Whole plan allowed | apply the rest after one consent |
| stop | stop, no, cancel, never mind, cancel that | a task is open | end the task: abort a running call or withdraw the proposal; applied steps stay |
| undo | undo, undo that, take it back | a receipt exists | take back the newest step (section 8) |
| repeat | repeat, again, say that again | something was said | say the last line again |
| go | go there, take me there | a search found a block | move the cursor there |
| quiet | stop talking, be quiet, shh | the AI voice is speaking | silence the voice; the task stays |
| continue | continue, go on | a proposal is offered | check it still fits, then offer it again |
| end | end conversation, goodbye | a voice session is active | end the session; an open task is mentioned |

Quiet and end are handled by the conversation controller (they concern voice, not tasks); the coordinator only gets them through `act()` to report the open task. A control word that isn't available now is treated as an ordinary message.

## 7. Consent

A yes or all applies the proposal **offered last**, and only if:
- its `proposalId` is the current one (a revision or a new debug or edit task withdraws it);
- the program is still at the proposal's `workspaceVersion`.

If the program changed (only possible with the freeze off), the remaining steps are dry-run again:
- still fit: "Your program changed since I offered this. It still fits. Say yes again to do it." A fresh yes is needed, because the learner agreed to the old program;
- don't fit: "Your program changed, so this plan doesn't fit any more. Should I make a new one?" A yes here is a revision with the same request.

Apply uses `applyPlan` (dry run, then all or nothing in one undo group), writes a receipt, and moves the proposal on.

## 8. Undo

- Receipts form one stack for the session, newest first, across tasks.
- Undo checks the program is still at the receipt's `after` state, undoes, and checks it reached `before`; otherwise it redoes and refuses (as now).
- If the receipt belongs to the open task's proposal, that step is offered again; a finished or stopped task stays ended.
- The task context's "Applied" line drops undone steps.

## 9. Interface

```js
createCoordinator({
  workspace, agent,            // agent: the server client (or offline client), one call per harness request
  intentModel, model,
  cursor, stackLetters,        // as now
  moveCursor, openQuestion,    // as now
  onEvent,                     // every task event (section 10), for the output manager and the server log
}) -> {
  ask(text): Promise<Reply>,   // a submitted message
  act(command): Reply,         // a button or key (yes, all, stop, undo, repeat, go, continue)
  cancel(): void,              // Esc while working
  state(): {task, proposal, receipts, lock},  // for the UI status and the navigation lock
  view(): string,              // the program view (Log payload)
}
Reply = {say, actions: [{name, label}], expectsAnswer, taskId, kind: 'answer'|'question'|'offer'|'outcome'|'error'}
```

- `kind` tells the output manager the priority (questions and outcomes above progress).
- `state().lock` gives the navigation lock: frozen while working or applying, read-only while awaiting, free otherwise. The conversation controller adds "frozen while the AI voice speaks".

## 10. Events

Each event has `sessionId`, `taskId`, `revision`, a sequence number and a time; the server logs them (`specs/agent-server.md`), and the output manager uses the stage events for truthful progress.

`task.started`, `task.stage`, `task.revised`, `proposal.offered`, `proposal.withdrawn`, `step.applied`, `step.undone`, `task.done`, `task.cancelled`, `task.failed`, `message.routed` (control word, answer, or intent with relation).

The conversation controller adds the session, message, speech and navigation events. All go through the event sender (`src/interaction/events.js`); the full list and their data are in `specs/agent-server.md` section 7.

## 11. Caching

The in-memory cache stays, and its key gains the task context, so a revision or a different clarification answer never reuses an earlier answer. Only valid results are cached.

## 12. Tests

Unit tests (mocha, headless Blockly, scripted model client), extending `test/interaction.mocha.js`:
- consent: a yes after a revision never applies the withdrawn proposal; a yes after a program change asks again;
- side task: comprehend while a step is offered keeps it, with the reminder, and yes then applies it;
- stop while working aborts the call and drops its late result;
- a message while working aborts and routes with the task context;
- clarification answers go into the task context with the question;
- undo across tasks, refusal when the program changed, re-offer only for the open task;
- events in order with ids and sequence numbers.
