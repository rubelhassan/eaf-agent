/**
 * The output manager: one timeline for the AI voice, navigation speech and cues. Fake voices and cues log what
 * would be heard; a manual voice holds each sentence until the test finishes it.
 */
import {assert} from 'chai';
import {createOutputManager} from '../src/output/output_manager.js';
import {splitSentences} from '../src/output/sentences.js';
import {localVoices, nativeAiVoice, preferPageVoice, systemVoice} from '../src/output/voices.js';

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeVoice(name, log, {manual = false} = {}) {
  const pending = [];
  return {
    ready: async () => {},
    speak(text, {signal} = {}) {
      log.push(`${name}:${text}`);
      return new Promise((resolve) => {
        const stop = () => {
          log.push(`${name} stopped`);
          pending.splice(pending.indexOf(done), 1);
          resolve();
        };
        const done = () => {
          signal?.removeEventListener('abort', stop);
          resolve();
        };
        signal?.addEventListener('abort', stop, {once: true});
        if (manual) pending.push(done);
        else setTimeout(done, 2);
      });
    },
    finish: () => pending.shift()?.(),
    cancel() {},
  };
}

function setup({manual = false, settings = {}} = {}) {
  const log = [];
  const live = {
    set textContent(v) {
      if (v) log.push(`live:${v.replace(/[​ ]$/, '')}`);
    },
  };
  const ai = fakeVoice('ai', log, {manual});
  const system = fakeVoice('sys', log);
  const cues = {
    play(name) {
      log.push(`cue:${name}`);
      return new Promise((resolve) => setTimeout(resolve, 1));
    },
    setVolume() {},
    dispose() {},
  };
  const output = createOutputManager({aiVoice: ai, systemVoice: system, liveRegion: live, settings, cues});
  return {output, log, ai};
}

const nav = (text, cue) => ({text, source: 'navigation', kind: 'navigation', cue});
const ai = (text, extra = {}) => ({text, source: 'ai', kind: 'answer', ...extra});

suite('On-device voices', function() {
  let originalUtterance;
  let made;
  const local = {name: 'Local', lang: 'en-US', localService: true, default: false};
  const remote = {name: 'Network', lang: 'en-US', localService: false, default: true};

  suiteSetup(function() {
    originalUtterance = globalThis.SpeechSynthesisUtterance;
    made = [];
    globalThis.SpeechSynthesisUtterance = class {
      constructor(text) {
        this.text = text;
        made.push(this);
      }
    };
  });

  teardown(function() {
    made.length = 0;
  });

  suiteTeardown(function() {
    if (originalUtterance === undefined) delete globalThis.SpeechSynthesisUtterance;
    else globalThis.SpeechSynthesisUtterance = originalUtterance;
  });

  function synth(voices) {
    return {getVoices: () => voices, speak: (utterance) => utterance.onend(), cancel() {}};
  }

  test('only voices explicitly marked on-device and English are offered', function() {
    assert.deepEqual(localVoices(synth([local, remote, {name: 'Unknown', lang: 'en-US'},
      {...local, name: 'French', lang: 'fr-FR'}])), [local]);
  });

  test('no local voice means no utterance, including the native AI fallback', async function() {
    for (const voices of [[], [remote], [{name: 'Unknown', lang: 'en-US'}]]) {
      for (const factory of [systemVoice, nativeAiVoice]) {
        const voice = factory({synth: synth(voices)});
        assert.isFalse(voice.available());
        await voice.speak('Keep these words on this device.');
      }
    }
    assert.isEmpty(made);
    assert.isFalse(systemVoice({synth: null}).available());
  });

  test('an available local voice is used even when the default is remote', async function() {
    const voice = systemVoice({synth: synth([remote, local])});
    assert.isTrue(voice.available());
    await voice.speak('Stack A.');
    assert.strictEqual(made[0].voice, local);
  });

  test('a chosen local voice wins; a missing or remote choice falls back locally', async function() {
    const chosen = {...local, name: 'Chosen'};
    const browser = synth([remote, {...local, default: true}, chosen]);
    for (const name of ['Chosen', 'Network', 'Removed']) {
      await systemVoice({synth: browser, voice: () => name}).speak('Stack A.');
    }
    assert.strictEqual(made[0].voice, chosen);
    assert.equal(made[1].voice.name, 'Local');
    assert.equal(made[2].voice.name, 'Local');
  });

  test('voice availability is checked again for every sentence', async function() {
    let voices = [local];
    const voice = systemVoice({synth: {...synth([]), getVoices: () => voices}});
    await voice.speak('One.');
    voices = [remote];
    assert.isFalse(voice.available());
    await voice.speak('Two.');
    assert.lengthOf(made, 1);
    voices = [local];
    assert.isTrue(voice.available());
    await voice.speak('Three.');
    assert.lengthOf(made, 2);
  });

  test('the preferred AI voice becomes available when the page voice loads', async function() {
    let picked = false;
    const page = {ready: async () => {}, speak: async () => {}, cancel() {}};
    const voice = preferPageVoice({page, native: nativeAiVoice({synth: synth([remote])}), systemPicked: () => picked});
    assert.isFalse(voice.available());
    await voice.ready();
    assert.isTrue(voice.available());
    picked = true;
    assert.isFalse(voice.available());
  });
});

suite('Output manager', function() {
  test('sentences: numbers and abbreviations stay whole', function() {
    assert.deepEqual(splitSentences('Set it to 2.5. Then print.'), ['Set it to 2.5.', 'Then print.']);
    assert.deepEqual(splitSentences('Use a loop, e.g. repeat. Done'), ['Use a loop, e.g. repeat.', 'Done']);
    assert.deepEqual(splitSentences('Is it 5? Yes!'), ['Is it 5?', 'Yes!']);
  });

  test('an AI turn: one earcon, then each sentence in the AI voice, never in the live region', async function() {
    const {output, log} = setup();
    output.say(ai('First one. Second one.'));
    await settle();
    assert.deepEqual(log, ['cue:aiTurn', 'ai:First one.', 'ai:Second one.']);
  });

  test('navigation goes to the live region, or to the system voice in that mode', async function() {
    const sr = setup();
    sr.output.say(nav('stack A'));
    await settle();
    assert.deepEqual(sr.log, ['live:stack A']);
    const voice = setup({settings: {systemOutput: 'systemVoice'}});
    voice.output.say(nav('stack A'));
    await settle();
    assert.deepEqual(voice.log, ['sys:stack A']);
  });

  test('announced lines are reported (so the microphone can ignore them); AI sentences are not', async function() {
    const {output} = setup();
    const heard = [];
    output.onAnnounce((text) => heard.push(text));
    output.say(nav('stack A'));
    await settle();
    output.say(ai('Hello.'));
    await settle();
    assert.deepEqual(heard, ['stack A']);
  });

  test('navigation replaces waiting navigation, with its cue', async function() {
    const {output, log} = setup();
    output.say(nav('block 1', 'enteredStack'));
    output.say(nav('block 2'));
    await settle();
    assert.deepEqual(log, ['live:block 2']);
  });

  test('a cue plays before its words; a connected cue joins the waiting message', async function() {
    const {output, log} = setup();
    output.say(nav('Not compatible.', 'rejected'));
    await settle();
    output.say(nav('Inserted print block.'));
    output.cue('connected');
    output.cue('connected');
    await settle();
    assert.deepEqual(log, ['cue:rejected', 'live:Not compatible.', 'cue:connected', 'live:Inserted print block.']);
  });

  test('the same cue on its own twice within 100 ms plays once', async function() {
    const {output, log} = setup();
    output.cue('connected');
    await settle(5);
    output.cue('connected');
    await settle();
    assert.deepEqual(log, ['cue:connected']);
  });

  test('after interrupt no sentence of the old turn is spoken', async function() {
    const {output, log, ai: voice} = setup({manual: true});
    output.say(ai('One. Two.'));
    await settle();
    output.say(ai('Three.'));
    output.interrupt();
    voice.finish();
    await settle();
    assert.deepEqual(log, ['cue:aiTurn', 'ai:One.', 'ai stopped']);
    assert.equal(output.state(), 'silent');
  });

  test('navigation cuts the AI voice, and repeat replays the turn', async function() {
    const {output, log, ai: voice} = setup({manual: true});
    output.say(ai('One. Two.'));
    await settle();
    output.say(nav('stack B'));
    await settle();
    output.repeat();
    await settle();
    voice.finish();
    await settle();
    assert.deepEqual(log, ['cue:aiTurn', 'ai:One.', 'ai stopped', 'live:stack B', 'cue:aiTurn', 'ai:One.', 'ai:Two.']);
  });

  test('a freeze cue pauses the AI voice and resumes from the start of the sentence, without the earcon', async function() {
    const {output, log, ai: voice} = setup({manual: true});
    output.say(ai('One. Two.'));
    await settle();
    voice.finish();
    await settle();
    output.say({text: 'The assistant is working.', source: 'system', kind: 'blocked', cue: 'blocked'});
    await settle();
    voice.finish();
    await settle();
    assert.deepEqual(log, ['cue:aiTurn', 'ai:One.', 'ai:Two.', 'ai stopped', 'cue:blocked', 'live:The assistant is working.', 'ai:Two.']);
  });

  test('progress: replaced by its task\'s answer, cut by a question, and never cuts anything', async function() {
    let {output, log} = setup();
    output.say(ai('Still working.', {kind: 'progress', taskId: 't1'}));
    output.say(ai('Done.', {taskId: 't1'}));
    await settle();
    assert.deepEqual(log, ['cue:aiTurn', 'ai:Done.']);

    const manual = setup({manual: true});
    manual.output.say(ai('Still working.', {kind: 'progress', taskId: 't1'}));
    await settle();
    manual.output.say(ai('Which loop?', {kind: 'question', taskId: 't1'}));
    await settle();
    assert.deepEqual(manual.log, ['cue:aiTurn', 'ai:Still working.', 'ai stopped', 'cue:aiTurn', 'ai:Which loop?']);

    ({output, log} = setup({manual: true}));
    output.say(ai('An answer.', {taskId: 't1'}));
    await settle();
    output.say(ai('Still working.', {kind: 'progress', taskId: 't2'}));
    await settle();
    assert.notInclude(log, 'ai stopped');
  });

  test('cues off silences every cue, the AI earcon too', async function() {
    const {output, log} = setup({settings: {cues: false}});
    output.say(ai('Hello.'));
    output.cue('connected');
    await settle();
    assert.deepEqual(log, ['ai:Hello.']);
  });

  test('state: speaking while the AI voice plays, silent after', async function() {
    const {output} = setup();
    const states = [];
    output.onState((s) => states.push(s));
    output.say(ai('Hello.'));
    await settle();
    assert.deepEqual(states, ['speaking', 'silent']);
  });

});
