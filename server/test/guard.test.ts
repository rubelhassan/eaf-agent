// The guard: masking, restoring, and the core keeping originals away from the model and the logs.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {maskCall, maskProgram, newMaskMap, restore} from '../src/guard/mask.js';
import {loadNer, spans} from '../src/guard/ner.js';
import {createGuard} from '../src/guard/index.js';
import {createAgentCore, type ModelReply, type Provider} from '../src/core.js';
import {createRouting} from '../src/models/router.js';
import {openLogs} from '../src/store/logs.js';
import {envelopeProblems, type AgentCall} from '../src/envelope.js';
import {buildApp} from '../src/app.js';
import {createRequire} from 'node:module';
import type {Entity} from '../src/guard/ner.js';

// The client the browser uses (loaded through require, as in app.test.ts).
const {createAgentServerClient} = createRequire(import.meta.url)('../../src/agent/model/server_client.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NER_NAME = JSON.parse(fs.readFileSync(path.join(root, 'ner_models.json'), 'utf8')).use;
const hasModel = fs.existsSync(path.join(root, 'models', NER_NAME, 'onnx', 'model_quantized.onnx'));

const call = (learnerText: string, input: Record<string, unknown> = {scope: 'program', wordLimit: 50, program: 'Stack A'}): AgentCall =>
  ({requestId: 'r_1', task: 'COMPREHEND', learnerText, input, session: {id: 's_1', learnerCode: 'P07'}});

test('mask: patterns and cue phrases in the learner\'s words; program text keeps names', async () => {
  const {call: masked, map} = await maskCall(call('my name is ava thompson, email ava.t@example.com, call 940-555-0142. ' +
    "I'm 9 and I go to lincoln elementary. i live in denton. my insta is @ava_codes_2016. I live at 42 Maple Street.",
  {scope: 'program', wordLimit: 50, program: 'Stack A\n1. [b1] text_print TEXT=([b2] text TEXT="Hi Ava, mail sam@example.org")'}), null);
  assert.equal(masked.learnerText, 'my name is NAME_1, email EMAIL_1, call PHONE_1. I\'m AGE_1 and I go to SCHOOL_1. ' +
    'i live in LOCATION_1. my insta is HANDLE_1. I live at ADDRESS_1.');
  assert.equal(masked.input.program, 'Stack A\n1. [b1] text_print TEXT=([b2] text TEXT="Hi Ava, mail EMAIL_2")');
  assert.equal(map.values.get('NAME_1'), 'ava thompson');
  assert.equal(map.values.get('SCHOOL_1'), 'lincoln elementary');
});

test('mask: the same value gets the same id; the task so far is masked inside its quotes', async () => {
  const input = {program: 'Stack A', taskContext: 'Task: edit, revision 2\nLearner asked: "email ava.t@example.com"\nYou last said: "Done."'};
  const {call: masked} = await maskCall({...call('send it to ava.t@example.com'), task: 'EDIT_GUIDE', input}, null);
  assert.equal(masked.learnerText, 'send it to EMAIL_1');
  assert.equal(masked.input.taskContext, 'Task: edit, revision 2\nLearner asked: "email EMAIL_1"\nYou last said: "Done."');
});

test('mask: everyday coding words are left alone', async () => {
  for (const text of ['repeat 4 times the same way', 'change the 5 to 6', 'I am done', 'in high school we use loops',
    'call me when it runs', 'what does block 3 of stack A do']) {
    const {call: masked} = await maskCall(call(text), null);
    assert.equal(masked.learnerText, text, text);
  }
});

test('restore: values back in the reply, JSON-escaped; an id the request never had is reported', () => {
  const map = newMaskMap();
  maskProgram('mail ava@example.com', map);
  map.values.set('NAME_1', 'Ava "AJ" Lee');
  const {text, unknown} = restore('{"voiceLine":"NAME_1 mails EMAIL_1, not NAME_4."}', map);
  assert.equal(text, '{"voiceLine":"Ava \\"AJ\\" Lee mails ava@example.com, not NAME_4."}');
  assert.deepEqual(unknown, ['NAME_4']);
});

test('ner spans: word pieces are found back in the text', () => {
  const text = 'My name is Ava Thompson from Denton.';
  const found = spans(text, [{entity: 'B-PER', score: 0.99, index: 4, word: 'Ava'}, {entity: 'I-PER', score: 0.99, index: 5, word: 'Thom'},
    {entity: 'I-PER', score: 0.99, index: 6, word: '##pson'}, {entity: 'B-LOC', score: 0.9, index: 8, word: 'Denton'}]);
  assert.deepEqual(found.map((e) => [e.type, text.slice(e.start, e.end)]), [['PER', 'Ava Thompson'], ['LOC', 'Denton']]);
  const piece = spans('tell zara hi', [{entity: 'B-PER', score: 0.9, index: 2, word: 'z'}]);
  assert.deepEqual(piece.map((e) => 'tell zara hi'.slice(e.start, e.end)), ['zara'], 'a tagged first piece masks the whole word');
});

test('the name finder masks capitalized names and places', {skip: !hasModel && 'run npm run models'}, async () => {
  const ner = await loadNer(NER_NAME, path.join(root, 'models'));
  const {call: masked} = await maskCall(call('Tell Maya Lopez that my program from Austin works.'), ner);
  assert.equal(masked.learnerText, 'Tell NAME_1 that my program from LOCATION_1 works.');
});

function setup(replies: string[]) {
  const sent: Array<Record<string, any>> = [];
  const provider: Provider = {
    async complete(payload): Promise<ModelReply> {
      sent.push(payload);
      return {text: replies.length > 1 ? replies.shift()! : replies[0], usage: {}, latencyMs: 1};
    },
  };
  const logs = openLogs(':memory:');
  const core = createAgentCore({routing: createRouting({tasks: {'*': {model: 'm'}}, providers: {}}, {openrouter: provider}),
    log: logs, guard: createGuard({ner: null})});
  return {core, sent, logs};
}

test('core: the model and the logs see only ids; the reply, the repair problems and the verdict are handled', async () => {
  const {core, sent, logs} = setup(['{"voiceLine":"Hi NAME_1"}', '{"voiceLine":"Hi NAME_1, it prints."}']);
  const first = await core.call(call('my name is ava, what does it print?'));
  assert.equal(first.status === 'ok' && first.reply, '{"voiceLine":"Hi ava"}');
  await core.call({...call('my name is ava, what does it print?'), repair: {problems: ['voiceLine "Hi ava" is too short']}});
  core.result({requestId: 'r_1', valid: true, problems: ['voiceLine "Hi ava" was fine']});
  const everything = JSON.stringify(sent) + JSON.stringify(logs.db.prepare('SELECT * FROM calls').all()) +
    JSON.stringify(logs.db.prepare('SELECT * FROM results').all());
  assert.ok(!/\bava\b/i.test(everything), everything);
  assert.match(sent[1].messages.at(-1).content, /voiceLine "Hi NAME_1" is too short/);
});

test('core: an id the request never had comes back as a problem', async () => {
  const {core} = setup(['{"voiceLine":"Hi NAME_2"}']);
  const r = await core.call(call('my name is ava'));
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.meta?.problems, ['the reply has NAME_2, which is not in the request; keep only the ids the request has, as written']);
});

/** A name finder that tags the given phrases as people, as the model tags "Neon" today. */
const namesFinder = (...names: string[]) => async (text: string): Promise<Entity[]> =>
  names.flatMap((n) => [...text.matchAll(new RegExp(`\\b${n}\\b`, 'g'))].map((m) => ({type: 'PER' as const, start: m.index,
    end: m.index + n.length, score: 1})));
const named = (learnerText: string, assistantName?: string | null) =>
  ({...call(learnerText), session: {id: 's_1', learnerCode: null, ...(assistantName === undefined ? {} : {assistantName})}});

test('envelope: the assistant name is one word of letters, 1 to 32 long', () => {
  for (const ok of ['Neon', 'nova', 'A', 'x'.repeat(32), null]) assert.deepEqual(envelopeProblems(named('hi', ok)), [], String(ok));
  for (const bad of ['', 'Ms Bot', 'Neon2', 'Zoë', 'x'.repeat(33), 'Ne-on']) {
    assert.deepEqual(envelopeProblems(named('hi', bad)),
      ['call.session.assistantName must be one word of letters (A to Z), 1 to 32 long'], bad);
  }
  assert.deepEqual(envelopeProblems({...named('hi'), session: {id: 's_1', assistantName: 7}}), ['call.session.assistantName must be string']);
});

test('mask: the assistant name is kept, whole words only; names next to it, emails and handles are still masked', async () => {
  const ner = namesFinder('Neon Zoe', 'Neon', 'Zoe', 'Neona', 'neon', 'Nova');
  const masked = async (text: string, name?: string | null) => (await maskCall(named(text, name), ner)).call.learnerText;
  assert.equal(await masked('Neon, what does this do?'), 'Neon, what does this do?', 'Neon by default');
  assert.equal(await masked('hey neon, ask my friend Zoe'), 'hey neon, ask my friend NAME_1', 'any case');
  assert.equal(await masked('tell Neon Zoe hi'), 'tell Neon NAME_1 hi', 'the name next to it');
  assert.equal(await masked('Neona says hi'), 'NAME_1 says hi', 'a longer word is not the name');
  assert.equal(await masked('mail neon@example.com or @neon_fan'), 'mail EMAIL_1 or HANDLE_1');
  assert.equal(await masked('call me Neon'), 'call me Neon', 'a cue phrase too');
  assert.equal(await masked('Nova, what about Neon?', 'Nova'), 'Nova, what about NAME_1?', 'only the configured name');
  const context = {program: 'Stack A', taskContext: 'Task: edit\nLearner asked: "Neon, add Zoe"'};
  const {call: inContext} = await maskCall({...named('again'), task: 'EDIT_GUIDE', input: context}, ner);
  assert.equal(inContext.input.taskContext, 'Task: edit\nLearner asked: "Neon, add NAME_1"', 'the task so far');
});

test('the name finder keeps the assistant name and masks a friend', {skip: !hasModel && 'run npm run models'}, async () => {
  const ner = await loadNer(NER_NAME, path.join(root, 'models'));
  // Without the rule the model tags this Neon as a person.
  const {call: masked} = await maskCall(named('Neon, help me and my friend Zoe'), ner);
  assert.equal(masked.learnerText, 'Neon, help me and my friend NAME_1');
});

test('over HTTP: the browser client sends the name; the model gets Neon and not Zoe; a bad name is refused', async () => {
  const sent: Array<Record<string, any>> = [];
  const provider: Provider = {async complete(payload) {
    sent.push(payload);
    return {text: '{"voiceLine":"NAME_1 made a loop."}', usage: {}, latencyMs: 1};
  }};
  const core = createAgentCore({routing: createRouting({tasks: {'*': {model: 'm'}}, providers: {}}, {openrouter: provider}),
    guard: createGuard({ner: namesFinder('Neon', 'Zoe')})});
  const app = await buildApp({core, health: () => ({keySet: true})});
  const url = await app.listen({host: '127.0.0.1', port: 0});
  try {
    const client = createAgentServerClient({url, session: {id: 's_1', learnerCode: null, assistantName: 'Neon'}});
    const reply = await client.call({...call('Neon, what does this do? my friend Zoe made it'), session: undefined});
    const asked = JSON.stringify(sent[0].messages);
    assert.match(asked, /Neon, what does this do\? my friend NAME_1 made it/);
    assert.ok(!/Zoe/.test(asked), asked);
    assert.equal(reply.reply, '{"voiceLine":"Zoe made a loop."}');
    const bad = createAgentServerClient({url, session: {id: 's_1', assistantName: 'Neon Bot'}});
    const refused = await bad.call({...call('hi'), requestId: 'r_2', session: undefined});
    assert.equal(refused.code, 'INVALID_ENVELOPE');
    assert.equal(sent.length, 1, 'a refused call never reaches the model');
  } finally {
    await app.close();
  }
});
