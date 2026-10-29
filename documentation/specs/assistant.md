# Assistant in the app (harness wiring)

Status: built 2026-10-20. **Superseded 2026-10-28** by `task-coordinator.md` (`src/interaction/coordinator.js`); `assistant.js` is removed. Kept as the record of the first wiring. Replaces the prototype `AgentController` in the test app with the harness. Checked with unit tests and in the browser with the model stubbed (typed requests and buttons); the voice path is wired the same way but not yet tried with speech.

## Scope

- A headless conversation module, `src/interaction/`, routes each request through intent to a harness action, holds an offered fix or plan, applies it step by step, stops, and undoes. It replaces the prototype's `pendingFollowUp`.
- The Neon panel, chat and voice stay; they call the new module instead of `AgentController`. Output redesign (AI earcon, a distinct AI voice) is a later step.
- The prototype (controller, actor, input and prompt builders, v1 prompts) moves to `eval/runner/baseline/`, out of the plugin bundle. The raw eval arm still runs it live.

## Requests

- Intent v2 on the intent model (Mercury by default, `intentModel` in `config.local.js`) routes every request that isn't an answer word (below).
- Scope comes from the cursor: a field is field scope, a plain statement block statement, a value or container block block, no block program. Clear words widen it: "program", "whole thing", "everything" give program; "stack", "this part" give stack.
- Off-topic gets the fixed redirect from code. A clarifying question is spoken, and the learner's next reply is routed together with the earlier request (one turn of memory). An edit reply with no steps that ends in a question works the same way, but goes straight back to edit.
- Hint: with the cursor on a question block or an answer to one, the assistant opens that question's help (the popover's hint flow: attempt before hint, levels, teacher limits). Elsewhere it asks the learner to move to the question first.
- Search: the found block is spoken; "go there" moves the cursor to it. The cursor never moves otherwise.
- Answers are cached in memory per page session, keyed by action, prompt version, model, program state, scope, cursor and words.

## Learner-controlled execution

- Debug explains first. Saying yes asks for the fix, which is then presented as a step to confirm.
- Step-confirm by default: each step is spoken ("Step 2 of 3: ..."); yes applies it; the next step follows. A step that no longer fits the program (it changed) ends the plan with a short note.
- Whole-plan ("all") only when the task policy allows it (`wholePlan`, set by the teacher in teacher mode, saved in the task XML as `whole-plan="true"`, off by default).
- Stop ends the plan. Undo takes back one applied step at a time, newest first, each on its own request, and only when nothing else changed since that step; otherwise it says so (the editor's own undo still works).
- Answer words are matched in code, as whole replies: yes (yes, yeah, okay, sure, do it, go ahead, next), all, stop (stop, no, cancel, never mind), undo, repeat (repeat, again, say that again), go there. The same commands are buttons in the chat. Anything else is a new request; an offered plan stays until stop or a new debug or edit request.

## Quizzes

In a quiz the assistant only explains at field or block scope, finds blocks, and opens a question's help; anything else gets a short note that it's off during the quiz. Teacher-adjustable policy comes with the guardrails step.

## Hints through the harness

`HintRequest` also carries the gap id, and `generateHint` runs the harness hint (program view, level and speech checks, one repair round). `AiHintService` keeps its cache, level checks and fallback. Scaffolds still use the fake.

## Without a key

With no API key, or `testing: true`, the assistant uses an offline client with short canned replies (no network), and hints and scaffolds use the fake services. Browser checks stub `config.local.js` or the OpenRouter route and never call the real model.
