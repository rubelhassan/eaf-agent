# Feature spec: Task coordinator

Status: **built 2026-10-28** (milestones 1 to 4). Overall status: `../project-tracking.md`. Design: `../task-coordinator-design.md` (behavior, data, message handling, consent, undo, interface, events). Context and prompts: `harness-context.md`. Replaces `assistant.md`, which stays as the record of the first wiring and is marked superseded.

## 1. Decisions

- The design document's decisions *(2026-10-28)*: browser, headless, split by job; side questions keep the offered step with a reminder; stop, no, cancel and never mind end the task; a message while working aborts and is routed.
- *(2026-10-28)* The answer keys (Alt+Shift+Y, A, N, U, R) and Esc to cancel are built here, since they work for typed requests too. Ctrl to stop the AI voice and I to talk come with the voice spec.
- *(2026-10-28)* The navigation lock is enforced here for working, applying (frozen) and waiting (read-only). The voice spec adds "frozen while the AI voice speaks".
- *(2026-10-28)* **Loose or misheard answers go to the model.** Answers are still matched in code first (exact words, no call). Anything else goes to intent v3 with what the assistant last said and the answers available now, each with what it does ("yes: do step 1 of 2: ..."; repeat is left out). It may reply `ANSWER` with one of those names; code checks it is available and acts exactly as if it were said ("yes louit" applies the offered step at once, no extra check). `ANSWER` with no name, or a name no longer available, says "I didn't understand your answer. Can you say it again?" and keeps the offer. The app pins intent v3; the harness default stays v2 until its eval run.
- *(2026-10-28)* The event sender takes a pluggable sink. Until the agent server exists, the app prints events to the console when a **Log events** setting is on, and drops them otherwise.

## 2. Scope

In:
- `coordinator.js` with tasks, revisions, proposals, consent, receipts, side tasks, abort, clarifications in the task context, events, `state()` and `cancel()`;
- the extended control words;
- `events.js` with batching, ids, sequence numbers and a retry buffer;
- the answer keys and Esc;
- the navigation lock and its setting;
- switching the Neon pilot from `createAssistant` to `createCoordinator`.

Out:
- voice, the output manager, Ctrl and I, idle and suspend (voice and output specs);
- the agent server client (agent server spec); the coordinator keeps using a `ModelClient` until then;
- intent v3, comprehend-proposal and revision prompts (built in `harness-context.md`; this spec wires them in its last milestone).

## 3. Files

| File | Change |
|---|---|
| `src/interaction/coordinator.js` | new; replaces `assistant.js` (removed) |
| `src/interaction/commands.js` | more words and commands (`continue`, `quiet`, `end`); stop words merged |
| `src/interaction/events.js` | new: event sender |
| `src/interaction/task_context.js` | from `harness-context.md` |
| `src/util/navigation_lock.js` | new: the lock (section 6) |
| `src/util/assistant_keys.js` | new: answer keys and Esc (section 7) |
| `src/index.js` | exports `createCoordinator`, `createEventSender`, `NavigationLock`; drops `createAssistant` |
| `test/acblock/js/pilot/blockly_pilot.js`, `pilot_chat.js`, `js/main.js`, `index.html`, `js/settings.js` | use the coordinator; reply `kind`; Esc; status; settings (Log events, Pause editing) |
| `documentation/specs/assistant.md` | status: superseded by this spec |
| `test/interaction.mocha.js`, new `test/navigation_lock.mocha.js` | tests |

## 4. Behavior

As in the design (sections 4 to 8). Fixed texts added here:

| When | Says |
|---|---|
| side task done, step waiting | "Step 2 is still waiting. Say yes to do it, or stop." (fix: "The fix is still waiting...") |
| yes after the program changed, still fits | "Your program changed since I offered this. It still fits. Say yes again to do it." |
| yes after the program changed, doesn't fit | "Your program changed, so this plan doesn't fit any more. Should I make a new one?" |
| stop while working | "Okay, I stopped." |
| stop while waiting | "Okay, I won't make that change." (plus "Say undo to take back a step." when there are receipts) |
| continue, still fits | the step again |
| a reply built for an older program | the design 7.2 lines ("Your program changed while I was working...") |
| a fix or plan that fails its checks after the repair round | "Sorry, I couldn't make a change that works in your program. Please try saying it another way." (never offered, and the next reply is a new message) |
| a step applied | "Done." / "Did step N." then "Your cursor is on the print block, block 1 of stack C." |
| undo | "Took back the change." then "Your cursor is back where it was." |

**The cursor follows applied steps** (decided 2026-10-29): after each applied step it goes to the block the step's last op added or changed (an insert: the outer new block; a delete: the block that took its place, else the one before it, else its parent), without taking keyboard focus from the text box. Undo puts it back where it was before that step. A new stack goes to the cursor's spot on empty workspace, else below the cursor's stack; the spot is fixed when the plan is offered.

**Before intent v3 is promoted** (`harness-context.md` section 1), intent replies have no relation: every message is `new`, so revisions start a new task with the corrected words and proposal questions are ordinary comprehend requests. The coordinator reads the relation when it is present; no flag is needed.

## 5. Events

- `createEventSender({sink, sessionId, learnerCode, batch = {ms: 5000, max: 20}, buffer = 500})` returns `{record(kind, data), flush(), dispose()}`.
- `record` adds `id`, `seq` and time. Batches go to `sink(batch)` every 5 s, at 20 events, on `flush()` (the coordinator flushes at task end) and on page hide (the app calls `flush()` from `pagehide`; the server sink will use `sendBeacon`).
- A sink that throws or rejects keeps the events (up to 500, oldest dropped) for the next batch.
- App sink for now: `console.info('[events]', batch)` when Settings → **Log events** is on; dropped otherwise.
- Own-work counts (`activity.summary`): counted from workspace change events, leaving out the events of a coordinator apply or undo (tagged by their group id), and sent with each batch when they changed.

## 6. Navigation lock

`src/util/navigation_lock.js`: `new NavigationLock(workspace, {getLock, onBlocked})`.

- **No change to the stable files.** It listens for `keydown` in the capture phase on the workspace's injection div and looks up which shortcut the key would trigger with `Blockly.ShortcutRegistry.registry.getShortcutNamesByKeyCode()`.
- **Frozen** (working, applying): every shortcut is stopped except Esc (cancel, section 7) and the answer keys; the cue is "The assistant is working. Press Escape to stop it."
- **Read-only** (waiting for an answer): moving and reading work; edit shortcuts are stopped with the cue "You can look around, but editing waits until you answer. Say yes, stop, or undo."

| Allowed in read-only | Stopped in read-only |
|---|---|
| previous, next, in, out, layer in and out, exit, workspace cursor moves, stack jump and search, cursor location, output focus, run program, copy, show shortcuts and hints, zoom | insert, mark, disconnect, toolbox, cut, paste, delete, undo (Ctrl+Z), edit mode, edit stack label, add comment, move statement up and down, open dropdown |

- **Mouse:** in frozen and read-only, `pointerdown` on blocks and the toolbox is stopped in the capture phase with the same cue (scrolling and zooming still work).
- **Setting:** Settings → **Pause editing while the assistant works** (on by default). Off: no lock; a changed program is handled by the coordinator's rechecks.
- Cues go through `Speech.update()` (later, the output manager).
- `dispose()` removes the listeners.

## 7. Keys

`src/util/assistant_keys.js`: one `keydown` listener on the document, active while the assistant is set up.

| Key | Action |
|---|---|
| Alt+Shift+Y | `act('yes')` |
| Alt+Shift+A | `act('all')` |
| Alt+Shift+N | `act('stop')` |
| Alt+Shift+U | `act('undo')` |
| Alt+Shift+R | `act('repeat')` |
| Esc while a task is working | `cancel()` |

- A key whose command isn't available now gives a short cue ("There is nothing to say yes to.") instead of doing nothing silently.
- Esc keeps its normal meaning (exit, close the panel) when no task is working.
- Checked before building: none of these is registered in `navigation_controller.js` or the pilot (Alt+letter is the stack jump; Alt+Shift+G is stack search). The in-app shortcut help lists them.

## 8. Pilot changes

- `createCoordinator` replaces `createAssistant`, with the same `ask`, `act` and `view`.
- `displayReply` uses the reply's `kind` (question, offer, outcome, answer, error) for its icon; the buttons come from `actions` as now.
- The panel's status line shows the task state from `state()` ("Working", "Waiting for your answer").
- Esc in the chat input while working calls `cancel()`.

## 9. Milestones

1. *(done 2026-10-28)* **Coordinator core:** tasks, ids, consent with proposal ids and workspace versions, receipts and undo across tasks, side tasks with the reminder, stop and abort, clarification answers into the task context, the cache key with the task context. Pilot switched. Works with intent v2.

   Notes from building it:
   - `act()` returns a Promise (a yes on a plan that no longer fits makes a new one); `cancel()` returns the reply to say ("Okay, I stopped.") or null. Esc in the panel calls it.
   - Until the debug and edit calls take the task context (`harness-context.md` milestone 4), a clarification answer is recorded with its question in the task context and still sent joined to the request, as before. The cache key gets the task context with that milestone, when it is first sent.
   - The coordinator already emits the task events through `onEvent` (sent nowhere until milestone 2). "Checking again" lines go through `onProgress`.
   - `stop` while a question is asked back and a step is offered ends both, so nothing applies by accident.
   - "Quiet" and "end conversation" are matched by the voice milestones, not here.
   - Browser check (model stubbed through the dev adapter): offer, side question with the reminder, yes, undo with the step offered again, Esc while working; the lock reads frozen while working and read-only while a step waits.
2. *(done 2026-10-28)* **Events:** `events.js`, the Log events setting, own-work counts.
3. *(done 2026-10-28)* **Keys and lock:** `assistant_keys.js`, `navigation_lock.js`, the Pause editing setting, the teacher guide updated.

   Notes from building 2 and 3:
   - The coordinator applies and undoes inside an event group named `agent-<task>-...`; the own-work counter (`createActivityCounter` in `events.js`) counts one edit per learner change group and leaves out those groups, undo and program loads (the app calls `ignoreUntilLoaded()` before loading). Runs come from the Run button.
   - The session id is made per page load in the app; the learner code stays null until the study setup.
   - The lock looks up the shortcut a key would run with Blockly's `ShortcutRegistry` (`serializeKeyEvent`, `getShortcutNamesByKeyCode`) and the shortcut's precondition, in a capture listener on the document (Blockly 11 handles shortcuts on the document). A key that would do nothing isn't blocked. Read-only uses an allow list, so a new editing shortcut is stopped until it is added.
   - The reason is said once per lock (and again after each reply); further blocked keys only play the cue.
   - Answer keys read `e.code`, since Alt changes `e.key` on a Mac. Escape stops a working task anywhere; otherwise it keeps its meaning (close the panel, empty the draft).
   - Browser check (model stubbed): read-only lets S move and stops Delete and a click on a block; Alt+Shift+Y applies, Alt+Shift+U undoes, Alt+Shift+A says why it can't; frozen stops S; Escape stops the task; with Pause editing off nothing is stopped; Log events prints the task events and the activity summary (the assistant's changes not counted).
4. *(done 2026-10-28)* **Relations:** wire intent v3 (revise, ask), comprehend-proposal and revision context, after the `harness-context.md` milestones.

   Notes from building it:
   - `revise` (only for a debug or edit task) keeps the task: one revision on, the correction recorded, the offer withdrawn, and the action run again with the correction and the task so far. A yes then applies only the new plan.
   - `ask` with COMPREHEND while a change is offered runs comprehend-proposal with the task so far; the offer stays, with the reminder. Other `ask` messages, and `new`, are routed as before.
   - A clarification answer to debug or edit now also sends the task so far; the cache key has the task context.
   - The same question twice now goes to intent again (the first task is in the second request), and is answered from the cache.
   - Browser check (model stubbed, intent v3 pinned): an offered plan, "no, make it say Hello Class" revised it with the task so far, "why there?" got the proposal prompt with the offer kept, "yes louit" applied only the new plan.

Each milestone ends with unit tests, a stubbed browser check (no real model), and a short note for your review.

## 10. Acceptance criteria and tests

Unit tests (scripted model client, headless Blockly):
- a yes after a revision or a new debug or edit request never applies the withdrawn proposal;
- a yes after the program changed asks again (still fits) or offers a new plan (doesn't fit), and a yes to that runs a revision;
- a side comprehend while a step waits keeps the step, adds the reminder, and a yes then applies it;
- stop while working aborts the call (the `AbortSignal` fires) and a late result is dropped;
- a message while working aborts and is routed with the task context;
- a clarification answer goes into the task context with its question, and the action reruns without an intent call;
- undo across tasks, refusal when the program changed since, re-offer only for the open task;
- events: ids unique, `seq` increasing, batches at 20 and on flush, retry after a failing sink, oldest dropped past 500; own-work counts leave out coordinator changes;
- the lock: in read-only, every shortcut in the stopped list is blocked and every one in the allowed list passes; frozen blocks all but Esc and the answer keys.

Browser check (Playwright, model stubbed):
- typed request, step offered, Alt+Shift+Y applies it, Alt+Shift+U takes it back;
- while waiting, arrow-style navigation speaks as usual and Delete gives the read-only cue;
- Esc while working cancels, and the late reply never shows;
- with Pause editing off, the lock never blocks.

Real screen reader check (NVDA or VoiceOver) of the cues and keys before any accessibility claim.
