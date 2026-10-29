# Project tracking

Updated 2026-10-29 (plan from the lead review). What is built, what is left, and an audit of the code against `System Design Document.docx` and `system_architecture_diagram.png`. Feature details live in `specs/`; this file only tracks status. Section numbers in parentheses are the design document's (3.2 Debug, 4.7 Interactive output, G2 pedagogical guardrails...).

Legend: **done** (built and tested), **partial** (built, but part of the design is missing), **not started**, **deferred** (decided to wait).

## 1. Status by architecture box

### Input modalities

| Part | Status | Where | Notes |
|---|---|---|---|
| Keyboard navigation and editing | done | `src/navigation*.js`, `src/cursors/` | Stable zone. Mode badge, stack labels and names, block numbers, shortcut help. |
| Voice (speech to text) | done | `src/voice/`, `test/acblock/js/voice/` | sherpa-onnx in the browser (recognition, voice activity, wake phrase), one microphone, the draft box, barge-in with echo filtering. Your real-voice check is pending (section 3). |

### Interaction manager

| Part | Status | Where | Notes |
|---|---|---|---|
| Task coordinator | done | `src/interaction/coordinator.js` | Each message is a task; offers tied to a proposal id and program version; side questions with a reminder; stop, abort, undo across tasks; revisions and proposal questions (intent v3); task events. |
| Routing (intent to one action) | done | `harness/intent.js` | The app pins intent v3 (answers and relations); the harness default stays v2 until `m3-intent-v3-dev`. Off-topic gets the generic redirect. |
| Scope from the cursor | done | `src/interaction/scope.js` | field, block, statement, stack, program. |
| Answer words and keys | done | `commands.js`, `src/util/assistant_keys.js` | yes, all, stop, undo, repeat, go there; Alt+Shift+Y/A/N/U/R, Escape, a Ctrl tap, Ctrl+Shift+I. Loose or misheard answers through intent v3. |
| Navigation lock | done | `src/util/navigation_lock.js` | Frozen while working, read-only while waiting for an answer. |

### Workspace and runtime

| Part | Status | Where | Notes |
|---|---|---|---|
| Blocks, cursor | done | Blockly 11.2.2 | The cursor follows each applied step and goes back on undo (decided 2026-10-29). |
| Run program | done (host) | `test/acblock/js/main.js` (`runSilently`) | The plugin never evals code; the host passes `execute`. The agent can't run programs yet (A6). |

### Learning features

| Part | Status | Spec | Notes |
|---|---|---|---|
| Question block (4.3) | done | `specs/question-block.md` | Shapes, answering, attempt gate, teacher tools, quiz locks, Run assessment, task XML. |
| Hidden reference answer | done | `specs/hint-choices-and-scaffolds.md` | Never sent to a model. Travels to the browser inside the task file today (see next step 1). |
| Interactive hint, choices (4.4) | done | same | |
| AI hints | done | `harness/hint.js` | Ratings pending. |
| Structured scaffold (4.5) | partial | same | Teacher dialog, spots, ranking and validation done; the agent part is still the fake; not reachable through the assistant. |
| Focus magnifier (4.2) | not started | | |
| Adaptive verbosity (4.6) | partial | | Learner level exists; only a word limit (50, or 100 for "more"). No verbosity setting, no example playback. |
| Interactive output (4.7) | not started | | An output focus shortcut exists; no link from an output line to its block. |

### AI agent layer

| Part | Status | Where | Notes |
|---|---|---|---|
| Agent server | done (milestones 1 to 3) | `server/`, `specs/agent-server.md` | Calls, guard, events and sessions, logs and reports. Milestone 4 (cache) deferred, milestone 5 (policy on the server) is next. |
| Program view | done | `context/snapshot.js` | Short ids, stack letters and names, cursor (block, field or empty workspace), question purpose only. |
| Editor ops and plans | done | `editor/ops.js`, `editor/plan.js` | Dry run on a copy, all or nothing, rechecks remaining steps; new stacks and stack names. |
| Comprehend (3.1, 4.1) | done | `harness/comprehend.js` | Waiting for your ratings. |
| Debug (3.2) | partial | `harness/debug.js` | 29/30 and 28/30 on dev. Goal sources not built (A3). |
| Edit (3.3) | partial | `harness/edit.js` | 20/20 and 19/20 on dev. Edit v5 (new stacks, names) pinned in the app, waiting for `m3-edit-v5-dev`. No "which change first", no Guided mode (A4). |
| Search | done | `harness/search.js` | Code answers a unique exact hit with no model call. |
| Speech and learner-work guardrails | done | `guardrails/` | Length, ids, markdown, visual references, applied claims, impossible places; question blocks and answers are off limits. |

### Language model via AI guardrails

| Part | Status | Notes |
|---|---|---|
| G1 personal data masking | done | `server/src/guard/`: patterns, cue phrases and bert-base-NER; restored in replies; calls, events and logs masked. `m3-guardrails-dev` waits for your run. |
| G1 stay on task | partial | The intent model decides off-topic (distress and personal topics included) on masked words; generic redirect. A gate on the way out is deferred (decided 2026-10-29). |
| G1 no training on student data | done | Every OpenRouter request sets `data_collection: "deny"`. |
| G1 sensitive disclosures | partial | Treated as off-topic; no teacher flag for now (decided 2026-10-29). |
| G2 activity policy | partial | Quiz rules fixed in code (browser only); Whole plan set by the teacher. Per-action teacher settings and the server check not built. |
| G2 no answers in gaps, attempt before hint, explain before fix | done | |
| G2 reliance signals | partial | `npm run logs:report` in `server/`; no teacher view. |
| G3 grounded, validate before offering | done | |
| G3 no unverified claims | partial | "I changed it" claims are blocked; "it works" claims are not (A6). |
| G3 consistency | done | Low temperature, in-memory cache per page session; the server cache is deferred. |
| G4 AI always identified | done | An earcon before every AI reply; the AI voice (Kristin) differs from the system voice. |
| G4 logs | partial | Calls, results, sessions and events in `server/data/agent.db`, text masked; export, wipe, report. No teacher review view. |
| G4 educator control per learner | not started | Policy is per task (A9). |
| G5 accessible output | done | Speech guardrail; structural places only. |

### Output manager and output modalities

| Part | Status | Notes |
|---|---|---|
| Output manager | done | `src/output/`: one timeline for AI, navigation speech and earcons; priorities, epochs, the freeze cue. |
| Screen reader mode | done | AI replies with the AI earcon. |
| Synthetic voice mode, distinct AI voice | done | Navigation on system voices, the AI voice Kristin played by the page (so echo cancellation works). |
| Audio cues | done | connected, rejected, entered and left a stack, sent, listening, blocked, error. |
| Visual display (magnify, highlight) | not started | Focus magnifier (4.2). |

### Teacher / TVI

| Part | Status | Notes |
|---|---|---|
| Task policy (activity, Whole plan, learner level) | done | Saved in the task XML. |
| Teacher mode, task tests, export and import, teacher guide | done | Tasks move as files; server-side tasks are next step 1. |
| Logs and reliance signals | partial | Stored and reported on the server; no teacher view. |

### Outside the diagram

| Part | Status | Notes |
|---|---|---|
| AI literacy modules (section 6) | not started | Module 1 can use "Log payload"; module 5 needs "which blocks came from the agent" (the events now record applied steps). |

## 2. Evaluation

Plan: `specs/evaluation-and-harness.md`, milestones in its section 13. 212 dev items.

| Milestone | Status |
|---|---|
| 1. Runner, items, scorers, replay | done |
| 2. Baseline (raw arm) | smoke run done; the 3-run baseline on dev is still to run |
| 3. Harness arm | done for every task; runs through the server's guard |
| 4. Tools arm (program runner, static checks, roles) | not started |
| 5. Prompts | debug v4, edit v4 (v5 built), comprehend v2, intent v2 (v3 built), search v2, hint v2, comprehend-proposal v1 |
| 6. Judges and your ratings | not started (your ratings first) |
| 7. Freeze the eval set and run all arms | not started |

Latest dev results:

| Run | Result |
|---|---|
| `m2-harness-dev-2`, `-3` | debug 29/30 DeepSeek, 28/30 GPT; edit 20/20 and 19/20 |
| `m2-comprehend-dev` | 38/38 pass the code checks; quality waits for your ratings |
| `m2-intent-search-hint-dev` | intent 39/40 (Mercury); search 9/10 for both models; hints wait for your ratings |
| `m2-intent-mercury-none` | 35/40 with reasoning off, so low effort stays |

## 3. Waiting for you

- **Eval runs** (build first: `npm --prefix server run build`, `npx webpack --config eval/webpack.config.cjs`; `npm run models` once in `server/`):
  - `m3-intent-v3-dev`, `m3-proposal-dev`, `m3-revision-dev`: decide whether intent v3 becomes the default;
  - `m3-edit-v5-dev`: decides edit v5 (new stacks, names);
  - `m3-guardrails-dev`: masking and off-topic, distress included.
  - Skipped earlier and still useful: `m2-harness-dev-4`, `m2-comprehend-dev-2`.
- **Human evaluation**, all in one go (list in `specs/evaluation-and-harness.md`): comprehend sheet, hint ratings, search places, new item key points, dev item review before freezing, judge calibration.
- **Real-use checks:** your voice on speakers (Kristin, barge-in, misheard answers, focus), new stacks and the cursor moving after each step, the Chromebook check (echo page, Ctrl+Shift+I against DevTools).
- **Old log:** `server/data/agent.db` holds 34 calls from before masking. Export if wanted, then `npm run logs:wipe -- --yes`.
- **Offers still open:** delete the speech comparison models in `tools/` (4+ GB); build the phonemizer ourselves instead of the prebuilt one.

## 4. Design documents

| Document | Covers |
|---|---|
| `ai-system-design.md` | the AI agent layer, browser and server split, context management |
| `voice-interaction-flow/voice-interaction-design.md` | voice, interruptions, freeze, voices, keys |
| `task-coordinator-design.md` | tasks, revisions, consent, receipts, events |
| `output-manager-design.md` | speech queue, routes, epochs, earcons |
| `specs/harness-context.md` | task context, ops in words, intent v3, proposal questions, revisions |
| `specs/task-coordinator.md` | coordinator, events, answer keys, navigation lock, the cursor after steps |
| `specs/output-manager.md` | queue, routes, earcons, AI voice |
| `specs/voice-interaction.md` | sherpa-onnx engines, conversation controller, drafts, interruptions, idle |
| `specs/agent-server.md` | server API, guard, events, logs, milestones |
| `specs/evaluation-and-harness.md` | eval plan, items, scorers, runs, human evaluation list |
| `specs/question-block.md`, `specs/hint-choices-and-scaffolds.md` | question blocks, hints, scaffolds |

## 5. Plan (approved 2026-10-29)

From the lead review (`reviews/lead-review-2026-10-29.md`, findings D1 to D8 and I1 to I11). The research runs in stages *(decided 2026-10-29)*: (1) eval set and initial system, **now**; (2) eval set with expert evaluation; (3) refine the system; (4) participatory design with teachers (authoring, hint-based learning, guardrails); (5) learner study. The empirical study compares {a model, a fine-tuned edge model} x {same prompt, same prompt plus harness}, plus a minimal prompt; frontier models fill the model row until the fine-tuned model exists. Lab machines only. The project owner commits; agents never do.

**Focus now** *(decided 2026-10-29)*: the functional system, built as well as we can, plus the study spec. The study work in code (P4 to P7) waits until you prepare the 2x2 data; the frozen prototype stays as it is, unused. The freeze for the study comes after the features below. Every new prompt version needs your agreement and an eval run you approve.

| # | Item | Owner | Status |
|---|---|---|---|
| P2 | `system-design.md`: the System Design Document in Markdown, brought up to date by interview, becomes the source of truth (the .docx stays as the original); specs reconciled (one status line each, stale parts fixed or marked superseded); a deviations record; the eval results log split out | Lead | approved, in progress |
| P3 | Study design spec `specs/empirical-study.md` (models now: DeepSeek v4.1 Flash and GPT-5.6 Luna Pro, Mercury 2.5 for intent) | Lead with Co-Architect | approved |
| P4 | Eval integrity: strict scorers, provenance, end-to-end timing, pass^3 and clustered intervals. No eval runs until you approve them | Lead Developer, QA | approved, waits for the 2x2 data |
| P5 | Study arms: prompt only, prompt plus harness, minimal prompt (you approve its text), built when you prepare the 2x2 data | Lead Developer | approved, waits |
| P6 | Eval set: about 30 reserve programs, your review, frozen; the current 5 eval programs for the expert evaluation | Lead, Lead Developer, you | approved, waits |
| P7 | False-yes items; intent v3 promotion needs 0 false yeses | Lead Developer | approved, waits |
| P8 | Speech checks on debug and edit spoken text; a step is spoken from its ops (code), not the model's title | Lead Developer, QA | approved |
| P9 | One bounded program runner (spec, then a worker executor for Run, assessment and the eval) | Lead, Lead Developer, QA | approved |
| P10 | AI replies through the screen reader (setting) | UI/UX, QA | approved |
| P11 | Voice privacy edges (no network voice; mic off stops all capture) | QA | approved |
| P12 | Learner-facing assistant panel: spec, then rebuild; includes an interactive step list (explore each step by keyboard, hear its exact description, Enter applies steps in order, each step shows its status) | UI/UX with Lead, QA | approved |
| P13 | Focus magnifier (4.2) | UI/UX | approved |
| P14 | Edit: which change first, and Guided mode (3.3) | Lead Developer, UI/UX | approved, spec first |
| P15 | Debug root cause (3.2): run the program with the teacher's test inputs and compare the outputs; compare with the teacher's correct program by code; static analysis hints for the model. The correct program never reaches the model or the learner | Lead Developer | approved, spec first, needs P9 |
| P16 | No "it works" claims without a run (G3) | Lead Developer | approved, needs P9 |
| P17 | Interactive output (4.7) | Lead Developer, UI/UX | approved, spec first, needs P9 |
| P18 | Adaptive verbosity (4.6) | Lead Developer | approved, spec first |
| P19 | Search as the fourth action; "go to X" moves the cursor at once on one clear match, asks on several; "find" or "where is" only tells where | Lead Developer | approved, spec first |

**Decided 2026-10-29 for the design document:** connection is not a comprehend scope (a cursor on a connection means its block; connections matter only for where an insert goes in edit mode); the assistant is "the AI helper (Neon)", with the name configurable in the prototype; a task's goal means the program, when run, accepts valid input and gives valid output; "debug goal" is renamed root cause (P15).

**Later:**
- After participatory design (stage 4): agent server milestone 5 (tasks, hints and policy on the server, hidden references out of the browser), activity policy per action, the teacher view, scaffolds through the agent, the server cache (milestone 4, deferred), per-learner control.
- When the fine-tuned model starts: the fine-tuning pipeline and a local OpenAI-compatible provider (a lab laptop service, Ollama or llama.cpp).
- Before the learner study (stage 5): distress handling with the IRB, the masking data policy, real device and screen reader checks, consent and learner codes.

## 6. Audit against the design

Each finding names the design rule and what the code does now.

- **A1. Guardrails as a layer.** *Resolved 2026-10-29* (agent server milestones 1 and 2): every call goes through the server, masked; OpenRouter requests deny data collection.
- **A2. AI speech identified.** *Resolved 2026-10-28* (output manager): an earcon before every AI reply, a distinct AI voice.
- **A3. Debug has no goal source.** The design names three: the lesson's stated goal, a hidden reference program the agent may run but never reveal, and the learner's objective in practice. Today `wrongResult` comes only from the learner's words. A safe reading of the reference rule: code runs the reference and only the difference in output reaches the model, never its blocks. Next step 4.
- **A4. Edit rules.** No "which change first?" for an instruction with several changes; no Guided mode. Next step 3.
- **A5. Quiz policy differs from the design default** (approved): we also allow field scope, search and the question's help in a quiz.
- **A6. Unverified claims.** Debug v4 says "the program looks right" without running it, and comprehend could describe output it never saw. Next step 9.
- **A7. Keyboard commands.** *Resolved 2026-10-28* (assistant keys).
- **A8. Logs.** *Resolved 2026-10-29* (agent server milestone 3): logs and reliance signals stored and reported. Distress is off-topic with no log entry, by decision.
- **A9. Per-learner control.** Policy is per task. Next step 10.
- **A10. Comprehend scopes.** The design lists a connection as a scope; a cursor on a connection is explained as its block. Noted.
- **A11. Module dependencies.** `src/agent/` imports from `src/blocks/`, and question blocks call the agent through `AgentServices`. Matches the diagram in spirit.
- **A12. Cache per page session.** The same question can get a different answer after a reload; the server cache that would fix it is deferred.
- **A13. Hidden references reach the browser.** A quiz's reference answers are inside the task file the browser loads, so a learner could find them. Next step 1 keeps them on the server.
- **A14. Cursor moves.** G5 says the cursor never moves without the learner's action. Decided 2026-10-29: it follows a step the learner approved (and goes back on undo), and the reply says where it is.

What matches the design well: learner-controlled execution, explain before fix, validate before offering, no answers in gaps, attempt before hint, hidden references never in prompts, speech-ready replies with structural places, personal information masked before any model, the AI identified, and a headless agent core behind one client contract.
