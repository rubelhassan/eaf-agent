# Feature spec: Interactive hint block (System Design §4.4) and Structured scaffold (§4.5)

Status: **APPROVED 2026-09-29**; milestones 1 to 3 built, 4 (learner scaffold through the assistant) after the participatory design (stage 4). Overall status: `../project-tracking.md`. Items marked *(default)* were proposed by the agent and approved with the spec.
Builds on the question block (`question-block.md`).

## 1. Hidden reference answer (shared by both features)

- A question can hold a **reference answer**: the blocks that correctly fill it. Learners never see it, it is never spoken, and it is never sent to the AI hint prompt *(default)*.
- **Teacher tools:** in teacher mode, the teacher builds the answer in the question's slot. That slot content is the reference.
  - **Export task** moves each slot's content into the question's hidden reference and empties the slot, so the learner starts with an empty question.
  - A loaded task keeps references hidden, even in teacher mode. This matters because an imported learner submission must not look answered by the reference. *(default)*
  - **Edit question** shows "Reference answer" as a block picture, with **Put in slot to edit** (moves it back into the slot) and **Remove**. If the slot is filled when exporting, the slot content wins.
- **Scaffolds** (§3) set the reference automatically from the blocks they remove.
- **Storage:** config field `reference` (Blockly JSON state of the answer's first block, including the blocks after it in a statement answer); in XML, a `<reference>` element inside the question's `<mutation>`, holding the answer as `<block>` XML. The clean export writes it; loading reads it.
- Edit question names the reference in text too ("A compare block, hidden from learners."), since the picture is hidden from screen readers. **Put in slot to edit** and **Remove** are toggles, applied on Save as one undo step.

## 2. Interactive hint: choices of real blocks (4.4)

- **Entry:** a **Show choices** action in the question popover's Hints row. It appears only when:
  - the question has a reference answer;
  - the teacher left **Offer choices** on (Edit question → Hints, on by default; the form says it needs a reference answer);
  - the activity is **not a quiz** (never in quizzes);
  - the learner has made a first attempt (the same gate as the other hints).
- **The choice flyout:** real, insertable blocks, not pictures.
  - Opening it closes the popover and shows the candidates in a flyout (the same flyout the toolbox uses), with the keyboard marker on the question's spot.
  - Speech: "3 choices. Use W and S to hear them, Enter to put one in the question, Escape to go back."
  - **W/S** move through the choices, each read with its values ("compare: weight greater than 100"). **Enter** inserts the choice into the gap through the normal insert path, and the learner then edits it like any block. Mouse users drag a choice in. **Esc** closes the flyout and returns to the question.
- **Where a pick goes:** opened on an empty question, into its slot. Opened on a value answer, it replaces the answer. Opened on a statement or sequence answer, it goes after the answer so far.
- **How it works:** the question code asks the navigation host (`blockTypes.navigationHost().showChoices`, registered by `NavigationController`) to fill the toolbox's flyout. Keyboard focus goes back to the workspace, and with keyboard navigation on, Edit mode starts at the question and the marker goes on the target, so the flyout's usual keys apply. Choices are read without a category ("Move to item get variable number + 4"). The popover's Hints row shows **Show choices** as its third control. When the question has no other hints, the row says "Choose Show choices to pick from a few blocks."
- **Teacher control:** Edit question → Hints → **Offer choices (interactive hint)**, on by default, stored as `choices="false"` on the mutation when off.
- **Replacing a wrong answer** *(added 2026-09-29)*: when choices are opened on an answer that doesn't fit, the wrong blocks are remembered. These are:
  - for a value, the answer;
  - for a statement, the blocks that aren't intended;
  - for a sequence, everything from the first step that differs from the reference.

  When a block of one of the offered kinds lands in that question, by keyboard or mouse, the wrong blocks are removed in the same undo step. You hear "Replaced the change variable by block with your choice. Question answered with a print block."
- **Picking is the learner's own action.** The block becomes their answer, with the usual fit / doesn't-fit feedback. The agent never places it without the pick.
- **What the choices offer**, by the reference's kind:
  | Reference | Choices |
  |---|---|
  | A value (e.g. `weight > 100`) | 3 filled blocks: the reference plus 2 wrong ones made by rules (§2.1). |
  | A control structure (if, repeat…) | The reference's construct plus up to 2 siblings from its family, all **empty** (no condition, no body): if / if-else / if-else if-else; repeat N times / repeat while / repeat until / count with / for each. Never a completed structure. |
  | A single non-control statement (e.g. print) | The reference's block kind with empty values, plus 2 other statement kinds as distractors. |
  | A sequence | Only the **next missing block** (the first reference block the learner's answer doesn't have yet, in order), with empty values, plus 2 other kinds. Nothing after it is revealed. |
- **Determinism:** the same program state always gives the same choices, in the same order. The order is shuffled with a seed from the question id; for sequences, the choices move on as the answer grows. There is no limit on how often choices can be opened.

### 2.1 Rules for wrong values *(default)*

Each rule changes one thing in the reference; the first two rules that apply are used. The rules, in order:
1. Flip the comparison (`>` ↔ `<`, `≥` ↔ `≤`, `=` ↔ `≠`).
2. Change a number (×10, or ÷10 when that gives a whole number, else +1).
3. Swap true and false.
4. Swap and/or.
5. Change the arithmetic operator (`+` ↔ `−`, `×` ↔ `÷`).
6. Use another variable of the same program.

If fewer than 2 rules apply, the remaining choices are other value blocks with the same output type from the toolbox, left empty. An untyped reference, such as a variable, accepts any value block. Duplicates of the reference are never offered.

## 3. Structured scaffold (4.5)

- **Starts from the program on the workspace:** an example the tutor wrote or loaded, or the learner's own program. The removed parts become hidden reference answers. Generating a new program from a topic comes later.
- **Teacher:** Settings → **Make scaffold…** (teacher mode) opens a modal with:
  - **Concept:** Let the AI decide / Variables / Input and output / Conditionals / Loops / Lists / Text / Math / Functions.
  - **Level:** beginner / intermediate / advanced, defaulting to the learner level setting.
  - **Make scaffold** applies it as one undoable step. The chosen parts get **wrapped by questions**: the question sits where the part was, with the part in its slot (the reference), so the teacher can review, edit, or undo. Export then empties the slots (§1).
- **Learner:** asks the assistant ("give me practice with this program"). The agent says how many questions and about what, then asks: "Your program will be replaced; you can undo. Shall I?" On yes, the program is replaced in one undoable step: empty questions with hidden references, activity practice, and the task blocks are marked.
- **Gap count** by level, scaled by program length (statement blocks N):
  | Level | Gaps | Kinds allowed |
  |---|---|---|
  | Beginner | round(N/8), min 1, max 2 | values, single statements |
  | Intermediate | round(N/5), min 1, max 4 | + control structures |
  | Advanced | round(N/3), min 2, max 6 | + sequences (2 to 3 statements) |
- **Possible gap spots** (rules):
  - non-shadow value inputs;
  - single statements;
  - control blocks;
  - consecutive statement runs.

  Spots don't overlap or nest, and shadows and procedure definitions are never gaps. The first top-level statement (routine setup), and the values inside it, are never spots. *(Built at M3: skipped even when it belongs to the concept.)*
- **Ranking** (M3): spots are ordered by importance:
  - the concept (+10, and +3 more when the spot's own block is the concept, e.g. the arithmetic rather than the set block holding it);
  - then nesting inside loops and ifs (+2 per level, up to 3);
  - then anything more than a plain literal (+1).

  The request lists spots in this order, and each spot carries `overlapsWith`, so the agent never has to work out nesting. The rules pick from the same order. For Program 18, "math" gives `number + 4` in the loop, not `set number to 0`.
- **Generated events:** the scaffold runs as one event group named `eaf-generated:<id>` (one undo step). Groups with that prefix never auto-open the Edit question form.
- **Who chooses (rules + AI):** rules list the spots and the allowed count. The AI picks the spots that carry the key concept and writes each question's prompt, instruction and 2 written hints. Its output is validated:
  - the spot ids exist, the count is within range, and nothing overlaps;
  - the text is speech-ready and contains no code;
  - it doesn't give the answer away (it never names the exact block below Show-the-kind level).

  The AI gets one repair retry. After that, or without AI, the rules choose (concept-matching spots, spread through the program) and the text comes from templates ("Fill in the condition here." / "It needs a true or false value.").
- **Generated question settings:**
  - intended blocks = the reference's block types;
  - written hints from the AI (none from templates);
  - AI hints at Point, 2 hints;
  - Offer choices on;
  - the expects kind (value / statement / sequence) follows the spot.
- **Assistant intent:** a new `SCAFFOLD` intent and the scaffold prompt `scaffold.v1`. *(Superseded in part: intent v2 and v3 were built without SCAFFOLD; it comes with a later intent version, together with milestone 4.)*

## 4. Architecture *(default)*

```
src/blocks/question/
  reference.js     ✓   reference answer: read, slot → hidden (export), hidden → slot (edit); XML codec in xml.js
  choices.js       ✓   candidate generation (value rules, control families, next block), deterministic order
  (flyout)         ✓   NavigationController.showChoices via the registry's navigation host; popover Show choices
  scaffold/
    spots.js       ✓   possible gap spots, concepts, ranking, gap count by level/length
    apply.js       ✓   wrap spots in questions for the teacher (learner replace comes with M4)
    request.js     ✓   agent request, result checks (one retry), rule fallback with template text
    index.js       ✓   previewScaffold, makeScaffold (teacher mode, one undo step)
  ui/scaffold_dialog.js ✓  teacher "Make scaffold…" modal (concept, level, live preview of the question count)
src/agent/services/contracts.js ✓   AgentServices.generateScaffold contract (fake_services.js for now)
src/agent/prompts/intent.v2.js, scaffold.v1.js; SCAFFOLD intent flow   (agentic phase)
```

## 5. Milestones

1. **Reference answers** ✓: slot → hidden on export, the XML/JSON round trip, the Edit question reference section, demo references.
2. **Choices** ✓: the rules, the flyout, the popover action, the Offer choices checkbox. Keyboard and mouse checks.
3. **Scaffold core + teacher dialog** ✓: spots, ranking, counts, apply, agent (fake for now) + validation + fallback.
4. **Learner scaffold through the assistant:** intent.v2, the SCAFFOLD flow with confirmation.
