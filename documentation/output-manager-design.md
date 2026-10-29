# Output manager design

Status: **agreed 2026-10-28, built** as `specs/output-manager.md`. Section 2 ("Today") describes the code before that build; the AI voice is Piper Kristin played by the page (see `specs/voice-interaction.md`), not the first-version voice of section 8. The output manager is the one place everything the learner hears goes through: AI turns, navigation and system speech, and earcons. Behavior seen by the learner is in `voice-interaction-flow/voice-interaction-design.md` (sections 5, 7, 11); replies and their kinds come from the coordinator (`task-coordinator-design.md`).

## 1. Decisions *(decided 2026-10-28)*

- Lives in the plugin, `src/output/`. It owns the queue, routes, epochs, priorities and earcons. Speech engines are given by the host app, so the plugin bundle stays small and engines can be swapped.
- AI voice: sherpa-onnx TTS (local, in a worker). System voice: the browser's `speechSynthesis`.
- With the freeze off, navigation cuts the AI voice; "repeat" replays the AI turn.
- A full set of earcons, synthesized with Web Audio in code (no files), with a volume setting and a setting to turn cues off.

## 2. Today

| Path | Where | Problem |
|---|---|---|
| Navigation speech | `Speech.update()` in `src/audio/speech.js`, writing `#blockReader` | screen reader only |
| Direct live region writes | `navigation_controller.js` (`announce`, around line 2843) | bypasses `Speech` |
| Assistant | the Neon panel's `announce()` and the pilot's `speechSynthesis` | own queue, no priorities, can talk over navigation |

## 3. Routes

| Source | Route |
|---|---|
| AI turn (reply, question, offer, outcome, error, AI progress) | earcon, then the **AI voice**; never the live region |
| Navigation and system speech | the **screen reader** (live region, default) or the **system voice**, per the learner's setting |
| Freeze and blocked cues | same as navigation |
| Operation cues | earcons |

- The chat log keeps AI turns as text, not as a live region, so a screen reader never reads them twice.
- When the AI voice engine isn't ready (loading or failed), AI turns use `speechSynthesis` with a distinct voice, pitch and rate, still after the AI earcon.

## 4. Items and priorities

Every item: `{text, source: ai | navigation | system, kind, priority, epoch, taskId}`.

| Priority | Kinds |
|---|---|
| 1 (highest) | stop, freeze and blocked cues |
| 2 | questions to the learner |
| 3 | outcomes, offers, answers, errors |
| 4 | navigation speech |
| 5 | progress |

Rules:
- **Navigation replaces navigation:** a new navigation item drops any unspoken one (only the newest place matters), as `Speech.update` does now.
- **Navigation cuts the AI voice** (freeze off): the AI turn stops; it stays available to "repeat".
- **Freeze cues** (freeze on): the AI voice pauses, the cue plays on the system route, then the AI voice resumes from the start of the interrupted sentence.
- **Progress** is dropped if its task finished or a newer item for that task arrives before it is spoken; it never cuts anything.
- A higher-priority AI item for the same task replaces a queued lower one (an answer replaces "I'm still working on it.").

## 5. Epochs and chunks

- Each AI turn gets the current `outputEpoch`. An interruption (voice activity, Ctrl, I, a navigation cut) raises it; queued items and late audio chunks of older epochs are dropped.
- AI text is split into sentences. The first sentence is synthesized and played while the next is synthesized, so speech starts quickly and can stop between sentences.
- "Repeat" replays the last AI turn's text in a new epoch.

## 6. Screen reader mode details

- We can't stop the learner's screen reader; the learner can (Ctrl). The AI voice never goes to the live region, so the two never say the same thing.
- The live region keeps today's trick (alternating an invisible character) so the same text is announced again.
- While the AI voice speaks, navigation is frozen (freeze on), so only short cues reach the screen reader.
- The AI voice is played through Web Audio in the same tab, which lets the browser's echo cancellation remove it from the microphone for voice barge-in.

## 7. Earcons

Short tones made with Web Audio (about 60 to 150 ms), each with its own pitch shape so they can't be confused:

| Earcon | When |
|---|---|
| AI turn | before every AI turn (once per turn, not per sentence) |
| Sent | a message was submitted |
| Listening on, listening off | the mic starts or stops capturing |
| Blocked | a key was blocked by the freeze or read-only mode |
| Error | a task failed |
| Connected, rejected | a block connected, a connection refused |
| Entered stack, left stack | the cursor moved into or out of a stack |

- Operation cues come from workspace change events (a move with a new parent is "connected"), the connection checker (refused connections) and cursor moves reported through `Speech` (entered or left a stack), so the stable navigation files need no change.
- Settings: cue volume, and cues on or off (AI turn cue stays on unless the learner turns all cues off).

## 8. Engines

```js
Voice = {
  ready(): Promise<void>,
  prepare?(text): void,                        // optional: synthesize the next sentence early
  speak(text, {rate, signal}): Promise<void>,  // resolves when done; abort through the signal
  cancel(): void,
}
```

- Both the system voice and the AI voice use this interface. The sherpa-onnx engine synthesizes in its worker and plays through Web Audio in the same tab (which also lets echo cancellation remove it from the microphone); `speechSynthesis` plays itself.
- First version *(2026-10-28)*: the AI voice is `speechSynthesis` with a clear on-device voice (`nativeAiVoice`). The host app can pass another engine later (Piper in a worker, or a server voice) with no change here.
- The AI voice is one clear, standard voice *(changed 2026-10-28 from "playful and robotic": understanding comes first)*; the earcon before each AI turn tells it apart. The voice and rate are settings.

## 9. Interface

```js
createOutputManager({aiVoice, systemVoice, liveRegion, settings}) -> {
  say(item): void,            // queue an item (section 4)
  cue(name): void,            // play an earcon
  interrupt(): number,        // stop the AI voice, raise the epoch; returns the new epoch
  stopAll(): void,
  repeat(): void,             // replay the last AI turn
  state(): 'silent' | 'speaking' | 'announcing',
  onState(fn): unsubscribe,   // for the conversation controller (freeze, idle timer, barge-in)
  setSettings(partial): void,
  dispose(): void,
}
```

## 10. Integration

| Caller | Change |
|---|---|
| `Speech.update()` | sends a navigation item to the output manager instead of writing the live region itself; the output manager writes the live region in screen reader mode |
| `navigation_controller.js` direct writes | go through `Speech.update()` (a small, deliberate change; no key changes) |
| Neon panel `announce()` | system items |
| Pilot `speechSynthesis` calls | removed; the coordinator's replies become AI items with their `kind` |
| Conversation controller | calls `interrupt()`, listens to `onState()` |

Disposal: the output manager stops audio, closes the Web Audio context and drops listeners on `dispose()`.

## 11. Settings

| Setting | Values | Default |
|---|---|---|
| System output | screen reader, system voice | screen reader |
| System voice and rate | OS voices | OS default |
| AI voice rate | slower to faster | normal |
| Cues | on, off; volume | on, medium |

## 12. Tests

Unit tests with fake engines and a fake clock:
- priorities: a question cuts progress; an answer replaces queued progress of the same task;
- epochs: chunks of an interrupted turn are dropped;
- navigation replaces navigation; navigation cuts the AI voice (freeze off);
- freeze cue pauses and resumes from the sentence start;
- screen reader mode never writes AI text to the live region;
- the AI earcon plays once per turn.

A stubbed browser check (fake engines, no model) for the live region and focus paths; a real screen reader check (NVDA or VoiceOver) before any accessibility claim.
