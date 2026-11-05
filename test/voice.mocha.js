/**
 * Voice conversation: spoken words into the draft, sending, the assistant never hearing itself, barge-in,
 * interruptions, idle, the wake phrase and the fallback recognizer. Fake engines and a fake output; time is
 * a fake clock where the rules depend on it.
 */
import {assert} from 'chai';
import {appendToDraft, cleanTranscript} from '../src/voice/draft.js';
import {createConversationController, SessionState, TAIL_MS} from '../src/voice/conversation_controller.js';
import {playedShare, soundsAlike, spokenWords} from '../src/voice/echo.js';
import {pageVoice} from '../src/output/page_voice.js';
import {preferPageVoice} from '../src/output/voices.js';

const settle = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return {promise, resolve};
}

function fakeSpotter() {
  const spotter = {calls: [], handlers: null, async start(handlers) {
    spotter.calls.push('start');
    spotter.handlers = handlers;
  }, stop: () => spotter.calls.push('stop')};
  return spotter;
}

function fakeRecognizer({fail = null} = {}) {
  const r = {
    calls: [],
    handlers: null,
    ready: async () => {
      r.calls.push('ready');
      if (fail === 'load') throw new Error('missing');
    },
    async start(handlers) {
      r.calls.push('start');
      if (fail === 'mic') throw Object.assign(new Error('denied'), {name: 'NotAllowedError'});
      r.handlers = handlers;
    },
    pause: () => r.calls.push('pause'),
    resume: () => r.calls.push('resume'),
    stop: () => r.calls.push('stop'),
    setHotwords: (words) => r.calls.push(`hotwords:${words.join(',')}`),
  };
  return r;
}

/** An output that "speaks" AI items for a few milliseconds, with its state and sentence events. */
function fakeOutput(log) {
  const states = new Set();
  const speaks = new Set();
  const announces = new Set();
  let state = 'silent';
  const setState = (s) => {
    state = s;
    states.forEach((fn) => fn(s));
  };
  return {
    say(item) {
      log.push(item.source === 'ai' ? `ai:${item.text}` : `sys:${item.text}`);
      if (item.source !== 'ai') return;
      setTimeout(() => {
        setState('speaking');
        speaks.forEach((fn) => fn(item.text));
        setTimeout(() => setState('silent'), 5);
      }, 1);
    },
    cue: (name) => log.push(`cue:${name}`),
    interrupt: () => log.push('interrupt'),
    replayInterrupted: () => log.push('replay'),
    state: () => state,
    setState,
    onState: (fn) => {
      states.add(fn);
      return () => states.delete(fn);
    },
    onSpeak: (fn) => {
      speaks.add(fn);
      return () => speaks.delete(fn);
    },
    speak: (text) => speaks.forEach((fn) => fn(text)),
    onAnnounce: (fn) => {
      announces.add(fn);
      return () => announces.delete(fn);
    },
    announce: (text) => announces.forEach((fn) => fn(text)),
  };
}

const made = [];

function setup({recognizer = fakeRecognizer(), settings = {}, vad = null, spotter = null, fallback = null, waiting = false,
  echoCancelled = true} = {}) {
  const log = [];
  const output = fakeOutput(log);
  const box = {text: '', partial: ''};
  const sent = [];
  const events = [];
  const microphoneStates = [];
  const clock = {t: 100000};
  const controller = createConversationController({
    output, recognizer, vad, spotter, fallback,
    draft: {value: () => box.text, set: (t) => (box.text = t), setPartial: (t) => (box.partial = t)},
    submit: (text, medium) => sent.push({text, medium}),
    hotwords: () => ['print', 'stack a'],
    settings: () => ({bargeIn: false, wakePhrase: false, fallbackAllowed: false, ...settings}),
    isWaiting: () => waiting,
    echoCancelled: () => echoCancelled,
    onEvent: (kind) => events.push(kind),
    onMicrophoneState: (state) => microphoneStates.push(state),
    now: () => clock.t,
  });
  made.push(controller);
  return {controller, recognizer, output, log, box, sent, events, clock, microphoneStates};
}

function fakeVad() {
  const v = {handlers: null, ready: async () => {}, async start(h) {
    v.handlers = h;
  }, stop: () => (v.handlers = null)};
  return v;
}

suite('Voice conversation', function() {
  teardown(function() {
    made.splice(0).forEach((c) => c.dispose());
  });

  test('draft: recognizer text is lower case and joins what is already there', function() {
    assert.equal(cleanTranscript('  PRINT   HELLO '), 'print hello');
    assert.equal(appendToDraft('', 'ADD A PRINT BLOCK'), 'add a print block');
    assert.equal(appendToDraft('add a print', 'BLOCK AFTER IT'), 'add a print block after it');
  });

  test('the microphone opens after "I\'m listening." has been said, then the listening cue; no greeting the second time', async function() {
    const {controller, recognizer, log} = setup();
    await controller.start();
    assert.equal(controller.state(), SessionState.ACTIVE);
    assert.deepEqual(recognizer.calls, ['ready', 'hotwords:print,stack a', 'start']);
    assert.deepEqual(log, ["ai:I'm listening.", 'cue:listeningOn']);
    controller.end();
    await controller.start();
    assert.deepEqual(log.slice(2), ['cue:listeningOff', 'cue:listeningOn']);
  });

  test('finished words go into the draft, words still heard on their own line; send includes both', async function() {
    const {controller, recognizer, box, sent, clock} = setup();
    await controller.start();
    clock.t += 5000;
    box.text = 'please';
    recognizer.handlers.onFinal('ADD A PRINT BLOCK');
    recognizer.handlers.onPartial('AFTER THE');
    assert.equal(box.text, 'please add a print block');
    assert.equal(box.partial, 'after the');
    controller.send();
    assert.deepEqual(sent, [{text: 'please add a print block after the', medium: 'voice'}]);
    assert.equal(box.text, '');
  });

  test('without barge-in the microphone is ignored while the AI voice speaks and for a moment after', async function() {
    const {controller, recognizer, output} = setup();
    await controller.start();
    recognizer.calls.length = 0;
    output.setState('speaking');
    output.setState('silent');
    assert.deepEqual(recognizer.calls, ['pause']);
    await settle(TAIL_MS / 2);
    assert.deepEqual(recognizer.calls, ['pause'], 'still the tail');
    await settle(TAIL_MS / 2 + 50);
    assert.deepEqual(recognizer.calls, ['pause', 'resume']);
  });

  test('the assistant\'s own words never reach the draft: "Say yes to do it" is not a yes', async function() {
    const {controller, recognizer, output, box, clock} = setup({settings: {bargeIn: true}, vad: fakeVad()});
    await controller.start();
    clock.t += 5000;
    output.setState('speaking');
    output.speak('Step 1 of 2: Count by 5. Say yes to do it, or stop.');
    recognizer.handlers.onFinal('YES');
    recognizer.handlers.onFinal('SAY YES TO DO IT');
    output.setState('silent');
    clock.t += 200;
    recognizer.handlers.onFinal('YES TO DO IT OR STOP');
    assert.equal(box.text, '', 'heard while or right after it spoke');
    clock.t += 3000;
    recognizer.handlers.onFinal('YES');
    assert.equal(box.text, 'yes', 'the learner\'s own yes, later');
  });

  test('barge-in: speech of 250 ms with words that aren\'t the assistant\'s stops it; shorter speech doesn\'t', async function() {
    const vad = fakeVad();
    const {controller, recognizer, output, log, box, clock} = setup({settings: {bargeIn: true}, vad});
    await controller.start();
    clock.t += 5000;
    output.setState('speaking');
    output.speak('I can make it count by five.');
    vad.handlers.onSpeechStart();
    clock.t += 100;
    recognizer.handlers.onPartial('WAIT');
    assert.notInclude(log, 'interrupt', 'too short yet');
    clock.t += 200;
    recognizer.handlers.onPartial('WAIT USE TEN');
    assert.include(log, 'interrupt');
    assert.equal(box.partial, 'wait use ten');
  });

  test('barge-in needs the AI voice the page plays: with a system voice the microphone waits while it speaks', async function() {
    const vad = fakeVad();
    const {controller, recognizer, output, log, clock} = setup({settings: {bargeIn: true}, vad, echoCancelled: false});
    await controller.start();
    clock.t += 5000;
    recognizer.calls.length = 0;
    output.setState('speaking');
    assert.deepEqual(recognizer.calls, ['pause']);
    vad.handlers.onSpeechStart();
    clock.t += 1000;
    recognizer.handlers.onPartial('WAIT USE TEN');
    assert.notInclude(log, 'interrupt');
  });

  test('its own voice misheard is still its own: words are compared by sound, numbers as words', async function() {
    const vad = fakeVad();
    const {controller, recognizer, output, log, box, clock} = setup({settings: {bargeIn: true}, vad});
    await controller.start();
    clock.t += 5000;
    output.setState('speaking');
    output.speak('I can add a print block after the loop, 5 times.');
    vad.handlers.onSpeechStart();
    clock.t += 1000;
    recognizer.handlers.onPartial('OUT OF PRINT BLOCK AFTER THE LOUVRE');
    recognizer.handlers.onFinal('OUT OF PRINT BLOCK AFTER THE LOUVRE FIVE TIMES');
    assert.notInclude(log, 'interrupt');
    assert.equal(box.text, '');
  });

  test('navigation speech heard back is dropped; the learner\'s own words still reach the draft', async function() {
    const {controller, recognizer, output, box, clock} = setup();
    await controller.start();
    clock.t += 5000;
    output.announce('Repeat 5 times block, block 3 of stack A');
    clock.t += 300;
    recognizer.handlers.onFinal('REPEAT FIVE TIMES BLOCK BLOCK THREE OF STACK A');
    assert.equal(box.text, '');
    clock.t += 200;
    recognizer.handlers.onFinal('WHAT DOES THIS DO');
    assert.equal(box.text, 'what does this do');
  });

  test('I stops the AI voice and listens; with no words in 2 s the cut sentence plays again', async function() {
    this.timeout(5000);
    const {controller, log} = setup();
    await controller.start();
    await controller.talk();
    assert.include(log, 'interrupt');
    await settle(2100);
    assert.include(log, 'replay');
  });

  test('idle: after a minute with nothing going on the session suspends, after saying so', async function() {
    this.timeout(5000);
    const {controller, log, clock} = setup();
    await controller.start();
    clock.t += 61000;
    await settle(1100);
    assert.equal(controller.state(), SessionState.INACTIVE);
    assert.include(log, "ai:I'll stop listening now. Press Control Shift V when you need me.");
  });

  test('"end conversation" ends the session instead of being sent, and mentions a waiting answer', async function() {
    const {controller, box, sent, log} = setup({waiting: true});
    await controller.start();
    box.text = 'end conversation';
    controller.send();
    assert.isEmpty(sent);
    assert.equal(controller.state(), SessionState.INACTIVE);
    assert.include(log, "ai:Okay, I'll stop listening. I'm still waiting for your answer when you come back.");
  });

  test('the wake phrase listens only while no session is active, and starts one', async function() {
    const spotter = {calls: [], ready: async () => {}, async start(h) {
      spotter.calls.push('start');
      spotter.handlers = h;
    }, stop: () => spotter.calls.push('stop')};
    const {controller} = setup({settings: {wakePhrase: true}, spotter});
    await controller.refreshWake();
    assert.deepEqual(spotter.calls, ['start']);
    spotter.handlers.onWake('hey_neon');
    await settle(30);
    assert.equal(controller.state(), SessionState.ACTIVE);
    assert.deepEqual(spotter.calls, ['start', 'stop']);
    controller.end();
    await settle();
    assert.deepEqual(spotter.calls, ['start', 'stop', 'start']);
  });

  test('mic off stops recognition and voice activity, blocks wake listening, and announces its state', async function() {
    const spotter = fakeSpotter();
    const vad = fakeVad();
    const {controller, recognizer, log, box, microphoneStates} = setup({settings: {wakePhrase: true, bargeIn: true}, spotter, vad});
    await controller.start();
    const late = recognizer.handlers;
    controller.micOff();
    await controller.refreshWake();
    assert.equal(controller.state(), SessionState.INACTIVE);
    assert.equal(controller.microphoneState(), 'off');
    assert.include(recognizer.calls, 'stop');
    assert.isNull(vad.handlers);
    assert.isEmpty(spotter.calls);
    assert.include(log, 'sys:Microphone off.');
    assert.equal(microphoneStates.at(-1), 'off');
    late.onFinal('ADD A PRINT BLOCK');
    assert.equal(box.text, '', 'late callbacks cannot add words after mic off');
  });

  test('mic off from wake-only listening preserves the preference but requires an explicit start', async function() {
    const settings = {wakePhrase: true};
    const spotter = fakeSpotter();
    const {controller} = setup({settings, spotter});
    await controller.refreshWake();
    assert.equal(controller.microphoneState(), 'wake');
    const lateWake = spotter.handlers.onWake;
    controller.toggleMicrophone();
    assert.equal(controller.microphoneState(), 'off');
    settings.wakePhrase = false;
    await controller.refreshWake();
    settings.wakePhrase = true;
    await controller.refreshWake();
    lateWake();
    await settle();
    assert.equal(controller.state(), SessionState.INACTIVE);
    assert.deepEqual(spotter.calls, ['start', 'stop']);
    await controller.toggleMicrophone();
    assert.equal(controller.state(), SessionState.ACTIVE);
    controller.end();
    await settle();
    assert.equal(controller.microphoneState(), 'wake', 'ending a conversation still permits wake listening');
    assert.isTrue(settings.wakePhrase);
  });

  test('mic off while recognition loads prevents greeting, capture and wake restart', async function() {
    const ready = deferred();
    const recognizer = fakeRecognizer();
    recognizer.ready = () => ready.promise;
    const spotter = fakeSpotter();
    const {controller, log} = setup({recognizer, settings: {wakePhrase: true}, spotter});
    const starting = controller.start();
    await settle();
    controller.toggleMicrophone();
    ready.resolve();
    await starting;
    assert.equal(controller.microphoneState(), 'off');
    assert.notInclude(recognizer.calls, 'start');
    assert.notInclude(log, "ai:I'm listening.");
    assert.isEmpty(spotter.calls);
  });

  test('mic off during a pending recognizer start stops it again when it finishes', async function() {
    const started = deferred();
    const entered = deferred();
    let capturing = false;
    const recognizer = fakeRecognizer();
    recognizer.start = async () => {
      entered.resolve();
      await started.promise;
      capturing = true;
    };
    recognizer.stop = () => (capturing = false);
    const {controller} = setup({recognizer});
    const starting = controller.start();
    await entered.promise;
    controller.micOff();
    started.resolve();
    await starting;
    assert.isFalse(capturing);
    assert.equal(controller.state(), SessionState.INACTIVE);
  });

  test('mic off during a pending voice activity start cannot reactivate the session', async function() {
    const started = deferred();
    const entered = deferred();
    const vad = fakeVad();
    vad.start = async (handlers) => {
      entered.resolve();
      await started.promise;
      vad.handlers = handlers;
    };
    const {controller, recognizer, events} = setup({vad, settings: {bargeIn: true}});
    const starting = controller.start();
    await entered.promise;
    controller.micOff();
    started.resolve();
    await starting;
    assert.isNull(vad.handlers);
    assert.include(recognizer.calls, 'stop');
    assert.equal(controller.state(), SessionState.INACTIVE);
    assert.notInclude(events, 'session.started');
  });

  test('mic off during a pending wake start stops it again and ignores its callback', async function() {
    const started = deferred();
    const entered = deferred();
    const spotter = fakeSpotter();
    let capturing = false;
    spotter.start = async (handlers) => {
      spotter.handlers = handlers;
      entered.resolve();
      await started.promise;
      capturing = true;
    };
    spotter.stop = () => (capturing = false);
    const {controller, events} = setup({spotter, settings: {wakePhrase: true}});
    const starting = controller.refreshWake();
    await entered.promise;
    controller.micOff();
    started.resolve();
    await starting;
    spotter.handlers.onWake();
    await settle();
    assert.isFalse(capturing);
    assert.equal(controller.state(), SessionState.INACTIVE);
    assert.notInclude(events, 'session.wake');
  });

  test('a quick mic off and on waits for the cancelled start before reopening the recognizer', async function() {
    const started = deferred();
    const entered = deferred();
    const recognizer = fakeRecognizer();
    let starts = 0;
    let capturing = false;
    recognizer.start = async () => {
      starts += 1;
      if (starts === 1) {
        entered.resolve();
        await started.promise;
      }
      capturing = true;
    };
    recognizer.stop = () => (capturing = false);
    const {controller} = setup({recognizer});
    const first = controller.start();
    await entered.promise;
    controller.micOff();
    const second = controller.start();
    await settle();
    assert.equal(starts, 1);
    started.resolve();
    await Promise.all([first, second]);
    assert.equal(starts, 2);
    assert.isTrue(capturing);
    assert.equal(controller.state(), SessionState.ACTIVE);
  });

  test('disposal stops all listeners and cannot start wake or recognition again', async function() {
    const spotter = fakeSpotter();
    const {controller, recognizer} = setup({spotter, settings: {wakePhrase: true}});
    await controller.start();
    controller.dispose();
    await controller.refreshWake();
    await controller.start();
    assert.equal(controller.microphoneState(), 'off');
    assert.equal(recognizer.calls.filter((call) => call === 'start').length, 1);
    assert.isEmpty(spotter.calls);
  });

  test('the fallback recognizer only when the task allows it, with a notice', async function() {
    const fallback = fakeRecognizer();
    let s = setup({recognizer: fakeRecognizer({fail: 'load'}), fallback, settings: {fallbackAllowed: true}});
    await s.controller.start();
    assert.equal(s.controller.state(), SessionState.ACTIVE);
    assert.match(s.log[0], /browser's speech recognition/);
    s = setup({recognizer: fakeRecognizer({fail: 'load'}), fallback: fakeRecognizer()});
    await s.controller.start();
    assert.equal(s.controller.state(), SessionState.INACTIVE);
    assert.match(s.log[0], /not set up/);
  });

  test('cancelling fallback loading does not skip its notice when listening starts again', async function() {
    const ready = deferred();
    const entered = deferred();
    const fallback = fakeRecognizer();
    fallback.ready = async () => {
      entered.resolve();
      await ready.promise;
    };
    const {controller, log} = setup({recognizer: fakeRecognizer({fail: 'load'}), fallback, settings: {fallbackAllowed: true}});
    const starting = controller.start();
    await entered.promise;
    controller.micOff();
    ready.resolve();
    await starting;
    await controller.start();
    assert.equal(controller.state(), SessionState.ACTIVE);
    assert.equal(log.filter((line) => line.includes("browser's speech recognition")).length, 1);
  });

  test('a refused microphone is said and the session stays off; ending while loading leaves the microphone closed', async function() {
    const s = setup({recognizer: fakeRecognizer({fail: 'mic'})});
    await s.controller.start();
    assert.equal(s.controller.state(), SessionState.INACTIVE);
    assert.include(s.log.join(' '), 'microphone');
    const t = setup();
    const starting = t.controller.start();
    t.controller.end();
    await starting;
    assert.equal(t.controller.state(), SessionState.INACTIVE);
    assert.notInclude(t.recognizer.calls, 'start');
  });
});

suite('Echo words', function() {
  test('spoken as the recognizer writes them', function() {
    assert.deepEqual(spokenWords("I'm on step 25."), ['i', 'am', 'on', 'step', 'twenty', 'five']);
  });

  test('misheard words sound alike; different words don\'t', function() {
    assert.isTrue(soundsAlike('print', 'prince'));
    assert.isTrue(soundsAlike('print', 'prints'));
    assert.isFalse(soundsAlike('does', 'times'));
    assert.isFalse(soundsAlike('yes', 'no'));
    assert.isFalse(soundsAlike('add', 'it'));
    assert.equal(playedShare(['wait', 'use', 'ten'], spokenWords('I can count by 5.')), 0);
  });
});

suite('Page voice', function() {
  function fakeContext(log) {
    return {
      state: 'running',
      destination: {},
      createBuffer: (channels, length, rate) => ({length, rate, copyToChannel: () => {}}),
      createBufferSource() {
        const source = {connect: () => {}, start: () => {
          log.push('start');
          setTimeout(() => source.onended?.(), 5);
        }, stop: () => log.push('stop')};
        return source;
      },
    };
  }
  const synth = (log) => ({ready: async () => {}, synthesize: async (text, {speed}) => {
    log.push(`make:${text}@${speed}`);
    return {samples: new Float32Array(100), sampleRate: 22050};
  }});

  test('the next sentence is made early once; speaking plays it, and an abort stops it', async function() {
    const log = [];
    const voice = pageVoice({synth: synth(log), createContext: () => fakeContext(log)});
    assert.isTrue(voice.playsInPage());
    voice.prepare('Two.', {rate: 1.2});
    await voice.speak('Two.', {rate: 1.2});
    assert.deepEqual(log, ['make:Two.@1.2', 'start', 'stop']);
    const abort = new AbortController();
    const speaking = voice.speak('Three.', {signal: abort.signal});
    await settle(1);
    abort.abort();
    await speaking;
    assert.includeMembers(log, ['make:Three.@1']);
  });

  test('the AI voice is the page voice once loaded, unless the learner picked a system voice', async function() {
    const spoken = [];
    const voice = (name, playsInPage) => ({ready: async () => {}, speak: async () => spoken.push(name), cancel: () => {},
      playsInPage: () => playsInPage});
    let picked = false;
    const ai = preferPageVoice({page: voice('page', true), native: voice('native', false), systemPicked: () => picked});
    await ai.speak('Hi.');
    assert.isFalse(ai.playsInPage());
    await ai.ready();
    await ai.speak('Hi.');
    assert.isTrue(ai.playsInPage());
    picked = true;
    await ai.speak('Hi.');
    assert.deepEqual(spoken, ['native', 'page', 'native']);
  });
});
