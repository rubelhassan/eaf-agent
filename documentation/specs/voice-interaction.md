# Feature spec: Voice interaction

Status: **built 2026-10-28** (milestones 1 to 5); the real-voice checks are still open. Overall status: `../project-tracking.md`. Design: `../voice-interaction-flow/voice-interaction-design.md`. Builds on `task-coordinator.md` (tasks, lock, keys) and `output-manager.md` (queue, routes, stand-in AI voice). Evaluation: `evaluation-and-harness.md` §15.5 and §15.6.

## 1. Decisions

- The design's decisions *(2026-10-28)*: coordinator in the browser; submit by key; sherpa-onnx on the device for recognition, wake phrase, voice activity and the AI voice; AI turns in the AI voice and never in the live region; navigation freeze; screen reader style keys; voice barge-in with safeguards, plus I to interrupt and talk.
- *(2026-10-28, changed)* **First version AI voice:** the browser's `speechSynthesis` with on-device voices only (`localService`), through the `Voice` interface; a Piper voice or a server voice (WebRTC or HTTP from the agent server) can be added later as another `Voice` without other changes. Network voices (e.g. Google's in desktop Chrome) are never used, so learners' text doesn't leave the device for speech. Saves a 65 to 80 MB download.
- *(2026-10-28, changed)* We **build the engines ourselves**: sherpa-onnx's prebuilt browser builds have only the large recognizer (175 MB), one Piper voice and no keyword spotter. A pinned script (`test/acblock/models/build_engines.sh`, manifest `engines.json`) installs Emscripten 4.0.23 and CMake into a gitignored `tools/` folder, downloads each model with a checksum, builds sherpa-onnx v2.0.1 for the browser with a smaller starting memory, and puts the results in the gitignored `test/acblock/models/`.
- *(2026-10-28)* If a Piper voice is added later: **en_US amy medium**, a little livelier than its defaults (Piper's noise and length settings, tuned by ear); Kokoro's browser build is 348 MB.
- *(2026-10-28, changed)* **The AI voice is Piper en_US kristin medium, played by the page.** Testing on speakers, the native voice's own speech stopped it as a barge-in. An echo check on the user's Mac (Chrome 154, speakers) measured the echo in the microphone: native voice 40 dB above the room with the echo canceller off and 59 dB with it on (not removed; the OS plays it); page audio 37 dB off and -2 dB on (removed completely), the same with or without a WebRTC loopback. So the page plays the AI voice through Web Audio and the browser's echo canceller removes it. Kristin, not Amy: the voice data is public domain (LibriVox), while Amy is fine-tuned from Lessac (Blizzard license, non-commercial research only). Learners will mostly use speakers, so headphones are not the answer. The phonemizer (piper-phonemize with espeak-ng, GPL-3.0) is the pinned prebuilt browser bundle from sherpa-onnx's author, checked by checksum; the voice itself is built by our script. In the browser: loads in about 1.3 s, makes speech about 5 times faster than it plays (0.2 s for "I'm listening.", 0.85 s for a 5 s sentence), the next sentence made while one plays. A system voice is used until it loads, if it fails, or when the learner picks one in settings; then barge-in is off (the microphone waits while it speaks).
- *(2026-10-28)* **Navigation speech heard back** (screen reader or system voice, which the OS plays, so it can't be cancelled): words that sound like the line just announced are dropped, for its estimated length (400 ms a word) plus 1.5 s. The learner's other words still reach the text box.
- *(2026-10-28)* **Echo words are compared by sound** (`src/voice/echo.js`): numbers as words, contractions spelled out, a rough sound key per word, so a misheard echo ("print" as "prince") still counts as the assistant's own.
- *(2026-10-28)* **Engines load only when needed:** the recognizer on the first voice start; voice activity only when voice barge-in is on and a session is active; the keyword spotter only when "Listen for Hey Neon" is on. None of them loads with the page.
- *(2026-10-28, changed)* **Voice barge-in as designed (on), confirmed by words.** Native speech is played by the operating system, so echo cancellation can't remove it from the microphone. Voice activity (Silero VAD, a separate engine) starts a possible interruption; the first recognized words decide: words that match what the assistant is saying are its own voice and are ignored; other words stop it (about half a second after the learner starts). Ctrl and I stop it at once.
- *(2026-10-28)* **The assistant never hears itself:** the microphone opens after "I'm listening."; half a second after the AI voice stops is still ignored; and a self-voice filter drops recognized words that match what the assistant said in the last few seconds. So "Say yes to do it" can never count as the learner's yes.
- *(2026-10-28)* **The recognizer warms up after the page loads** (when the editor is ready and the page is idle): the engine downloads and starts in its worker with the microphone closed, so the first Ctrl+Shift+V is nearly instant. The voice activity engine loads when a session starts with barge-in on; the keyword spotter only when "Listen for Hey Neon" is on.
- *(2026-10-28)* From milestone 1, the panel's replies are AI items in the output manager (earcon, then the AI voice), since `pilot_voice.js` goes; the freeze cue part of output milestone 3 stays later.
- *(2026-10-28)* The draft is the panel's text box: spoken words are added to it, typing fixes them, Enter (in the box) or Ctrl+Enter sends. Words still being recognized show on a quiet line under the box that screen readers don't read.
- *(2026-10-28)* Until voice barge-in (milestone 3), microphone frames are ignored while the AI voice speaks, so it never transcribes itself.
- *(2026-10-28, changed)* Recognizer: **sherpa-onnx-streaming-zipformer-en-2023-06-26** (int8 encoder, Apache-2.0) with hotword biasing (block names, stack names). The planned small 20M model lost the first one to two seconds of speech that starts at once, natively too; the 2023-06-26 model recognized every test sentence fully. About 73 MB of model; the Chromebook check decides whether it is fast enough there.
- *(2026-10-28)* "Listen for Hey Neon" is off until the learner turns it on; Ctrl+Shift+V always works; the microphone is asked for on first use.
- *(2026-10-28)* The browser recognizer fallback is a teacher task setting (saved in the task XML like Whole plan), off by default, used only when sherpa-onnx can't load, with a one-time notice to the learner.

## 2. Scope

In:
- the conversation controller: session, input, drafts, interruptions, idle and suspend, "frozen while the AI voice speaks";
- the audio pipeline and the sherpa-onnx engines (recognizer, keyword spotter, voice activity, AI voice);
- the draft box with partial text, submit and discard keys;
- Ctrl, I, Ctrl+Enter, Ctrl+Shift+V;
- the fallback recognizer and its task setting;
- the model download script;
- replacing the pilot's Web Speech code (`pilot_voice.js`).

Out:
- Whisper through Transformers.js (an eval comparison, `evaluation-and-harness.md` §15.5);
- restoring a session after a reload;
- other languages.

## 3. Files

| File | Change |
|---|---|
| `src/voice/conversation_controller.js` | new: session, input, drafts, interruptions, idle, key handling, events |
| `src/voice/draft.js` | new: final segments plus one replaceable partial |
| `src/voice/engines.js` | new: the engine interfaces (section 4) |
| `src/util/navigation_lock.js` | the lock also reads "AI voice speaking" from the output manager |
| `test/acblock/js/voice/` | new: the audio pipeline (AudioWorklet), the sherpa-onnx worker and adapters, the Web Speech fallback adapter |
| `test/acblock/models/` | gitignored; filled by the download script |
| `test/acblock/models/build_engines.sh`, `engines.json` | build script and manifest (pinned sherpa-onnx, Emscripten, model URLs, sha256, licenses) |
| `tools/` | gitignored: Emscripten, CMake, the sherpa-onnx source |
| `test/acblock/js/pilot/` | `pilot_voice.js` removed; the panel gets the draft box and voice status |
| `src/blocks/policy.js`, `src/blocks/question/task.js` | `voiceFallback` policy, `voice-fallback="true"` in the task XML |
| `test/conversation_controller.mocha.js`, `test/draft.mocha.js` | tests |

The engines live in the host app, like the output manager's voices, so the plugin bundle stays small and engines can be swapped.

## 4. Engine interfaces

```js
Recognizer = {
  ready(): Promise<void>,
  start({onPartial(text), onFinal(text)}): Promise<void>,   // opens the microphone; rejects when refused
  pause(): void,                                   // ignore the microphone, drop the current utterance
  resume(): void,
  stop(): void,
  setHotwords(words: string[]): void,              // no-op if the engine can't bias
}
KeywordSpotter = {ready(), start({onWake()}), stop()}
VoiceActivity = {ready(), start({onSpeechStart(), onSpeechEnd()}), stop()}
Voice                                               // output-manager.md section 4 (the AI voice)
```

- **Audio pipeline:** `getUserMedia({audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true}})`, an AudioWorklet down to 16 kHz mono, frames to one worker that runs whichever engines are on.
- **sherpa-onnx adapters** (one worker):
  - recognizer: the 2023-06-26 streaming English Zipformer (pinned in `engines.json`);
  - keyword spotter: a small sherpa-onnx keyword spotting model with the phrase "hey neon";
  - voice activity: Silero VAD;
  - AI voice: Piper Kristin (`phonemize_worker.js` then `tts_worker.js`, `sherpa_tts.js`), played through Web Audio in the tab (`src/output/page_voice.js`), so echo cancellation removes it from the microphone.
- **Hotwords:** block names from the toolbox, stack letters ("stack A"), and the command words. Whether the WASM build supports biasing for streaming models is checked in milestone 1; if not, `setHotwords` is a no-op and the eval measures the difference later.
- **Fallback recognizer:** Web Speech `SpeechRecognition` behind the same interface; only when the task allows it and sherpa-onnx failed to load.

## 5. Conversation controller

`createConversationController({coordinator, output, lock, engines, settings, events})`.

**Microphone and engines by session state:**

| Session | Microphone | Engines running |
|---|---|---|
| inactive | closed, or open for the keyword spotter when "Listen for Hey Neon" is on | keyword spotter (if on) |
| active | open | voice activity, recognizer |
| suspended | as inactive | keyword spotter (if on) |

**Behavior** (design sections 4, 6, 7, 14):
- Ctrl+Shift+V or the wake phrase starts a session: listening-on cue and "I'm listening." in the AI voice the first time per page.
- Partials update the draft's replaceable segment; finals are appended. A pause doesn't submit.
- Enter in the draft box or Ctrl+Enter anywhere submits: sent cue, `coordinator.ask(draft)`, the reply to the output manager. Esc in the draft box discards.
- **Interruption** while the AI voice speaks, by voice activity (barge-in on), Ctrl tap or I: `output.interrupt()`; voice and I start a draft (I also opens the mic if needed). The coordinator is not told; an offered step stays offered.
- **Ctrl tap:** Control pressed and released with no other key in between.
- **False interruption:** no words within 2 s, the interrupted sentence plays again.
- **Barge-in safeguard:** speech must last at least 250 ms to count, with words that don't sound like the assistant's; only while the AI voice is played by the page (with a system voice the microphone waits while it speaks); a setting turns voice barge-in off.
- **Frozen while speaking:** the lock gets "AI voice speaking" from `output.onState`.
- **Idle:** the timer runs only while the output is silent and no task is working; suspend after 60 s (no task, no draft), stop listening after 2 min when a question waits and after 5 min with a draft. Before suspending: "I'll stop listening now. Press Control Shift V or say Hey Neon when you need me." (the wake phrase part only when it is on).
- **End:** "end conversation" or Ctrl+Shift+V ends the session; an open task is mentioned.

**Events** (`specs/agent-server.md` section 7): `session.*`, `message.submitted` (input voice or typed), `speech.interrupted` (by voice, Ctrl, I, navigation), `navigation.blocked`.

## 6. Panel

- A draft box: final text, then the partial text in a lighter style; editable; a live region only for "Listening" and "Stopped listening" (not for partials, which would flood a screen reader).
- *(2026-10-28, changed)* **Ctrl+Shift+I stops the AI voice and listens**, from anywhere, the text box too (plain I was "insert block" in the editor and a letter in the text box). With nothing speaking it starts listening.
- *(2026-10-28)* **Focus during a voice conversation:** spoken words arriving in the draft move focus to the text box, so Enter sends; it stays there while the assistant works and answers, and for the answer when the reply waits for one. When the exchange ends (a reply that waits for nothing has been spoken), focus goes back to the workspace, where the cursor still is, unless the learner has started a new message. Escape in the box goes back at once, keeping the draft. The box is never disabled while the assistant works (a disabled box loses focus, and a new message replaces the working task). Recognizer hotwords include the answer phrases (yes do it, do all, undo, take it back, stop, go there, say that again).
- A status line: Listening, Working, Speaking, Waiting for you, Voice loading, Voice off.
- Buttons as now (from the coordinator's `actions`), plus End conversation and Mic off.

## 7. Model files

- `build_engines.sh <engine>` (asr, tts, vad, kws) reads `engines.json` (model URL, sha256, license, files) and builds into `test/acblock/models/<engine>/`; a wrong checksum stops it.
- The app looks for the built files; missing files mean "Voice is not set up. Run build_engines.sh." in the panel, and typing still works.
- First load: "Voice is loading" in the status, and a spoken notice when ready; files are cached by the browser after that.
- Licenses of every model are recorded in the manifest and checked before adding a model.

## 8. Settings

| Setting | Where | Default |
|---|---|---|
| Listen for Hey Neon | learner | off |
| Interrupt by speaking | learner | on (confirmed by words) |
| AI voice | learner | a clear on-device voice (output manager settings) |
| Browser recognizer fallback | teacher, task XML | off |

## 9. Milestones

1. *(done 2026-10-28)* **Recognition:** model script and manifest, audio pipeline, worker, sherpa-onnx recognizer (hotword check), draft box, Ctrl+Shift+V session, submit and discard keys. `pilot_voice.js` removed. Built before the coordinator, so it submits to today's assistant `ask()` until the coordinator replaces it.

   Notes from building it:
   - `build_engines.sh asr` builds in about 15 minutes the first time (tools included), a few seconds after. Outputs: 69 MB model data and a 13 MB engine.
   - In the browser on an M2 laptop: the engine loads in about 1.7 s from the local server and decodes about 11 times faster than real time (4.5 times with hotwords on).
   - End to end with a recorded voice as the microphone: the words show on the line under the box while heard, the sentence lands in the box, Ctrl+Enter sends it, the reply is spoken in the AI voice.
   - Esc in the text box empties a draft; a second Esc closes the panel, as before.
   - Until voice barge-in (milestone 3) whatever is said while the AI voice speaks (including "I'm listening.") is ignored.
2. *(done 2026-10-28, changed)* **AI voice:** native on-device voices only, in the picking and in the settings lists. *(Changed again the same day: Piper Kristin played by the page, so the echo canceller removes it; see Decisions.)*
3. *(done 2026-10-28)* **Interruptions:** voice activity barge-in, Ctrl tap, I, false interruption, frozen while speaking.
4. *(done 2026-10-28)* **Session:** wake phrase, idle and suspend, end conversation, mic off.
5. *(done 2026-10-28)* **Fallback and measurement:** the fallback recognizer and its task setting; timing marks for the browser bench and the device check (`evaluation-and-harness.md` §15.6).

   Notes from building 3 to 5:
   - One microphone capture (`js/voice/audio_capture.js`) feeds every engine's worker; it opens with the first engine and closes with the last. `build_engines.sh` builds `vad` (Silero, 13 MB) and `kws` (gigaspeech 3.3M, 25 MB; "hey neon" and "hi neon" tokenized at build time into `keywords.txt`).
   - The recognizer warms up when the page is idle: Ctrl+Shift+V to "Listening" is about 1.9 s, 1.5 s of it the greeting.
   - The self-voice filter compares words without contractions ("I'm" and "i am"); while the assistant speaks or within 1.5 s after, utterances that are mostly its words are dropped; utterances of only filler words or single letters (stray output from the end of a sound) are ignored. With a recorded "I'm listening." played into the microphone right after the greeting, nothing reached the text box.
   - Barge-in: voice activity for 250 ms plus words that aren't the assistant's stop it. In the browser check the assistant was cut 0.36 s after speech started, mid-turn; the learner's words went into the draft.
   - The keyword spotter misses the phrase after more than about a second of silence (natively too). Four streams, each reset every 2 s, staggered by half a second, fix it: in a native sweep "hey neon" was found once at every lead time from 0.3 to 12.9 s, and 20 s of other speech never woke it. In the browser, "hey neon" started a session.
   - The voice button is the mic on and off; "end conversation", "goodbye" or "stop listening" ends the session (an awaited answer is mentioned).
   - Timing marks (`performance.mark`): `voice:listening`, `voice:speech-start`, `voice:first-partial`, `voice:barge-in`, `voice:final`, `voice:sent`, `ai:sentence`.
   - The fallback (Web Speech) is used only when the engine can't load and the task's **Browser speech fallback** (teacher tools, `voice-fallback="true"` in the task XML) is on, with a one-time notice that it may send audio to the browser's company.
   - Recognition accuracy on synthetic voices is uneven ("add a print block after the loop" was heard as "out of print block after the louvre"); real voices are the ASR evaluation (§15.5).

Each milestone ends with unit tests, a browser check with fake engines (no model, no real audio) and a short note; milestones 1 to 4 also get a real speech check by you.

## 10. Acceptance criteria and tests

Unit tests (fake engines, fake clock):
- session transitions for every arrow in the design's session diagram;
- the draft: a revised partial replaces, never duplicates; a pause doesn't submit;
- Ctrl tap stops the AI voice; Ctrl+C doesn't count as a tap;
- interruption doesn't change the coordinator's task;
- false interruption replays the sentence after 2 s with no words;
- idle timers only count while silent and not working, and keep a waiting question and a draft;
- the lock is frozen while the AI voice speaks, even with no task working.

Browser bench (fake engines with fixed delays, model stubbed; the thresholds of `evaluation-and-harness.md` §15.6):
- the AI voice stops within 200 ms of Ctrl, I or voice activity;
- no audio of an interrupted turn after the interruption;
- the fallback is never used when the task doesn't allow it.

Real checks:
- speech with headphones and with speakers (barge-in false triggers), now with Kristin; the echo check page on the Chromebook;
- Kristin's voice: clarity and speed for learners;
- NVDA or VoiceOver running alongside: the AI voice and the screen reader don't speak the same text;
- a school Chromebook: model load time, first partial, first AI audio.

## 11. Open items

- Licenses: the AI voice is Kristin (public domain data, LibriVox); Amy is not used. The phonemizer bundle (piper-phonemize with espeak-ng) is GPL-3.0: check what that means for how the app is shared before any study with learners (building it ourselves is an open offer in `../project-tracking.md`).
