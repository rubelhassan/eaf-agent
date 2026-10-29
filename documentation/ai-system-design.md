# AI system design: the agent layer

Status: **DRAFT 2026-10-27** for review. This describes the AI agent layer as it should be, with each part marked **built**, **partial** or **planned**. Progress is tracked in `project-tracking.md`; the general system is in `System Design Document.docx`. Build details for the server are in `specs/agent-server.md`, the evaluation plan in `specs/evaluation-and-harness.md`, and the conversation in `specs/assistant.md`.

## 1. Purpose

The agent layer helps blind, low-vision and sighted K-12 learners understand, fix and change block programs. It answers in short spoken text and proposes changes the learner approves one step at a time. It never fills a question block, never reveals a hidden reference answer, and never changes the program on its own.

Design goals, in order:
1. **Safe:** child privacy and safety rules hold for every request.
2. **Correct:** answers are grounded in the real program, and every change is checked before it is offered.
3. **Accessible:** spoken output that a screen reader or synthetic voice can read naturally, places named by structure.
4. **Fast:** a spoken answer within a few seconds; anything code can answer never waits for a model.
5. **Measurable:** every prompt and model change is evaluated before it becomes the default.

## 2. Architecture

### 2.1 Overview

```
Browser (plugin + app)                                   Agent server (Node + TypeScript)          Models
---------------------------------------------           ------------------------------------      ----------------
Interaction manager  src/interaction/                    Guard in: masking, distress check  ──►   OpenRouter (now)
  conversation, answer words, plan state, undo           Prompt registry + user templates          Lab server with
Harness, browser part  src/agent/                        Model router + inference settings  ──►   your own model
  program view, search by code, id mapping,     envelope   Guard out: restore masked values         (planned)
  normalizing, dry run, speech checks, repair  ────────► Cache across sessions
  in-memory cache                              ◄──────── Logs (SQLite), distress flags
Workspace (live Blockly), learning features      reply
Output (panel, voice; output manager planned)
```

The split follows one rule: **anything that needs Blockly, the live program or the browser stays in the browser; anything that is text only lives on the server.** The Blockly work (program view, dry run, checks) takes milliseconds and has to run on the learner's live program anyway. The server stays small, needs no Blockly, holds the keys, and is the one place every model call passes through.

### 2.2 Browser part

| Part | Status | Where |
|---|---|---|
| Conversation: intent routing, offered fixes, step-by-step plans, stop, undo, clarification | built | `src/interaction/assistant.js` |
| Task coordinator: tasks, revisions, proposals bound to consent, receipts, events | planned | `task-coordinator-design.md` |
| Output manager: one queue for AI voice, system voice, screen reader and earcons | planned | `output-manager-design.md` |
| Answer words and buttons | built | `src/interaction/commands.js` |
| Scope from the cursor, widened by words | built | `src/interaction/scope.js` |
| Program view (short ids, stack letters, block numbers, cursor, question purpose) | built | `src/agent/context/snapshot.js` |
| Search by code (a unique exact hit, no server call) | built | `src/agent/harness/search.js` |
| Reply reading: id mapping, normalizing unambiguous variants | built | `src/agent/harness/run.js`, `normalize.js` |
| Plan dry run and grounding (ops, toolbox, connection rules, learner work) | built | `src/agent/editor/`, `src/agent/guardrails/learner_work.js` |
| Speech checks (length, ids, markdown, visual references, applied claims, impossible places) | built | `src/agent/guardrails/speech.js` |
| One repair round with the problems found | built | `askWithRepair` in `run.js` |
| Hint checks (level rules, no answer) | built | `src/blocks/question/ai_hints.js` |
| In-memory cache per page session | built | `assistant.js` |
| Agent server client (replaces the direct OpenRouter client) | planned | `src/agent/model/` |
| Offline client with canned replies (no server or `testing: true`) | built | `src/agent/model/fake.js` |

Today the browser also builds the full model request (prompts, settings) and calls OpenRouter directly. With the server, the browser sends the **input parts** of a request and the server owns prompts and settings (2.3).

### 2.3 Server part

| Part | Status |
|---|---|
| Envelope check, session and learner code | planned |
| Guard in: personal information masking (patterns plus a local NER model) | planned |
| Guard in: distress and harm phrase check, no model call on a hit | planned |
| Prompt registry: system prompt and user template per task and version | planned (prompts exist in `src/agent/prompts`) |
| Model router: model per task, provider, inference settings | planned (settings exist in `src/agent/model/inference.js`) |
| Guard out: restore masked values, reject replies with unknown mask ids | planned |
| Cache across sessions | planned |
| Logs in SQLite (masked text only), distress flags | planned |
| Cost and rate limits | planned |

### 2.4 Models and providers

| Kind | Status | How |
|---|---|---|
| External, through OpenRouter | built (called from the browser today) | Pinned endpoint per model, no fallbacks, `require_parameters`. |
| Your own trained or fine-tuned model on a lab server | planned, design only | An OpenAI-compatible server (Ollama, vLLM or llama.cpp) behind the model router. The model can get its own prompt version, since prompts live on the server. |
| In-browser model | not planned | Not needed now; the browser part never calls a model directly. |

Current models:

| Use | Model | Endpoint |
|---|---|---|
| Intent | `inception/mercury-2.5` | `inception` |
| Comprehend, debug, edit, search, hint (app default) | `deepseek/deepseek-v4.1-flash` | `deepinfra/fp8` |
| Comparison in the eval | `openai/gpt-5.6-luna-pro` | `azure` (no temperature) |

Model ids live in config and eval run files. A new model is added to the inference settings first, after checking its endpoint's supported parameters.

## 3. Tasks

| Task | What it does | Scope | Status |
|---|---|---|---|
| Intent | Routes the learner's words to one task: comprehend, debug, edit, search, hint, off-topic, clarification. With an open task (v3) it also says how the words relate to it: new, revise, ask. | cursor and task context | v2 built, v3 planned |
| Comprehend | Explains the part at the cursor, or answers a question about the offered change (its own prompt, comprehend-proposal v1). | field, block, statement, stack, program; proposal | v2 built, proposal scope planned |
| Debug | Finds the one most severe issue, explains it, and on request proposes one fix. Severity: won't run, runtime error, wrong result, fragile. | cursor and program | partial: goal sources planned (7.3) |
| Edit | Turns one instruction into one plan of ordered steps. | cursor and program | partial: "which change first" and Guided mode planned |
| Search | Finds blocks and says where they are. Code answers a unique exact hit. | program | built |
| Hint | One hint for a question block at a level (nudge, point, kind). | the question | built |
| Scaffold | Picks gaps for a partial program among the spots the rules offer. | program | partial: rules built, agent part is a fake |
| Off-topic | Fixed kind redirect from code. | | built |
| Distress | Fixed kind reply, teacher flag in the log, no model call. | | planned |

## 4. Interaction

The conversation is in `specs/assistant.md`; the voice design, with tasks, revisions and interruptions, is in `voice-interaction-flow/voice-interaction-design.md`. In short:

- Every request that isn't an answer word goes to intent, then to one task, scoped by the cursor and widened by words like "program" or "this stack".
- **Explain before fix:** debug explains first; "yes" brings the fix as a step to confirm.
- **Learner-controlled execution:** each step is spoken, "yes" applies it, "all" applies the rest only when the task's Whole plan setting allows it, "stop" ends the plan, "undo" takes back one applied step per request, only if the program hasn't changed since. A step that no longer fits the program ends the plan.
- Answer words (yes, all, stop, undo, repeat, go there) are matched in code and are also chat buttons. Keyboard commands are planned.
- Search: "go there" moves the cursor to the found block; nothing else moves it.
- Hint: opens the question's help, which runs the hint task with its attempt gate and levels.
- Clarification: the model's question is spoken; the answer goes into the task context (7.2) with the question it answers.
- Open task (planned): a message is a new task, a revision ("actually, the inner loop"), or a question about the offered change, decided by intent v3.
- Quiz: only explaining a field or block, search and the question's help. Teacher-set actions per activity are planned.
- Edit modes: Step-confirm (built, default), Whole-plan (built, off unless the teacher allows it), Guided (planned).

## 5. Expected input and output

### 5.1 What the browser sends (input parts)

Every task gets the learner's words and the program view. The view is text: each block as `[b3] type FIELD=value INPUT=(...)`, statements indented, stacks by letter with blocks numbered, the cursor marked, and the toolbox types. Question blocks show their prompt and kind, never the reference answer or intended blocks.

| Task | Extra input |
|---|---|
| Intent | what is at the cursor; the task context when a task is open or just ended (7.2) |
| Comprehend | scope, field at the cursor, word limit (50, or 100 when the learner asks for more); for the proposal scope, the offered change in words |
| Debug | for a revision or a clarification answer, the task context; the goal (7.3) is planned |
| Edit | for a revision or a clarification answer, the task context |
| Search | none |
| Hint | level and its rule, learner level, question prompt and instruction, kind needed, intended block names, earlier hints, teacher note |

### 5.2 What the model replies (JSON object)

| Task | Reply | Checked by code |
|---|---|---|
| Intent | v2: `{intent, question}`; v3: `{intent, relation, question}`, relation `new`, `revise` or `ask`, only when there is task context | known intent and relation; question passes the speech checks |
| Comprehend | `{voiceLine}` | speech checks within the word limit |
| Debug | `{issue: null or {severity, blocks, explanation}, fix: null or {title, ops}, voiceLine}` | severity known; blocks exist; fix dry-runs; voiceLine speech checks, no claim it was applied |
| Edit | `{steps: [{title, ops}], voiceLine}` | every step dry-runs in order; no steps only with a question; speech checks |
| Search | `{blocks, voiceLine}` | blocks exist; speech checks with real places |
| Hint | `{hint}` | level rules, no answer, at most 2 sentences, speech checks |

Ops: `setField`, `insert`, `move`, `delete`, `addBranch`, with a place `after`, `before` or `parent` plus `input`. New blocks nest their inputs instead of naming ids.

### 5.3 What the learner hears

- At most 40 words for debug and edit, the word limit for comprehend, 2 short sentences for a hint.
- Plain sentences: no ids, markdown, lists, emoji, colors or screen positions.
- Places by structure: "the print block, block 3 of stack A".
- No claim that a change was made before the learner approved it.
- Planned: every AI turn, typed or spoken, is an earcon then the AI voice; navigation and system speech use the screen reader or the system voice (voice design, section 5).

## 6. Prompts

- Versioned files, never edited in place: `intent.v2` (v3 planned), `comprehend.v2` (with `comprehend_proposal.v1` for the proposal scope, planned), `debug.v4`, `edit.v4`, `search.v2`, `hint.v2`, shared parts `shared.v1` (speech rules) and `shared.v3` (ops).
- Compact: the harness, not the prompt, makes behavior reliable. Examples use made-up ids that no dataset program has (a test enforces it), so they never hint at an item's answer.
- A prompt version, once the server owns prompts, is the system prompt **plus** the user template that turns the input parts into the user message. A fine-tuned model can have its own version.
- The prototype's v1 prompts are frozen in `eval/runner/baseline/` as the raw arm.
- Every change gets a new version and a dev run before it becomes the default.

## 7. Harness

### 7.1 One request, step by step

1. **Browser:** answer word? Handle it in code. Otherwise build the program view and input parts. Search tries code first.
2. **Browser to server:** the envelope (task, session, learner code, learner words, input parts).
3. **Server, guard in:** check the envelope; distress phrases end here with a fixed reply and a flag; mask personal information.
4. **Server:** cache hit? Return it. Otherwise render the prompt, route to the model, call it.
5. **Server, guard out:** restore masked values, reject unknown mask ids, log the masked request and reply.
6. **Browser:** map short ids to real ones, normalize, check the shape, dry-run plans, run the speech and hint checks.
7. **Browser:** problems? One repair round through the server with the problems listed. Still broken: a short failure message (or the fallback hint).
8. **Browser:** speak the reply, offer the plan; apply only after "yes", dry-running again on the live program.

### 7.2 Context management

Every model call is stateless: the model remembers nothing between calls. The conversation's state lives in the task coordinator in the browser, and code decides, per call, exactly which part of it the model sees. Nothing in the context is written by a model, so the same state always gives the same request (and the same cache key).

**What each call gets:**

| Call | Program view | Cursor and scope | Task context | Other |
|---|---|---|---|---|
| Intent | whole program | cursor, what is at it | when a task is open or just ended | |
| Comprehend | whole program, focus marked | scope, field | | word limit |
| Comprehend, proposal scope | whole program | cursor | request and corrections | the offered change in words |
| Debug, edit (new request) | whole program | cursor | | toolbox |
| Debug, edit (revision or clarification answer) | whole program, with applied steps already in it | cursor | request, questions asked and answers, corrections, steps applied | toolbox |
| Search | whole program | | | |
| Hint | whole program, gap marked | | | level, question, earlier hints, teacher note |

**Task context,** built by code from the coordinator's state, a few short lines:
```
Task: edit, revision 2
Learner asked: "make it count by five"
You asked: "Should the count start at 5 or at 0?"  Learner answered: "at 5"
Correction: "actually, use the inner loop"
Offered: step 1 of 2, change the repeat count to 5
Applied: none
You last said: "Step 1 of 2: change the repeat count to 5. Say yes to do it, or stop."
```
- It replaces today's string join after a clarifying question, and adds the question that was asked, which the join left out.
- The offered change is described by code from the ops ("set the number in block 3 of stack A to 5"), not by the model, so it can't drift from what would actually happen.
- **Lifetime:** the context belongs to the open task, and stays after the task ends until a new task starts or the session suspends, so "why did you do that?" right after a change still works.
- **No chat history** for now: deterministic, short, and nothing personal carried across turns. The last few turns may be added later if the data shows follow-ups that the task context misses.

**The program view** is the whole program with the focus marked, not a trimmed neighborhood, so the model can add the outer context a part needs. Steps already applied are simply part of the program.

**When the program changed during a call** (only possible with the freeze off), the learner is told and stays in the loop:
- Plans: dry-run again on the current program. Still fits: "Your program changed while I was working. This step still fits." and the step is offered. Doesn't fit: "Your program changed while I was working, so this plan doesn't fit any more. Should I make a new one?"
- Explanations and search: "Your program changed while I was working, so I'm checking again." and one automatic rerun. Changed again: "Your program is still changing. Ask me again when you're ready."
- Every reply carries the workspace version it was built for; the coordinator compares it before speaking.

### 7.3 Debug goal

- Debug goal sources (planned, decision open): the lesson's stated goal, the learner's practice objective (ask first if none), and the hidden reference program. The reference must never reach a prompt; one safe option is that code runs it and only the difference in output reaches the model.

### 7.4 Tools

Tools run in code, not called by the model.

| Tool | Status | Where |
|---|---|---|
| Program view and location describer | built | browser |
| Plan validator and dry run | built | browser |
| Search index (exact hit by text or unique kind) | built | browser |
| Hint checker | built | browser |
| Speech checker | built | browser |
| Program runner (output for sample inputs, runtime errors, runaway loops) | planned | browser (the host's `execute`), eval in Node |
| Static checks (used before set, empty inputs, loops that never run) | planned | browser |
| Block roles and behavior diff | planned | browser |
| Personal information masker | planned | server |

Model-called tools (function calling) only if the data shows a model needs them mid-task.

### 7.5 Validation rules

- Ground every block id in the program; refuse unknown ids, types outside the toolbox, question blocks and learners' answers.
- Dry-run the whole plan on a copy; apply all or nothing in one undo group; check the remaining steps again before each step.
- Invalid plans are never shown.
- Spoken text passes the speech checks.
- The program is the ground truth: in the eval, behavior is checked by running programs.

### 7.6 Caching and determinism

- Low temperature per task, pinned endpoints.
- Browser: in-memory cache per page session (action, model, program state, scope, cursor, words).
- Server: cache across sessions, keyed by the masked rendered request, model and settings (planned).
- Only valid results are cached.

## 8. Guardrails

| Group | Rule | Where | Status |
|---|---|---|---|
| G1 | Mask personal information: in chat, names, school, age, location and contacts; in program text, contacts (names in program text are program content and stay). Typed ids like `PHONE_1`, map kept in memory for one request. | server | planned |
| G1 | Stay on task: off-topic gets a fixed redirect. | intent (model), reply in code | built |
| G1 | Distress or harm: local phrase check, kind fixed reply, log flag for the teacher, no model call. | server | planned |
| G1 | No training on student data: providers that keep data are excluded (`data_collection: "deny"`). | server | planned |
| G2 | Activity policy: actions and edit modes per activity; quiz default; Whole plan off by default. | browser policy, server check | partial |
| G2 | No answers in gaps; attempt before hint; explain before fix. | browser | built |
| G2 | Reliance signals for the teacher (hints, agent edits, accepted fixes). | server logs | planned |
| G3 | Grounded, validate before offering, consistency. | browser, both caches | built |
| G3 | No unverified claims ("it works") without a run. | browser speech checks, program runner | planned |
| G4 | AI always identified (earcon, AI voice). | output manager | planned |
| G4 | Logs for teacher review and research. | server | planned |
| G4 | Teacher control per learner. | server policy | planned |
| G5 | Structural references, speech-ready text, cursor moves only on request. | browser | built |

## 9. Dataset

- 54 programs (`eval/datasets/programs`): 9 categories, 3 difficulties, 5 grade bands, 4 to 70 blocks, 33 with input.
- Dev set: programs 8, 18, 30, 38, 41. Eval set (held out): 10, 16, 23, 35, 49. Reserve: the other 44.
- 134 dev items: comprehend 19, debug 15, edit 10, search 10, hint 10, intent 40, guardrails 30. Items store inputs and mutations; expected outputs come from running the programs.
- Planned: the eval set items, frozen after your review; more guardrail items for masking and distress.

## 10. Evaluation and metrics

Details in `specs/evaluation-and-harness.md`.

- **Arms:** raw (frozen prototype), harness (browser part run headless in Node, calling the agent server once it exists), harness plus tools (planned).
- **Repeats:** 3 runs per item, model and arm.
- **Metrics:**
  - correctness per task: debug points at the injected block and the fix restores the output; edit applies and produces the expected output with untouched blocks unchanged; search precision and recall plus a correct spoken place; intent accuracy and confusion; hint level rules;
  - quality: comprehend and hint ratings by you (content adequacy, conciseness, fluency) and calibrated judges;
  - reliability: pass@1, pass^3, 95% bootstrap intervals;
  - efficiency: latency p50 and p95, tokens, cost, model calls, repair rate, share of requests answered by code or cache;
  - safety: refusal and over-refusal, personal information in outgoing requests and in replies, policy violations (target 0).
  - conversation (planned): intent v3 relation accuracy, scripted scenarios scored on the final program and consent safety (target 0 violations);
  - voice (planned): word error rate on our utterances and children's speech, false command rate (above all a false yes), intent after recognition, false wakes per hour, time to first speech, stop within 200 ms.

## 11. Requirements

### 11.1 Functional

| # | Requirement | Status |
|---|---|---|
| F1 | Route every request to one task, or answer in code. | built |
| F2 | Scope every task by the cursor, widened only by clear words. | built |
| F3 | Comprehend at field, block, statement, stack and program scope. | built |
| F4 | Debug: one most severe issue, explained first, fix on request. | built |
| F5 | Debug uses the lesson goal, practice objective or reference behavior. | planned |
| F6 | Edit: one instruction, one plan; ask which change first when it holds several. | partial |
| F7 | Offer only validated plans; apply step by step, all when allowed, stop, undo one step at a time. | built |
| F8 | Never fill a question block or reveal a reference answer. | built |
| F9 | Hints only through the question's help, after an attempt, by level. | built |
| F10 | Mask personal information before any model call and any log. | planned |
| F11 | Keep distress away from the model; flag it for the teacher. | planned |
| F12 | Enforce the activity policy on both the browser and the server. | partial |
| F13 | Log every request, reply and event, masked, per session and learner code. | planned |
| F14 | Work without a server or key with canned offline replies. | built |
| F15 | Route each task to a configured model and provider, including a lab model later. | planned |

### 11.2 Non-functional

| # | Requirement | Target |
|---|---|---|
| N1 | Latency | Answers by code or cache under 100 ms. Intent p50 under 1.5 s. A spoken "working on it" in voice mode while a task model runs (built). Targets per task after the server baseline. |
| N2 | Privacy | No personal information in model requests or logs; keys only on the server; no providers that keep data; consent and retention per the school agreement (FERPA, COPPA). |
| N3 | Reliability | Request timeout and abort; one repair round; a failure is a short spoken message, never a half-applied change. |
| N4 | Determinism | Low temperature, pinned endpoints, two caches. |
| N5 | Accessibility | Speech-ready text, structural places, focus never moved without the learner; WCAG 2.1 AA for the UI. |
| N6 | Portability | Providers behind the model router; the browser part has no DOM code outside the app, so the eval runs it in Node. |
| N7 | Observability | Each record has request id, session, task, prompt version, model, settings, latency, tokens, cost, repair and cache flags. |
| N8 | Maintainability | Versioned prompts; every change evaluated on dev first; unit tests for checks, ops and scorers. |
| N9 | Cost | A spending limit per run (eval) and per day (server). |
| N10 | Security | The server listens on localhost for now; CORS only for the app's origin; envelope checked against a schema. |

## 12. Open decisions

- Debug goal sources and how the reference program may be used (7.3).
- Keyboard commands for the assistant's answer words.
- Latency targets per task, after a first measured baseline through the server.
- Teacher-set actions per activity, and per learner.
