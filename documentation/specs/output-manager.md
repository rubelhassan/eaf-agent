# Feature spec: Output manager

Status: **built 2026-10-28** (milestones 1 to 3). A screen reader route for AI replies comes with `screen-reader-replies.md` (P10). Overall status: `../project-tracking.md`. Design: `../output-manager-design.md` (routes, priorities, epochs, earcons, interface). Replies and their `kind` come from the coordinator (`task-coordinator.md`).

## 1. Decisions

- The design document's decisions *(2026-10-28)*: `src/output/` in the plugin, engines given by the host; system voice is `speechSynthesis`; navigation cuts the AI voice (freeze off); a full set of synthesized earcons.
- *(2026-10-28, changed)* The AI voice of the first version is native (`nativeAiVoice`: on-device voices only); Piper or a server voice can come later as another engine. *(Changed again: Piper Kristin played by the page, `pageVoice` in `page_voice.js`, chosen by `preferPageVoice` once loaded unless a system voice is picked; native until then. `prepare` gets the rate. `onAnnounce` reports navigation and system lines so the microphone can ignore them; see voice-interaction.md.)* Originally a **stand-in AI voice**: `speechSynthesis` with a distinct voice, pitch and rate.
- *(2026-10-28)* `announceToScreenReader()` in `navigation_controller.js` calls `Speech.update()` instead of writing `#blockReader`; nothing else in that file changes.
- Every voice shares one interface (section 4), so another engine replaces the native one without changes here.
- *(2026-10-28)* **One audio timeline** (section 5.1): cues and speech never cover each other; a cue that belongs to a message plays first and the words follow.
- *(2026-10-28)* The rejected cue is added to the three refusal messages in `navigation_controller.js` (`speech.update(text, {cue: 'rejected'})`); the spoken text and keys don't change.
- *(2026-10-28)* Stack search and the question popover announce through the output manager too, so system voice mode speaks them. Text a screen reader reads only on focus (dialog and row labels) is not spoken by the system voice yet; listed in section 10.

## 2. Scope

In:
- the output manager: items, priorities, the queue, epochs, sentence chunks, routes, the live region, repeat, state events;
- the system voice and the native AI voice;
- earcons, including the operation cues, with a preview in Settings;
- `Speech.update()` and `announceToScreenReader()` going through it;
- the pilot speaking through it, and the chat log no longer a live region for AI turns;
- the freeze cue's pause and resume with the navigation lock.

Out:
- the sherpa-onnx AI voice, Ctrl and I, voice barge-in (voice spec);
- verbosity settings beyond the word limits already in the harness.

## 3. Files

| File | Change |
|---|---|
| `src/output/output_manager.js` | new: queue, priorities, epochs, chunks, routes, repeat, state |
| `src/output/earcons.js` | new: Web Audio tones, volume, on and off |
| `src/output/voices.js` | new: `systemVoice()` and `standInAiVoice()` over `speechSynthesis` |
| `src/output/sentences.js` | new: splits text into sentences (numbers like 2.5 and "e.g." stay whole) |
| `src/audio/speech.js` | `update()` sends a navigation item to the output manager when one is set; otherwise writes the live region as now |
| `src/navigation_controller.js` | `announceToScreenReader()` calls `Speech.update()` |
| `src/output/operation_cues.js` | new: the connected cue from workspace move events |
| cue sources | rejected (the three refusal messages in `navigation_controller.js`), entered and left a stack (`Speech.process` cursor moves) |
| `src/labels_and_comments/stack_search.js`, `src/blocks/question/ui/popover.js` | their own live region messages go through the output manager in system voice mode |
| `src/index.js` | exports `createOutputManager` |
| `test/acblock/js/pilot/*` | replies and panel messages through the output manager; no direct `speechSynthesis` |
| `test/acblock/js/settings.js`, `index.html` | settings (section 6) and the cue preview |
| `test/output_manager.mocha.js` | tests |

## 4. Voice interface

```js
Voice = {
  ready(): Promise<void>,
  prepare?(text): void,                    // optional: start synthesizing the next sentence early
  speak(text, {rate, signal}): Promise<void>,  // resolves when done; abort through the signal
  cancel(): void,
}
```

- **System voice:** the learner's chosen OS voice and rate.
- **Native AI voice** (`nativeAiVoice`): a clear standard voice on the device (never a network voice) (a short list of known clear US and UK voices, never novelty voices), different from the system voice when one exists, at normal pitch and rate, always after the AI earcon. Settings let you pick another voice. *(changed 2026-10-28: the first version, pitch 1.3, was hard to understand)*
- The design document's engine section is updated to this interface.

## 5. Behavior

As in the design, sections 3 to 7. Details fixed here:
- The queue holds at most one navigation item (newest wins) and drops progress when an item of priority 3 or higher for the same task arrives.
- An AI turn: earcon, then sentences one by one in the current epoch; `prepare()` is called for the next sentence while one plays.
- `interrupt()` cancels the voice, raises the epoch and empties AI items of older epochs.
- Freeze cue (from the navigation lock): the AI voice is cancelled, the cue plays on the system route, and the interrupted sentence starts again; the rest of the turn follows.
- With the freeze off, a navigation item calls `interrupt()` first; the turn stays available to `repeat()`.
- Screen reader route: the live region is written with today's alternating invisible character; AI items never go there.
- `state()` is `speaking` while the AI voice plays, `announcing` while the system voice plays, otherwise `silent`; `onState` fires on every change.

### 5.1 One audio timeline

1. A cue that belongs to a message plays first; the words start when it ends (system voice waits; in screen reader mode the live region is written after the cue). Cues are at most 150 ms. Only messages with a cue wait: connected, rejected, entered or left a stack.
2. Cues never overlap: they play one after another with a short gap, and the same cue again within 100 ms plays once.
3. A new navigation message replaces a waiting one, with its cue.
4. No cue plays under the AI voice: the freeze cue pauses it first (resuming from the sentence start), navigation with the freeze off cuts it first, and the AI turn earcon comes before the AI voice.
5. Limit: in screen reader mode we can't know when the screen reader is still talking, so a cue can play over its earlier speech.

## 6. Settings

| Setting | Values | Default |
|---|---|---|
| Navigation and system speech | screen reader, system voice | screen reader |
| System voice, rate | OS voices; 0.8 to 1.5 | OS default, 1.0 |
| AI voice, rate | on-device voices; 0.8 to 1.5 | auto, 1.0 |
| Sound cues | on, off; volume low, medium, high | on, medium |
| Preview | a button per cue, and "Hear the AI voice" | |

Stored per browser like the other settings.

## 7. Earcons

| Cue | Sound (first proposal, tuned after you listen) |
|---|---|
| AI turn | two quick rising tones |
| Sent | one short soft click |
| Listening on, off | rising, falling sweep |
| Blocked | one low short buzz |
| Error | two falling tones |
| Connected | one bright short tone |
| Rejected | a low double tone |
| Entered stack, left stack | a short up, a short down |

All between 60 and 150 ms, made with oscillators and a gain envelope; no audio files.

## 8. Milestones

1. *(done 2026-10-28)* **Core:** output manager with fake voices, system voice, live region route, `Speech.update()` and `announceToScreenReader()` through it. Unit tests.
2. *(done 2026-10-28)* **Earcons and settings:** earcons, operation cues, settings, the preview.

Notes from building 1 and 2:
- `src/output/active.js` holds the manager the plugin speaks through (`setOutputManager`), so `Speech` and the dialogs reach it without an import cycle.
- Waiting messages play after Blockly's change events (Blockly 11 fires them on the next frame, then a timeout), so the connected cue from a workspace event joins the keyboard message it belongs to. Measured in the browser: the cue starts about 6 ms after the action, the words about 80 ms later. Re-check on a Blockly upgrade.
- Stack cues come from the cursor's stack at each message, so stack jumps and search get them too.
- Settings are a **Sound and speech** group in the gear panel, closed by default, controls in two columns (the panel widens while it is open).
3. *(done 2026-10-28)* **Pilot:** replies (with `kind`) and panel messages through the output manager with the native AI voice; the chat log not live for AI turns; the freeze cue with the navigation lock (`task-coordinator.md`).

   Notes from building it: replies moved over with voice milestone 1; this milestone moved the panel's own messages ("Neon opened", "Neon closed", "Listening", "Stopped listening") to the system route, so they are spoken in built-in voice mode too, and the voice status line is no longer a live region. "Listening" isn't said the first time, when the assistant says "I'm listening." Browser timeline (stubbed model and voices): AI earcon, AI voice; Delete while it speaks cancels the voice, plays the blocked cue and the read-only line, and the interrupted sentence starts again; no AI text in `#blockReader`.

Each milestone ends with tests, a stubbed browser check and a short note; you listen to the earcons and the AI voice at milestone 2 and 3.

## 9. Acceptance criteria and tests

Unit tests (fake voices with fixed durations, a fake clock):
- a question cuts progress; an answer replaces queued progress of its task; progress never cuts anything;
- after `interrupt()` no sentence of the old epoch is spoken;
- navigation replaces navigation; with the freeze off, navigation interrupts the AI voice and `repeat()` replays the turn;
- the freeze cue resumes the interrupted sentence from its start;
- AI text never reaches the live region; navigation text does in screen reader mode and doesn't in system voice mode;
- the AI earcon plays once per turn; cues off silences all cues;
- sentences: "Set it to 2.5. Then print." is two sentences, "2.5" stays whole.

Browser check (Playwright, model stubbed, `speechSynthesis` replaced by a recorder):
- navigation speech reaches `#blockReader` in screen reader mode and the recorder in system voice mode;
- a stubbed reply plays the AI cue then the AI voice, and nothing of it reaches `#blockReader`;
- Delete while waiting plays the read-only cue on the system route.

Real screen reader check (NVDA or VoiceOver): navigation is read as before, AI turns aren't read twice.

## 10. Known gaps

- In system voice mode, text a screen reader reads only on focus (stack search and popover rows, settings) is not spoken.
