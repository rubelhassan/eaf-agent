# Feature spec: Harness context (intent v3, proposal questions, task context)

Status: **built 2026-10-28**; intent v3, comprehend-proposal v1 and the revision context wait for their eval runs (`m3-*`). Overall status: `../project-tracking.md`. Design: `../ai-system-design.md` 7.2 (context management), `../task-coordinator-design.md` sections 3 to 5, `../voice-interaction-flow/voice-interaction-design.md` section 8. Evaluation: `evaluation-and-harness.md` §15.2 and §15.3.

## 1. Decisions

- *(2026-10-28)* Every model call is stateless; code builds a task context from the coordinator's state, never a model. No chat history for now.
- *(2026-10-28)* Intent v3 keeps the 7 intents and adds `relation` (`new`, `revise`, `ask`), only when there is a task context.
- *(2026-10-28)* A question about the offered change is a comprehend request with the scope `proposal`, using its own prompt, **comprehend-proposal v1**. Comprehend v2 stays unchanged, so the answers waiting for your ratings still describe the live prompt.
- *(2026-10-28)* Debug v4 and edit v4 stay. The task context is added to their user message only for a revision or a clarification answer, so new requests send exactly what was evaluated.
- *(2026-10-28)* Intent v3 replaces v2 as the default when, on Mercury over 2 fresh runs, at least 90% of relations are right (27 of about 30) and the 40 v2 items score at least 39 of 40. Otherwise v2 stays and the coordinator treats every message as new.
- *(2026-10-28, changed)* **Intent v3 also carries ANSWER** (one v3, not two prompts): a loose or misheard answer to what was offered ("yes louit"), picked from the answers available now, which the request lists with what each does. The promotion rule adds: the 10 answer items at least 9 of 10 in each run. Until promotion the app pins v3 (`promptVersions` in `index.html`); the harness default stays v2. The relation and answer checks apply only to replies from v3 and later (the version the agent client reports), so v2, offline and test replies keep v2's rules and every message is new.
- *(2026-10-28)* The intent request's task is the one with an offer, else the latest task. Its lines already include "You last said", so there is no separate last-line field.
- When the program changes during a call, the learner is told (design 7.2); this spec only supplies the workspace version each reply was built for.

## 2. Scope

In:
- the task context builder and its text format;
- describing ops in plain words;
- intent v3 (prompt, harness, checks);
- comprehend-proposal v1 (prompt, harness, checks);
- the task context option for debug and edit;
- the workspace version on every harness result;
- eval items, scorers and run files for all of the above.

Out (later specs):
- the coordinator that holds tasks and uses all of this (`task-coordinator.md`);
- moving prompts to the agent server (`agent-server.md` milestone 1); until then prompts stay in `src/agent/prompts`;
- chat history.

## 3. Task context

`src/interaction/task_context.js`: `taskContext(task, {opsInWords}) -> string` (empty when there is no task). Lines appear only when they have content:

```
Task: edit, revision 2, waiting for an answer
Learner asked: "make it count by five"
You asked: "Should the count start at 5 or at 0?" Learner answered: "at 5"
Correction: "actually, use the inner loop"
Offered: step 1 of 2, set the number in the repeat block, block 3 of stack A, to 5
Applied: none
You last said: "Step 1 of 2: change the repeat count to 5. Say yes to do it, or stop."
```

- **Task line:** action (comprehend, debug, edit, search, hint), revision, state (working, waiting for an answer, done, stopped, failed).
- **Learner asked:** the first request of the task.
- **You asked / Learner answered:** each clarification, the last 3 at most.
- **Correction:** each revision's words, the last 3 at most.
- **Offered:** the step waiting for consent, in words (section 4); for debug before the fix is asked for: "the fix: <title>".
- **Applied:** steps applied in this task, in words, newest last; undone steps are left out.
- **You last said:** the last AI line, cut to 60 words.
- Learner words and AI lines are quoted with JSON escaping, so quotes inside them can't break the format.

## 4. Ops in words

`src/agent/context/ops_in_words.js`: `opsInWords(ws, steps, {stackLetters}) -> string[]`, one sentence per step.

- Each step is described against the program as it will be when that step runs: the steps are applied one by one on a copy (as the dry run does), so a later step can name a block an earlier step adds.
- Places come from `blockPositions` ("block 3 of stack A", "inside block 2 of stack B"); kinds from `blockTypeName`; values quoted when they are text.

| Op | Words |
|---|---|
| `setField` | set the number in the repeat block, block 3 of stack A, to 5 |
| `insert` after or before | add a print block saying "Done!" after block 4 of stack A |
| `insert` into an input | put a number block 2 into the repeat block, block 3 of stack A |
| `move` | move the print block, block 5 of stack A, to after block 2 |
| `delete` | remove the print block, block 6 of stack A, and what is plugged into it |
| `addBranch` | add an else branch to the if block, block 2 of stack B |

- A step with several ops joins them with "then".
- The output passes the speech checks (no ids, no markdown); a unit test runs it over every plan in the dev items.

## 5. Intent v3

**Request** (user message):
```
Learner said: "no wait, I meant the inner loop"
At the cursor: a controls_repeat_ext block
Task:
<task context lines, or "none">

Program:
<program view>
```

**Reply:** `{"intent": INTENT, "relation": "new"|"revise"|"ask"|null, "question": TEXT|null}`
- `relation` is required when a task context is given, and should be null when the task is "none"; the harness ignores one given without a task (decided 2026-10-29, as it cost a repair round of about 1.4 s).
- `new`: a different request. `revise`: changes what the open or just-finished task should do. `ask`: a question about what was offered, applied or said, that doesn't change it.
- Checks in code: known intent; relation present exactly when there was a task context; `revise` only when the task was debug or edit; the clarification question passes the speech checks. Broken replies get the usual repair round.

**Prompt:** `intent.v3.js`, v2 plus a short relation section; examples use made-up programs and ids (the existing test keeps that). Same inference settings as v2 (max_tokens 800, low effort).

**Harness:** `runIntent` takes an optional `taskContext` string; the result adds `relation`.

## 6. Comprehend-proposal v1

**Request:**
```
Learner asked: "why are you changing that?"
Word limit: 50
Task:
<task context lines>

Program:
<program view, cursor marked>
```

**Reply:** `{"voiceLine": TEXT}`

**Prompt rules** (`comprehend_proposal.v1.js`, compact): answer the question about the offered change; say what it would do and how it serves the learner's request; speak of it as not yet done; don't offer a different change; within the word limit; the shared speech rules.

**Checks:** the comprehend speech checks with the word limit (50, or 100 with "more"), plus "never says the change was made" (`claimsApplied`). One repair round.

**Harness:** `runComprehend` accepts `scope: 'proposal'` with `taskContext`; that scope uses the registry entry `COMPREHEND_PROPOSAL` (inference settings of COMPREHEND). The proposal itself is not passed back or changed.

## 7. Debug and edit with a task context

- `runPlanAction` takes an optional `taskContext`. When given, the user message gets `Task so far:` and the lines before `Program:`; otherwise the request is byte for byte what it is today.
- Prompt versions stay debug v4 and edit v4.
- The program view already contains the applied steps; the Applied line tells the model they came from this task.

## 8. Workspace version

- `src/agent/context/version.js`: `workspaceVersion(ws)`, a short hash of the serialized program (the hash the assistant's cache uses now, moved here).
- Every `run*` result adds `workspaceVersion`, taken when the request was built. The coordinator compares it with the program before speaking or offering (design 7.2).

## 9. Evaluation

- **Intent v3 items** (`eval/tasks/dev/intent3.jsonl`, about 30): about 10 each for new, revise and ask, with `taskContext` given as structured fields that the runner turns into lines with `taskContext()`. Scored on exact intent and relation; the report adds a relation confusion table.
- **Regression:** the 40 v2 intent items run with v3 and no task context.
- **Proposal items** (`comprehend_proposal.jsonl`, about 10): scored by the speech checks, `claimsApplied`, an unchanged proposal (code), and key points on your review sheet.
- **Revision items** (about 6, 3 debug and 3 edit, in the existing files with a `taskContext`): scored like other debug and edit items, on the corrected request's expected output.
- I draft all items; you review them (they join the human evaluation list).
- **Run files:** `m3-intent-v3-dev` (Mercury, plus DeepSeek and GPT for comparison), `m3-proposal-dev`, `m3-revision-dev`; 2 fresh runs for the promotion check.

## 10. Files

| File | Change |
|---|---|
| `src/interaction/task_context.js` | new |
| `src/agent/context/ops_in_words.js` | new |
| `src/agent/context/version.js` | new (hash moved from `assistant.js`) |
| `src/agent/prompts/intent.v3.js`, `comprehend_proposal.v1.js`, `index.js` | new prompts; registry entry `COMPREHEND_PROPOSAL`; defaults unchanged until promotion |
| `src/agent/harness/intent.js`, `comprehend.js`, `run.js`, `search.js`, `hint.js` | `taskContext` options, `relation`, `workspaceVersion` |
| `eval/runner/` | `taskContext` in items, relation scoring, proposal scorer |
| `eval/tasks/dev/` | new items |
| `test/` | unit tests (section 12) |

## 11. Milestones

1. *(done 2026-10-28)* **Context pieces:** `ops_in_words.js`, `task_context.js`, `version.js` and the `workspaceVersion` on results. Unit tests.

   Notes from building it:
   - `taskContext(task)` takes the steps already in words (`proposal.words`, `applied`), which the coordinator makes with `opsInWords` when it offers a plan, so the context needs no workspace.
   - Block kinds use the plugin's names ("repeat times", "arithmetic", "set variable"). A value inside a value block names both: "set the operator of the arithmetic block in the set variable block, block 2 of stack A, to multiply". A nested place names its block: "after the print block, inside block 3 of stack A".
   - Checked on every valid plan recorded in the dev harness runs (41 distinct steps): no ids, markdown or impossible places.
2. *(built 2026-10-28, waiting for your run)* **Intent v3:** prompt, harness, checks, items, scorers, run file. You run it; I analyse; promotion per section 1.
3. *(built 2026-10-28, waiting for your run)* **Proposal questions:** comprehend-proposal v1, harness, items, scorer, run file.
4. *(built 2026-10-28, waiting for your run)* **Revisions:** the debug and edit task context option, items, run file.

   Notes from building 2 to 4 (all three built before one batch of runs, as you chose):
   - Items: `eval/tasks/dev/intent_context.jsonl` (task `intent_context`: 10 new, 10 revise, 10 ask, 10 answers, including "yes louit", "yes plea" and an unclear "mm the blue"), `comprehend_proposal.jsonl` (10, key points for your review sheet) and 6 revision items in `debug.jsonl` and `edit.jsonl` (ids ending `-r1`). An item's `context` holds the task (action, state, what was asked, the plan in editor ops, how many steps are applied, the last line, the answers available); `eval/runner/task_items.js` builds the task from it with the app's own `taskContext` and `answersNow`, so requests match the app's. Applied steps are applied by `itemWorkspace`. Some items accept a second intent (`accept`), e.g. a debug revision read as EDIT.
   - Scoring: `intent_context` passes on the intent and the relation (or the answer); the report adds a relation table per model (expected against given). `comprehend_proposal` fails on the speech checks or a "done" claim, otherwise goes to your review sheet. Revisions use the debug and edit scorers on the corrected request's expected output.
   - Without a task, the intent, debug and edit requests are byte for byte today's (unit test). The revision request puts `Task so far:` after the instruction, which is the correction; an answer to a question asked back keeps the joined words and adds the task so far.
   - Run files: `m3-intent-v3-dev` (intent and intent_context on Mercury, DeepSeek v4.1 Flash and GPT-5.6 Luna Pro, 2 repeats, $1.50 limit), `m3-proposal-dev` and `m3-revision-dev` (DeepSeek v4.1 Flash, $0.30 each). Dry runs: 480, 10 and 6 records.

Each milestone ends with tests passing, `check-items` clean, and a short results note for your review.

## 12. Acceptance criteria and tests

- Without a task context, the intent, comprehend, debug and edit requests are byte for byte today's (a test compares them), so earlier results stay valid.
- `opsInWords` describes every plan in the dev items without ids or markdown, and later steps name blocks added by earlier ones correctly.
- `taskContext` output for a fixed task is stable (snapshot test), quotes are escaped, long lines are cut.
- Intent v3 checks reject a missing relation with a task context and `revise` for a comprehend task; a relation without a task context is ignored (read as new).
- A comprehend-proposal reply that says the change was made fails the check and gets the repair round.
- Every harness result has a `workspaceVersion` equal to `workspaceVersion(ws)` at request time.
- Promotion of intent v3 only by the rule in section 1.
