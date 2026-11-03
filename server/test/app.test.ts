// The server over HTTP, with a fake provider: the browser's own server client, logs, health, CORS and abort.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../src/app.js';
import {createAgentCore, type ModelReply, type Provider} from '../src/core.js';
import {createRouting} from '../src/models/router.js';
import {openLogs} from '../src/store/logs.js';
import {createRequire} from 'node:module';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The client the browser uses. The plugin's package isn't marked as ES modules, so Node loads it through require.
const {createAgentServerClient} = createRequire(import.meta.url)('../../src/agent/model/server_client.js');

const CALL = {requestId: 'r_1', taskId: 't_1', revision: 1, task: 'COMPREHEND', learnerText: 'what is this',
  input: {scope: 'program', wordLimit: 50, program: 'Stack A\n1. [b1] text_print'}, policy: {activity: 'practice', wholePlan: false}};

function fakeProvider(replies: Array<string | ((signal?: AbortSignal) => Promise<ModelReply>)>) {
  const sent: Array<Record<string, any>> = [];
  const provider: Provider & {sent: typeof sent} = {
    sent,
    async complete(payload, {signal}) {
      sent.push(payload);
      const next = replies.length > 1 ? replies.shift()! : replies[0];
      return typeof next === 'string' ? {text: next, usage: {prompt_tokens: 10, completion_tokens: 2, cost: 0.0001}, latencyMs: 5} : next(signal);
    },
  };
  return provider;
}

async function start(provider: Provider) {
  const logs = openLogs(':memory:');
  const routing = createRouting({tasks: {'*': {model: 'big'}, INTENT: {model: 'small', promptVersion: 'v3'}}, providers: {}},
      {openrouter: provider});
  const app = await buildApp({core: createAgentCore({routing, log: logs}),
    health: () => ({version: 'test', models: {INTENT: 'small'}, promptVersions: {INTENT: 'v3'}, keySet: true})});
  const url = await app.listen({host: '127.0.0.1', port: 0});
  const client = createAgentServerClient({url, session: {id: 's_1', learnerCode: null}});
  return {app, logs, url, client};
}

test('a call through the browser client: rendered on the server, logged, with the session; the result is logged', async () => {
  const provider = fakeProvider([JSON.stringify({voiceLine: 'It prints.'})]);
  const {app, logs, client} = await start(provider);
  try {
    const reply = await client.call(CALL);
    assert.equal(reply.status, 'ok');
    assert.equal(reply.reply, '{"voiceLine":"It prints."}');
    assert.equal(reply.meta.model, 'big');
    assert.equal(reply.meta.promptVersion, 'v2');
    assert.equal(provider.sent[0].model, 'big');
    assert.match(provider.sent[0].messages[1].content, /^Learner asked: "what is this"\nScope: program\nWord limit: 50\n\nProgram:\n/);
    assert.deepEqual(provider.sent[0].provider, {data_collection: 'deny'});
    client.result({requestId: 'r_1', valid: true, problems: []});
    await new Promise((r) => setTimeout(r, 50));
    const row = logs.db.prepare('SELECT * FROM calls').get() as Record<string, any>;
    assert.equal(row.session_id, 's_1');
    assert.equal(row.task_id, 't_1');
    assert.equal(row.status, 'ok');
    assert.equal(row.tokens_in, 10);
    assert.equal(row.error_message, null);
    assert.deepEqual(logs.db.prepare('SELECT request_id, valid FROM results').all(), [{request_id: 'r_1', valid: 1}]);
  } finally {
    await app.close();
  }
});

test('provider rate limits and other errors cross the browser client and keep their provider messages in the log', async () => {
  for (const [message, code] of [['HTTP 429: provider requests exceeded; retry shortly', 'RATE_LIMIT'],
    ['HTTP 503: provider unavailable', 'MODEL'], ['fetch failed', 'MODEL']]) {
    const provider = fakeProvider([async () => ({text: '', usage: {}, latencyMs: 1, error: message})]);
    const {app, logs, client} = await start(provider);
    try {
      const reply = await client.call(CALL);
      assert.equal(reply.status, 'error');
      assert.equal(reply.code, code);
      assert.equal(reply.message, message);
      assert.equal(reply.requestId, CALL.requestId);
      assert.equal(provider.sent.length, 1);
      const row = logs.db.prepare('SELECT code,error_message,reply FROM calls').get();
      assert.deepEqual(row, {code, error_message: message, reply: ''});
    } finally {
      await app.close();
      logs.close();
    }
  }
});

test('a rate limit on the repair round is logged against that round', async () => {
  const message = 'HTTP 429: repair was rate limited';
  const provider = fakeProvider(['not json', async () => ({text: '', usage: {}, latencyMs: 1, error: message})]);
  const {app, logs, client} = await start(provider);
  try {
    await client.call(CALL);
    const reply = await client.call({...CALL, repair: {problems: ['the reply must be one JSON object']}});
    assert.equal(reply.code, 'RATE_LIMIT');
    assert.deepEqual(logs.db.prepare('SELECT repair,code,error_message FROM calls ORDER BY repair').all(),
      [{repair: 0, code: null, error_message: null}, {repair: 1, code: 'RATE_LIMIT', error_message: message}]);
  } finally {
    await app.close();
    logs.close();
  }
});

test('existing calls gain error messages without losing history, and the migration can be reopened', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eaf-error-message-'));
  const file = path.join(directory, 'calls.db');
  const old = new Database(file);
  old.exec(`CREATE TABLE calls (
    request_id TEXT NOT NULL, repair INTEGER NOT NULL, session_id TEXT, learner_code TEXT, task_id TEXT, revision INTEGER,
    at TEXT NOT NULL, task TEXT NOT NULL, prompt_version TEXT, model TEXT, settings TEXT, request TEXT, reply TEXT,
    status TEXT NOT NULL, code TEXT, finish_reason TEXT, latency_ms INTEGER, tokens_in INTEGER, tokens_out INTEGER, tokens_reasoning INTEGER,
    cost_usd REAL, cached INTEGER NOT NULL DEFAULT 0);
    INSERT INTO calls (request_id,repair,at,task,status,finish_reason) VALUES ('old',0,'before','COMPREHEND','ok','stop');`);
  old.close();
  let logs: ReturnType<typeof openLogs> | null = null;
  try {
    logs = openLogs(file);
    assert.deepEqual(logs.db.prepare('SELECT request_id,error_message,finish_reason FROM calls').all(),
      [{request_id: 'old', error_message: null, finish_reason: 'stop'}]);
    assert.deepEqual(logs.db.prepare('SELECT fallback FROM calls').all(), [{fallback: 0}]);
    logs.call({call: {...CALL, task: 'COMPREHEND'}, model: 'fake', promptVersion: 'v2', payload: null, replyText: '', at: 'after',
      reply: {requestId: CALL.requestId, status: 'error', code: 'RATE_LIMIT', message: 'HTTP 429: quota exceeded'}});
    logs.close();
    logs = null;
    logs = openLogs(file);
    assert.deepEqual(logs.db.prepare('SELECT request_id,error_message FROM calls ORDER BY rowid').all(),
      [{request_id: 'old', error_message: null}, {request_id: CALL.requestId, error_message: 'HTTP 429: quota exceeded'}]);
  } finally {
    logs?.close();
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('the repair round goes through the same request id; a repair without a first call is refused', async () => {
  const provider = fakeProvider(['not json', JSON.stringify({voiceLine: 'Fine.'})]);
  const {app, client} = await start(provider);
  try {
    await client.call(CALL);
    await client.call({...CALL, repair: {problems: ['the reply must be one JSON object']}});
    assert.deepEqual(provider.sent[1].messages[2], {role: 'assistant', content: 'not json'});
    const lost = await client.call({...CALL, requestId: 'r_9', repair: {problems: ['x']}});
    assert.equal(lost.code, 'INVALID_ENVELOPE');
  } finally {
    await app.close();
  }
});

test('health, and an unknown envelope field refused', async () => {
  const {app, client} = await start(fakeProvider(['{}']));
  try {
    assert.deepEqual((await client.health()).models, {INTENT: 'small'});
    const bad = await client.call({...CALL, prompt: 'You are...'});
    assert.equal(bad.status, 'error');
    assert.equal(bad.code, 'INVALID_ENVELOPE');
    assert.match(bad.message, /call.prompt is not a known field/);
  } finally {
    await app.close();
  }
});

test('only pages on this machine may call it', async () => {
  const {app} = await start(fakeProvider(['{}']));
  try {
    const ask = (origin: string) => app.inject({method: 'OPTIONS', url: '/v1/agent/call',
      headers: {origin, 'access-control-request-method': 'POST'}});
    assert.equal((await ask('http://localhost:8766')).headers['access-control-allow-origin'], 'http://localhost:8766');
    assert.equal((await ask('https://example.com')).headers['access-control-allow-origin'], undefined);
  } finally {
    await app.close();
  }
});

test('a browser that gives up stops the model call', async () => {
  let seen: AbortSignal | undefined;
  const provider = fakeProvider([(signal) => new Promise<ModelReply>((resolve) => {
    seen = signal;
    signal?.addEventListener('abort', () => resolve({text: '', usage: {}, latencyMs: 1, error: 'aborted'}));
  })]);
  const {app, client} = await start(provider);
  try {
    const controller = new AbortController();
    const pending = client.call(CALL, {signal: controller.signal});
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    assert.equal((await pending).code, 'ABORTED');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(seen?.aborted, true);
  } finally {
    await app.close();
  }
});

test('the browser client says when the server is down', async () => {
  const client = createAgentServerClient({url: 'http://127.0.0.1:9', session: {id: 's_1'}});
  const warn = console.warn;
  console.warn = () => {};
  try {
    const reply = await client.call(CALL);
    assert.equal(reply.code, 'MODEL');
    assert.match(reply.message, /can't be reached/);
    assert.equal(await client.health(), null);
  } finally {
    console.warn = warn;
  }
});
