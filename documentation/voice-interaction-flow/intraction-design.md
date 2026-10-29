# Voice Interaction Design (Incomplete draft and ideas to ponder)

Note: this is some idea brainstorming, everthing need to be cross-checked analysed, and if required then make correction. Also because of this our harness behavior, stages, chunking, context management and other things can affect positively, in that case we also need to update the design of other affected parts of the system.

## 1. Overall architecture

| Component | Main responsibility |
|---|---|
| **Conversation controller** | Knows whether the session is active, manages drafts, handles interruptions, and chooses what to announce |
| **Audio output controller** | Owns all assistant speech playback, queues, stopping, and stale-audio rejection |
| **Task coordinator** | Owns the task lifecycle, execution stages, revisions, cancellation, and pending questions |
| **Editor harness** | Owns actual editor mutations, workspace validation, undo, and execution receipts |
| **Speech adapters** | Convert audio to text and text to audio without owning task behavior |
| **Task model adapter** | Calls whichever model you choose using a stable application contract |

See: documentation/voice-interaction-flow/overall-diagram.png

### Design goal and principles
- Separate three things that can happen simultaneously: listening, speaking, keyboard interaction and executing a task.
- Keep conversation control primarily in the browser. Stopping playback or displaying “Listening” should not require a backend round trip.
- Keep task coordination in the backend. Closing an audio stream should not accidentally erase task state or trigger duplicate operations.
- Enter to submit for the first version. Speech can interrupt the assistant immediately, but the resulting draft reaches the backend only when the user submits it.


## 2. Browser conversation behavior
Use "Hey, Neon" to enter an active conversation session. Within that session, microphone input remains available across turns.

Speaking and task execution are deliberately absent from this diagram: they run alongside session state. The assistant speaking does not prevent the session from receiving input.

Maintain separate state:

See: documentation/voice-interaction-flow/conversation-behavior-diagram.png

| State domain | Example values |
|---|---|
| Session | Inactive, active, suspended |
| Input | Ready, capturing, draft |
| Output | Silent, buffering, speaking |
| Task | Analyzing, executing, awaiting user, held, completed, cancelled, failed |

A pause only affects speech recognition. It does not submit the message, clear the draft, or close the conversation.

Streaming transcription also needs careful handling: recognizers may revise partial text. Maintain finalized transcript segments plus one replaceable partial segment, rather than appending every partial result and producing duplicated words.

## 3. Interruption flow—the most important part

An interruption should immediately affect playback, provisionally hold pending mutations, and wait for the submitted message before changing the task’s meaning.

See: documentation/voice-interaction-flow/interruption-flow-diagram.png

The browser should perform these interruption actions immediately:
1. Stop current speech playback.
2. Discard queued speech from the interrupted response.
3. Invalidate incoming audio chunks belonging to that response.
4. Start a new input draft.
5. Hold pending editor commits while the user may be correcting the request.
6. Notify the backend that an interruption is in progress.

Do not wait for speech recognition to finish before stopping playback. Use speech-activity detection to yield quickly, with echo handling to reduce interruptions caused by the assistant’s own audio. Provide a keyboard interruption control as a reliable alternative.

What continues during the interruption?

| Work | Recommended behavior |
|---|---|
| Assistant speech | Stop immediately |
| Read-only analysis | May continue |
| Candidate generation | May continue, but its result can become obsolete |
| New editor mutations | Hold |
| Operation already committed | Preserve its receipt; undo is a separate action |
| Additional task stages | Pause at a safe boundary when they depend on unresolved intent |

After Enter, the coordinator determines what the message means:

| Submitted message | Task behavior |
|---|---|
| “Actually, use the inner loop” | Revise the task; reject outdated proposals |
| “Why are you changing that?” | Explain; keep the proposed action held |
| “Cancel the task” | Cancel remaining work |
| “Stop speaking” | Silence output; task can continue |
| “Undo the last change” | Execute a specific undo operation |
| “Continue” | Resume the held task after checking current state |

For a false interruption, show “Continue task” and “Discard draft.” Do not automatically resume a potentially conflicting edit merely because the user went quiet.


## 4. Interruption flow—the most important part

Need separate mechanisms for speech and actions.

| Identifier | Purpose |
|---|---|
| `sessionId` | Conversation session |
| `taskId` | Ongoing task |
| `taskRevision` | Current version of the user’s request |
| `operationId` | One executable operation; prevents duplicate execution |
| `workspaceVersion` | Editor state a proposal depends on |
| `outputEpoch` | Current generation of permitted audio output |
| `requestId` | A particular clarification or consent request |

When speech is interrupted, increment outputEpoch. Any late TTS chunk with an older epoch is discarded.

These are distinct: asking “Can you repeat that?” changes audio output without necessarily changing the task.

Before committing an edit, the harness checks the task revision, workspace version, operation identity, and hold status together.

There is still a possible race: an operation might commit just before interruption arrives. The system must report that accurately. Cancellation prevents remaining work; it cannot retroactively prevent a completed operation.


## 5. Model a long request as a task with resumable stages

A model returning a complete plan does not mean those stages have executed. Store the plan, then let the coordinator advance through it using actual results.

| Stage | What happens | What allows progression |
|---|---|---|
| Understand | Resolve the selected code and requested outcome | Sufficient context |
| Generate | Model returns candidate changes | Valid structured proposal |
| Clarify | Ask which loop the user meant | Submitted answer |
| Validate | Check the candidate against editor constraints | Validation result |
| Confirm | Ask about a substantial change, if required | Consent for the current proposal |
| Apply | Harness commits the change | Execution receipt |
| Verify | Run the relevant behavior checks | Verification result |
| Explain | Describe the outcome | Verified task facts |

Some tasks skip stages. Some revisit a stage after a correction.

When the backend returns several proposed steps at once, save them as pending stages. After a user answer, resume from the relevant checkpoint rather than restarting everything—unless the answer invalidates earlier work.

Bind each consent request to a particular proposal and task revision. “Yes” should never approve an outdated proposal after a correction.


## 6. Acknowledgment and progress should come from events

| Real event | Possible feedback |
|---|---|
| Browser submits the message | Immediate local cue: “Sending” |
| Backend accepts the task | “I’ll check the selected loop.” |
| Validation actually begins | “I’m testing the proposed change.” |
| Input becomes necessary | “Which loop should I change?” |
| Harness reports a commit | “The change is applied.” |
| Verification completes | “The character now reaches the target.” |

Use cached or prerecorded audio for a few generic cues if fast acknowledgment matters. A specific acknowledgment must reflect information the system actually has.

For tasks that may take about 30 seconds:
- Acknowledge promptly.
- Announce meaningful stage changes.
- Suppress progress speech if the result is already ready.
- Coalesce rapid events so they do not create a speech backlog.
- Keep listening available throughout.
- If one stage runs for a long time, provide a brief truthful status after a configurable interval.
  If the backend spends 20 seconds on one model call and exposes no intermediate stage, say something like “I’m still preparing the change.” Do not invent progress such as “Now running tests.”

Prioritize questions and final outcomes above routine progress. Remove obsolete progress announcements when a task finishes or the user interrupts.

## 7. Use an idle timeout, but suspend the interaction rather than erase it

The idle limit should depend on what the system is doing.

| Situation | Suggested idle policy |
|---|---|
| Task completed; no draft or pending question | Suspend after about 60 seconds of inactivity |
| Assistant speaking or task actively processing | Do not count this as conversational idle time |
| Waiting for consent or clarification | After about 2 minutes, suspend voice capture while preserving the pending question |
| Unsubmitted draft exists | Preserve the draft; suspend capture after a longer inactivity period |
| User says “End conversation” | End the voice session immediately |

Start the ordinary idle timer after playback ends, not when the user finishes their previous utterance.

Before suspension, provide a brief accessible notice. On reactivation, restore the task or draft, and revalidate any pending proposal against current editor state.

Ending the voice session and cancelling the task must remain separate controls. Make it clear if a task continues after voice interaction ends.

Also distinguish “conversation suspended” from “microphone off”: browser wake-word detection still requires microphone access. Offer an explicit microphone-off control.

## Minimum implementation contract (in progress and incomplete)

browser and backend can communicate using application events such as (these are example, just for idea):

Browser → Backend
message.submit
task.hold
task.resume
task.cancel
operation.undo
clarification.answer
confirmation.answer
editor.operation.result

Backend → Browser
task.accepted
task.stage.changed
task.held
clarification.required
confirmation.required
editor.operation.requested
task.completed
task.cancelled
task.failed

Attach task identity and revision to task-related events, and sequence events so reconnects can recover the current state without repeating edits.
