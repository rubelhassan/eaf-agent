# Feature spec: Question block (System Design §4.3)

Status: **APPROVED 2026-09-28, built** (M1 to M4). Overall status: `../project-tracking.md`. Items marked *(default)* were proposed by the agent and approved with the spec.

## 1. What it is

A placeholder block labelled **`?`** that marks a gap the learner must fill: a tutorial step, a "think about what goes here" prompt, or a quiz item. It carries a configuration set by the teacher: what kind of gap it is, which blocks are intended, a spoken prompt, an instruction, and hints. Whole-program checks are task tests (§7), not part of a question.

## 2. Question block: shapes, answering, and memory *(redesigned 2026-09-28, second iteration)*

### 2.1 Look (Blockly-aligned)

- Both questions use the **gold** from documentation/rough_idea.png (`#EAC452`), one colour for every question block. Both sit in their own gold **Hint** toolbox category (value question first, then statement). The category exists only in teacher mode.
- A white round **`?` chip** with the sketch's blue "?" (`#2854C5`, about 7:1), followed by an empty **slot**, and a **dark-gold dashed outline** (`#7A5C0E`, 2 px) that keeps the block visible on the white workspace. *(Option B chosen at review, 2026-09-28; answered blocks keep a marker in their own colour.)*
- The earlier hexagon ("diamond") face is kept for later use (e.g. quiz prompts) in `src/blocks/assets/question_face.js`. It is not used by this block.

### 2.2 Fixed shapes

- One `question` type; the toolbox entries preset `expects` via `extraState` (`value` in Logic, `statement` in Text). Sequence is a statement question configured by the teacher.
- Shapes are fixed: no live reshaping and no context-menu toggle. A value question fits value sockets and a statement question fits stacks, like any block.

### 2.3 Answering: the question vanishes, the answer docks, the question is remembered

- **Main path (slot).** The learner drops or inserts a block into the question's slot. The question **vanishes** (a 250 ms fade and shrink, instant if the system asks for reduced motion), and the answer **docks where the question was**: in the `if` condition for a value question, or in the stack (keeping the blocks above and below) for a statement question. A stack put in a sequence slot docks as a whole. A loose question leaves its answer where it stood. Screen readers hear "Question answered with a compare block." (or "… with 2 blocks.").
- **Fallback (the question's spot).** Dropping or inserting onto the socket that holds a value question, or directly above or below an empty statement question, also answers it (instead of knocking the question out, or leaving it in place with the block under it). The "below" case was added after a learner test (2026-09-29): drops that landed a little low attached under the question, so it was never answered.
- **Memory.** Each answer block carries the question (gap id + config) in its Blockly `data` (undoable custom event; copies don't inherit it). It shows the same **`?` chip** at its top-right corner, with a hover tooltip "Question: <prompt>". Focus adds "Answers a question.", and Enter reads the question's details.
- **Joining (statement/sequence).** Blocks placed directly below an answer block (or above the first) join the gap and get the chip.
- **Removing.** Answer blocks that are deleted or dragged away lose their marker. When a gap loses all its answers, the **question comes back** in that spot, and screen readers hear "The question is open again."
- **Rules.** Blockly's own compatibility checks apply first. Intended-type rules are an extra layer on the slot and the fallback spots, with the spoken reason and flyout disabling (§3).
- **Teacher mode.** No vanishing: a question's slot simply holds the block (the question then generates exactly the answer's code).
- Generic mechanism: custom types plug into navigation, speech, the flyout, and the connection checker through the block registry (`src/blocks/registry.js`). The only stable-file hook is `blockTypes.prepareConnect` in `Navigation.tryToConnectMarkerAndCursor`, kept as a generic extension point.

## 3. Intended block types, compatibility, satisfaction

- `intendedTypes`: a list of exact block type ids (e.g. `logic_compare`, `logic_operation`), picked by the teacher from the toolbox catalog. It is optional.
- **Compatibility (all learners)** *(changed at M4, 2026-09-28)*: intended blocks never block an insert. Any shape-compatible block may go into a gap, by mouse or keyboard, and the Edit-mode flyout shows every compatible block (not only the intended ones), so the learner still has to think. A non-intended answer is **accepted but doesn't fit yet**. The connection checker only refuses structural cases: a question inside a question ("A question cannot answer another question."), a second block in a quiz statement gap ("This question takes just one block."), and quiz locks.
- **Satisfaction** is structural and based on the top-level answer blocks only; their own inner inputs may still be incomplete:
  - value: the gap holds a block whose type is in the list (or any block if the list is empty).
  - statement: **practice** is satisfied while at least one top-level block matches; other blocks of any type may accompany it. **Quiz** takes exactly one block, which must match.
  - sequence: every top-level block must match the list, and there must be at least `minBlocks` (default 1).
- Answer states: `empty`, `satisfied`, `mismatch` and `not-enough` (together: "doesn't fit yet").
- **Doesn't-fit feedback (practice only; a quiz never reveals fit, the teacher sees it when assessing):**
  - Spoken on placing: "Placed a true or false block. This doesn't answer the question yet. It needs a true or false value, like a compare block. Press Enter on it for hints." (the last sentence only when the question has hints).
  - Focus on the answer adds "It does not fit yet. It needs …".
  - The answer's chip becomes an orange **!** (tooltip "Doesn't fit yet. It needs …").
  - The popover gets a **Your answer: Doesn't fit yet. It needs …** row.
  - A misfit counts as a first try, so hints unlock.
- The "needs …" phrase is derived from the intended blocks' output type (Boolean → "a true or false value", Number → "a number", String → "text"). For statements it's derived from block names ("a print block"). The teacher can override it.

## 4. Recommendation: suggested blocks, marked in place *(decided at M2 start, 2026-09-28)*

- **Beginners only** *(changed at M4)*: other learner levels get no suggestions, so the star doesn't give the answer away.
- The toolbox is never restructured. While the keyboard **marker** (or, without a marker, the **cursor**) is on a question's spot, meaning its slot, the socket holding it, or the connection right above a statement question, the question's intended blocks count as **suggested**:
  - Flyout speech: "Move to item compare, suggested, under Logic category".
  - Category speech: "Move to next category: Logic, has suggested blocks".
  - Visual: a small star marker on suggested blocks in the open flyout.
- No intended types means no suggestions.

## 4b. Keyboard Edit mode on a question *(added 2026-09-29, before the first commit)*

- Learner mode: a question is edited as a whole. Pressing **E** on it:
  - makes its dashed outline turn the Edit-mode red (`#FF5722`) and blink on the same 1.5-second rhythm as the Edit-mode connection indicator;
  - says "Entering edit mode on question block. Press T to pick a block that replaces this question, or E to leave Edit mode."
- While Edit mode is on the question, moving between its connections is refused with the same hint: W/S/A/D/F/Q, disconnect, paste, and move-statement up/down. T, E, Enter (the popover), C, Esc and undo still work.
- The toolbox offers only blocks that can replace the question at that spot. Everything else is disabled by the existing compatibility filter.
- After a block is inserted, Edit mode continues on the new block as with any insert, and the question (with its blinking) is gone.
- Teacher mode is unchanged: the teacher can move into the slot to build the reference answer.
- Mechanism: the registry hooks `onEditTarget(block, editing)` and `editLock(block)`. `NavigationController` watches the cursor's `editMode` and `editingBlock` (`util/observe.js`) and wraps the movement shortcuts.

## 5. Focus, speech, popover *(decided at M2 start)*

- **Focus** (keyboard cursor) on a question block speaks the short line only: "Question. Needs a true or false value." Beginners also hear "Press Enter to open the question." On a block that answers a question, the normal description gets "Answers a question." (+ the same hint for beginners). No popover on plain focus.
- **Enter** on a question block or on an answer block, or a **mouse click** anywhere on either (chip and empty slot included; not a drag), opens the **question popover** and moves keyboard focus into it.
- **Popover layout:** a vertical list of rows:
  1. Needs: <need phrase>
  2. Prompt (if any)
  3. Instruction (if any)
  4. Hints: [Previous] "Hint n of m" / locked message [Next]
  5. [Hear all] [Close] (M3 adds [Edit question] for teachers)
- **Keys inside the popover** (same model as the workspace):
  - W/S move between rows, and each row is read on arrival.
  - A/D move between the controls within a row.
  - F goes into a row's detail (the list of revealed hints; W/S between hints there), and Q comes back out.
  - Q at the top level, or Esc anywhere, closes the popover and returns focus where it was.
  - Enter activates a button. Tab/Shift+Tab also work.
  - Popover keys never reach the workspace shortcuts.
- **Placement:** anchored to the block like a **tooltip**: just below it (above if there's no room below), with an arrow pointing at the block; it follows the block on scroll and zoom and may cover nearby blocks while open. *(Decided at M2 review.)*
- It is a non-modal dialog (`role="dialog"`, labelled "Question"), made of real buttons, with a polite live region for hint text. It closes if its block is removed or the question vanishes.

## 6. Static hints (G2 attempt-before-hint) *(attempt decided at M2 start)*

- An ordered list of the teacher's hints, revealed one at a time with [Next] ("Hint 1 of 3: …"). [Previous] re-reads earlier ones.
- **Unlocked after the question has been answered once** (any block put into its slot or spot), not after a timer. Until then the hint row is visible and reads "Hints unlock after your first answer.", with Next disabled.
- The attempt flag and the number of hints revealed are session state per question (kept while a question is answered, removed, and restored). They are not saved in task XML. Loading a task whose questions are already answered counts as attempted.

## 6b. AI hints *(decided 2026-09-28)*

- **Teacher control (per question, in Edit question → Hints):**
  - **AI help allowed:** Off / up to Nudge / up to Point / up to Show the kind.
  - **How many** AI hints (1 to 5).
  - An optional **note for the AI** (e.g. "focus on greater than").
  - **Allow in quizzes** (off by default; in a Quiz task, AI hints are off unless this is checked).
- **Levels** (never beyond the ceiling; never the full answer or filling the gap, G2):
  - **Nudge:** a guiding question, no block names.
  - **Point:** names the concept or category, not the exact block.
  - **Show the kind:** names the block and what goes in it, without exact values or the finished answer.
- **Learner ladder:** written hints first. After those, each Next hint asks the AI for one step more help (Nudge → Point → Show the kind), staying at the ceiling once reached, up to the allowed count. The attempt-before-hint gate applies to all hints.
- **Generation:** the plugin asks a host-provided **hint provider** (`attachCustomBlocks(ws, {hintProvider})`). The test app wires it to the agent (versioned prompt `hint.v1` at first; since 2026-10-20 the harness hint, hint v2, through the agent server). The request carries the question (prompt, instruction, need, intended blocks), the program as code with the gap marked, the learner's current answer, the hints already given, the level, the learner level, and the teacher's note.
- **Output checks:** plain speech-ready text (no markdown or emoji), short (≤ 2 sentences), no code. Below "Show the kind" it must not name an intended block. A failed check retries once, then falls back to a safe generic hint.
- **Consistency:** the same question state at the same level returns the same hint (session cache). With no API key, canned hints per level are used.
- **Identification (G4):** always shown and spoken as "AI hint n of m: …". While generating, the popover says "Thinking of a hint…".
- **Persistence:** `<ai level="point" count="2" quiz="false">note</ai>` inside the question's `<mutation>`; `ai` in extra state.

## 7. Run and task tests *(decided at M4, 2026-09-28)*

- **Learner Run** always runs the program (an empty question generates neutral code) and never runs tests. It first shows a compact note in the output panel, also spoken while keyboard navigation is on:
  - empty questions first: "Note: 2 question blocks are not answered yet.";
  - only when none are empty (practice only): "Note: 1 answer does not fit its question yet."
- **Task tests** are teacher-only and belong to the task, not to a question (a test runs the whole program). Each test has inputs (answers to prompt blocks, in order) and expected output lines, which must be printed **in that order**. Other printed lines are allowed. Lines are trimmed and case-sensitive. There can be several tests.
- **Assessing a learner's work:** the learner uses **Settings → Save my work** (downloads the workspace with answers, activity and tests). The teacher opens `?teacher=1`, uses **Import task XML**, and presses **Run**. After the normal run, the output panel shows an **Assessment** (the summary is also spoken while keyboard navigation is on):
  - "Questions: 1 of 3 fit.", then one line per question in program order: location ("inside block 2 of stack A"), prompt, and `fits` / `empty` / `doesn't fit: got a true or false block. It needs …`. A teacher's worked answer in a question's slot is judged the same way, so teachers can check a reference solution.
  - "Tests: 1 of 2 pass.", then one line per test: `pass`, or `fail.` with the reason: expected line not printed (plus what was printed), "ran too long" (over 100,000 loop steps or 1 second), "asked for more inputs than the test gives", or "stopped with an error: …".
  - Tests are skipped while any question is empty ("Tests skipped: 2 questions are empty.").
- The plugin never runs code: `QuestionBlock.assess(workspace, {execute, locate})` takes the host's `execute(inputs) → {lines, error?, outOfInputs?, timedOut?}`. The test app's `runSilently` generates JavaScript with a loop trap, stubs `window.prompt` and `console.log`, and restores them afterwards.
- Known limits: tests can only say which lines must appear, not which must be absent. The tests travel inside the task file, so a learner who opens the file could read them.

## 8. Teacher tools *(decided at M3 start, 2026-09-28)*

- **Teacher mode** is a Settings switch that only appears when the page is opened with `?teacher=1`, so learners never see it. Opening that URL **starts in teacher mode** (`?author=1` still works), shown by a green **Teacher** badge with a chalkboard icon above the settings gear, or a grey **Learner** badge with a graduate icon when switched off. Screen readers hear the mode in the workspace label. To try a task as a learner, turn Teacher mode off.
  - **On:** the **Hint** category (both question blocks) is shown; question blocks are ordinary blocks (their slot just holds a block, nothing vanishes); nothing is locked; Settings also shows Activity (Practice/Quiz), Export task and Import task.
  - **Off (learner):** the Hint category is hidden; question blocks can't be moved, deleted, or copied, only answered.
- **Edit question** (modal form): opened from the popover's **[Edit question]** button (teacher mode only), and automatically when a teacher **places a new `?`** from the toolbox (keyboard insert or drag). It is an accessible modal dialog: focus is trapped, Esc cancels, and Save applies all changes as one undoable step. Fields:
  - **What goes in the question block:** only the kinds that fit the block are enabled. A value question is always "a value"; a statement question is "one statement block" or "a sequence" (+ minimum blocks for a sequence).
  - **Intended blocks:** two dropdowns, **Category** (Logic, Loops, Math, …) and **Block** (that category's blocks shown as their toolbox pictures; a custom listbox, since a native select can't show images. Screen readers hear the readable name; Up/Down/Home/End move, Enter/Space choose, Esc closes only the list), plus **Add**. Chosen blocks are listed as compact chips with a rendered snapshot and a Remove button; the type ids are stored.
  - **Need override** (optional), **prompt**, **instruction**.
  - **Hints:** an ordered list with add, remove, move up, move down.
- **Task tests…** (Settings, teacher mode): a modal like Edit question listing the tests (Inputs, Expected output, Remove test, Add test), with **Cancel**, **Run tests** (saves, closes, and runs the assessment) and **Save**. A test without expected output is dropped on save. See §7.
- **Activity** (task level, teacher mode): Practice or Quiz, stored as `activity="quiz"` on the root `<xml>`; practice when absent.
- **Quiz locks (learner mode):** every block that belongs to the task (loaded with it, or added in teacher mode) can't be moved, deleted, or edited, fields included. Learners can only answer questions and change what is inside their answers. Attaching new blocks to task blocks is refused except at a question. Loose scratch blocks are allowed but can't join the program.
- **Export task XML** (download) saves a **clean task**: a copy of the workspace in which every answered question is turned back into its empty question (answer blocks removed), with the question configs and the activity setting. The live workspace is untouched. Other learner edits (e.g. a changed field in practice) are kept.
- **Import task XML** (file) asks "Replace the current workspace?", loads with rules suspended, and applies the file's activity setting.

## 9. Learner level

- **Settings → Learner level:** beginner / intermediate / advanced, default beginner. Saved per browser in localStorage (M2).
- For now it only changes feedback detail: suggested blocks (beginners only), the focus-speech suffix, and popover detail.

## 10. Persistence format

**JSON, copy/paste and undo:** the config is Blockly extra state (`saveExtraState` / `loadExtraState`):

```json
{
  "v": 1,
  "expects": "value",
  "minBlocks": 1,
  "intendedTypes": ["logic_compare", "logic_operation"],
  "needLabel": null,
  "prompt": "Check if the goat is heavier than the limit.",
  "instruction": "Compare the goat's weight with the bridge limit.",
  "hints": ["Which block compares two numbers?", "Look in the Logic category."],
  "ai": { "level": "point", "count": 2, "note": "", "allowInQuiz": false }
}
```

**XML (task files):** Blockly 11's XML serializer ignores extra state. So the block also implements `mutationToDom` / `domToMutation` with a readable, hand-editable `<mutation>` (`src/blocks/question/xml.js`):

```xml
<block type="question">
  <mutation expects="value" min_blocks="1">
    <intended type="logic_compare"/>
    <intended type="logic_operation"/>
    <prompt>Check if the goat is heavier than the limit.</prompt>
    <instruction>Compare the goat's weight with the bridge limit.</instruction>
    <hint>Which block compares two numbers?</hint>
  </mutation>
  <value name="ANSWER">…the learner's answer…</value>
</block>
```

Task level, on the root `<xml>` element, read and written by the task loader and exporters: the activity policy as an `activity="quiz"` attribute, and the task tests as

```xml
<tests>
  <test><input>120</input><output>Too heavy! Wait for the next bridge.</output></test>
</tests>
```

A per-question `<check>` from before M4 is ignored.

Loading a file suspends the gap rules (`withConnectionRulesSuspended`), because the rules constrain learners, not what a file may contain. A mismatched answer in a file still loads and reads as "does not fit yet".

## 11. Code generation

- An unanswered placeholder generates neutral code (a value placeholder such as `null`/`None`/`nil`, or a "question not answered yet" comment) in JavaScript, Python, PHP, Lua and Dart, so the code panel and Run stay valid (Run warns about empty questions, §7).
- Answers are ordinary blocks and generate their own code; a bound answer runs exactly like the same block without a question.

## 12. Architecture

As built (✓) and planned (later milestones):

```
src/blocks/                       reusable custom-block framework
  index.js              ✓         registerCustomBlocks({generators}) → {connectionChecker}; attachCustomBlocks(ws); exports
  registry.js           ✓         CustomBlockType contract + dispatch (describe, focusText, focusSuffix, activate,
                                  prepareConnect, canAdaptTo, isInsertCompatible, allowsConnection,
                                  explainRejection, installGenerators, attachAll, decorators)
  connection_checker.js ✓         checker composing registry rules; withConnectionRulesSuspended(); shape probes
  drag_group_fix.js     ✓         Blockly 11.2 undo-grouping workaround around drags (see below)
  effects.js            ✓         vanish effect (respects reduced motion)
  assets/question_face.js ✓       hexagon "?" face kept for later (quiz prompts); unused
  policy.js             ✓         per-workspace activity (practice/quiz), teacherMode, learnerLevel
  block_names.js        ✓         readable names for block types (speech, picker)
  question/
    index.js            ✓         the question's registry entry (+ decorator for answer blocks)
    model.js            ✓         config schema, defaults, normalization
    definition.js       ✓         Blockly definition, extra state, XML mutation, context-menu toggle, drag delegation
    shapes.js           ✓         fixed value / statement wrapper shapes, theme styles, "?" chip
    binding.js          ✓         answer ↔ question binding in block data + undoable BindingChange event
    tracker.js          ✓         GapTracker: dock (vanish) / fill / join / unbind / restore after each event batch
    badges.js           ✓         "?" badge overlay on answer blocks
    rules.js            ✓         attach contexts, compatibility, answer state, quiz exactly-one
    speech.js           ✓         need phrase, placeholder focus, answer suffix, details, rejection lines
    generator.js        ✓         neutral code for unanswered placeholders (JS, Python, PHP, Lua, Dart)
    xml.js              ✓         readable <mutation> XML codec
    session.js          ✓ M2      per-question attempt flag + revealed hints (session only)
    suggestions.js      ✓ M2      suggested blocks marked in place: speech notes + flyout stars
    ui/popover_model.js ✓ M2      popover keyboard model (W/S rows, A/D controls, F/Q in/out, Esc)
    ui/popover.js       ✓ M2      question popover (Enter/click on a question or an answer)
    task.js             ✓ M3      task blocks, loadTaskXml (activity + task marking), cleanTaskXml (clean export)
    locks.js            ✓ M3      learner locks: questions fixed; quiz locks task blocks; leaving teacher mode marks the task
    ui/question_editing.js     ✓ M3      opens the Edit question form (popover button, new ? from the toolbox)
    ui/question_dialog.js ✓ M3      modal Edit question form
    ui/snapshots.js     ✓ M3      toolbox catalog + rendered block snapshots for the picker
    ui/modal_form.js    ✓ M4      shared accessible modal shell (Edit question, Task tests)
    ui/block_select.js  ✓         block picture dropdown for the intended-blocks picker
    task_tests.js       ✓ M4      task tests: store, XML, in-order matching, run through the host's executor
    check.js            ✓ M4      question statuses, learner Run warning, teacher assessment report
    ui/task_tests_dialog.js ✓ M4  Task tests modal
labels_and_comments/location.js ✓ M4  spoken block location ("inside block 2 of stack A")
test/question_block.mocha.js  ✓   unit tests (npm test, headless Blockly)
test/acblock/                     host wiring: toolbox (question entries only in teacher mode ✓), Settings (learner level ✓,
                                  save my work ✓, teacher mode behind ?teacher=1 ✓, activity ✓, task tests ✓, export/import ✓),
                                  demo task ✓, Run: learner warning / teacher assessment + runSilently ✓
```

- Explicit init by the host: `registerCustomBlocks({generators})` before `Blockly.inject` (pass the returned `connectionChecker` as `plugins.connectionChecker`), then `attachCustomBlocks(workspace)`. There are no side effects at import time.
- **Blockly 11.2 workarounds** (`drag_group_fix.js`): a flyout drag leaves an event group open, and a drop's grid-snap/bump moves are fired without a group. Both broke "one learner action is one undo step". The fix closes the group after the drop settles and puts snap/bump moves into the drop's group. Re-check on any Blockly upgrade.
- **Known limitation:** in learner mode, building a stack in one go (e.g. a script creating a block and hanging a statement question below it in the same tick) looks like that block answering the question. Real drags of existing blocks don't trigger it, and learners don't place questions once M3 hides them; tests build fixtures as a teacher.
- **Stable-file change (one hook):** `Navigation.tryToConnectMarkerAndCursor` calls `blockTypes.prepareConnect(markerNode, cursorNode)` first. It sits there rather than in `insertFromFlyout` (as originally previewed) because insert, paste, and move-to-marker all funnel through it, and that function disposes whatever occupies a marked value socket. The redirect must run on all three paths.
- `navigation_controller.js`: Enter on a block goes to the registry's `activate` first (so no second hook in `navigation.js` was needed). Failed or disabled flyout inserts speak the registry's `explainRejection` reason. Also fixed an existing typo ("s…is disabled").
- `util/flyout_compatibility_manager.js`: asks `blockTypes.isInsertCompatible`, so adaptable blocks stay enabled for any target, and sockets holding a question are judged by its structural rules (every shape-compatible block stays enabled, M4).
- Speech goes through the existing `Speech` (`#blockReader` live region). `Speech.blockToText` falls back to the registry's `describe`, and `updateBlockReader` uses its `focusText`.

## 13. Out of scope (this iteration)

- AI agent awareness of question blocks (deferred). *(Done since 2026-10-20: the agent sees a question's prompt and kind only, never its reference or intended blocks, and its plans can't touch question blocks or answers; `src/agent/guardrails/learner_work.js`.)*
- Interactive hint blocks (§4.4) and structured scaffolds (§4.5).
- Teacher dashboards and reliance signals.

## 14. Delivery plan (review after each milestone)

1. **Framework + block core:** registry, adapter hook, shapes, wrapping, extraState, generators, connection rules (intended types, quiz exactly-one), Enter hook, focus speech, toolbox entry. Unit tests (mocha + jsdom, headless Blockly) for model, rules, serialization, and generators.
2. **Learner experience:** popover, static hints with the attempt gate, learner level setting, beginner rejection hints, Suggested category.
3. **Teacher tools:** teacher mode, edit dialog with the snapshot block picker, activity policy and quiz locks, export/import XML.
4. **Run integration** ✓: learner Run warning, misfits accepted with feedback, beginner-only suggestions, teacher-only task tests, Save my work, assessment on Run.

Each milestone ends with a browser check (keyboard path + mouse path) and a short demo note.
