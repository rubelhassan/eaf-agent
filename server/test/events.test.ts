// Events: the route (JSON and a page's last beacon), stored once per id, text masked, sessions, and the report.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../src/app.js';
import {createAgentCore} from '../src/core.js';
import {createEventIntake} from '../src/events.js';
import {createGuard} from '../src/guard/index.js';
import {createRouting} from '../src/models/router.js';
import {openLogs} from '../src/store/logs.js';
import {relianceSignals} from '../src/store/report.js';
import {createRequire} from 'node:module';

const {createAgentServerClient} = createRequire(import.meta.url)('../../src/agent/model/server_client.js');

const at = (n: number) => new Date(Date.UTC(2026, 9, 29, 10, 0, n)).toISOString();
const event = (seq: number, kind: string, data: Record<string, unknown> = {}) =>
  ({taskId: null, revision: 1, ...data, id: `e_s1_${seq}`, seq, time: at(seq), kind});

async function start() {
  const logs = openLogs(':memory:');
  const routing = createRouting({tasks: {'*': {model: 'm'}}, providers: {}}, {openrouter: {complete: async () => ({text: '{}', usage: {}, latencyMs: 1})}});
  const app = await buildApp({core: createAgentCore({routing, log: logs}), events: createEventIntake({store: logs, guard: createGuard({ner: null})}),
    health: () => ({version: 't', models: {}, promptVersions: {}, keySet: true})});
  return {app, logs};
}

test('a batch is stored once per event id, with free text masked and ids and labels as they were', async () => {
  const {app, logs} = await start();
  const batch = {session: {id: 's1', learnerCode: null, client: {output: {aiVoice: 'kristin'}}}, events: [
    event(1, 'message.submitted', {input: 'voice', text: 'my name is ava, email ava@example.com'}),
    event(2, 'proposal.offered', {taskId: 't1', proposalId: 'p1', proposalKind: 'plan', words: ['add a print block saying "call 940-555-0142"']}),
  ]};
  const first = await app.inject({method: 'POST', url: '/v1/agent/events', payload: batch});
  assert.deepEqual(first.json(), {stored: ['e_s1_1', 'e_s1_2']});
  // A retry of the same events stores nothing new.
  await app.inject({method: 'POST', url: '/v1/agent/events', payload: batch});
  const rows = logs.db.prepare('SELECT event_id, session_id, seq, kind, task_id, data FROM events ORDER BY seq').all() as Array<Record<string, any>>;
  assert.equal(rows.length, 2);
  assert.deepEqual(JSON.parse(rows[0].data), {input: 'voice', text: 'my name is NAME_1, email EMAIL_1'});
  assert.deepEqual(JSON.parse(rows[1].data), {proposalId: 'p1', proposalKind: 'plan', words: ['add a print block saying "call PHONE_1"']});
  assert.equal(rows[1].task_id, 't1');
  const session = logs.db.prepare('SELECT * FROM sessions').get() as Record<string, any>;
  assert.equal(session.session_id, 's1');
  assert.deepEqual(JSON.parse(session.client), {output: {aiVoice: 'kristin'}});
  await app.close();
});

test('a closing page\'s beacon (text/plain) is taken; a bad batch is refused with the reasons', async () => {
  const {app, logs} = await start();
  const beacon = await app.inject({method: 'POST', url: '/v1/agent/events', headers: {'content-type': 'text/plain'},
    payload: JSON.stringify({session: {id: 's2'}, events: [event(1, 'session.ended')]})});
  assert.equal(beacon.statusCode, 200);
  const bad = await app.inject({method: 'POST', url: '/v1/agent/events', payload: {session: {id: 's2'}, events: [{id: 'x', seq: 'one', kind: 'Bad'}]}});
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /events\[0\]\.seq must be a whole number; events\[0\]\.time must be a time; events\[0\]\.kind must look like task\.done/);
  assert.equal((logs.db.prepare('SELECT count(*) AS n FROM events').get() as {n: number}).n, 1);
  await app.close();
});

test('the browser client sends a batch; a refused batch is dropped, a server error is retried', async () => {
  const {app, logs} = await start();
  const url = await app.listen({host: '127.0.0.1', port: 0});
  const client = createAgentServerClient({url, session: {id: 's3'}});
  await client.events({session: {id: 's3'}, events: [event(1, 'ai.said', {text: 'Done.', replyKind: 'outcome'})]});
  assert.equal((logs.db.prepare("SELECT count(*) AS n FROM events WHERE session_id = 's3'").get() as {n: number}).n, 1);
  const warn = console.warn;
  console.warn = () => {};
  await client.events({session: {id: 's3'}, events: [{id: 'x'}]});
  console.warn = warn;
  await app.close();
  await assert.rejects(createAgentServerClient({url: 'http://127.0.0.1:9', session: {id: 's3'}}).events({session: {id: 's3'}, events: []}));
});

test('the report: tasks by action, steps against own edits, hints per question', () => {
  const logs = openLogs(':memory:');
  logs.touchSession({id: 's1', learnerCode: 'P07'}, at(0));
  logs.addEvents('s1', [
    {...event(1, 'message.submitted', {text: 'fix it'}), data: {text: 'fix it'}},
    {...event(2, 'task.stage', {}), taskId: 't1', data: {action: 'DEBUG', stage: 'action'}},
    {...event(3, 'proposal.offered', {}), taskId: 't1', data: {proposalKind: 'fix', steps: 1}},
    {...event(4, 'step.applied', {}), taskId: 't1', data: {count: 1}},
    {...event(5, 'task.done', {}), taskId: 't1', data: {action: 'DEBUG'}},
    {...event(6, 'step.undone', {}), taskId: 't1', data: {count: 1}},
    {...event(7, 'hint.opened', {}), data: {questionId: 'q1'}},
    {...event(8, 'hint.shown', {}), data: {questionId: 'q1', level: 'written 1', ai: false}},
    {...event(9, 'hint.shown', {}), data: {questionId: 'q1', level: 'concept', ai: true}},
    {...event(10, 'activity.summary', {}), data: {edits: 2, runs: 1}},
    {...event(11, 'activity.summary', {}), data: {edits: 4, runs: 3}},
  ].map(({id, seq, time, kind, taskId, revision, data}) => ({id, seq, time, kind, taskId: taskId as string | null, revision, data})));
  const [s] = relianceSignals(logs.db);
  assert.equal(s.who, 'P07');
  assert.deepEqual(s.tasks, {DEBUG: {done: 1, failed: 0, cancelled: 0, revised: 0}});
  assert.deepEqual(s.proposals, {offered: 1, fixes: 1, plans: 0, stepsApplied: 1, stepsUndone: 1, withdrawn: 0});
  assert.deepEqual(s.ownWork, {edits: 4, runs: 3});
  assert.equal(s.agentStepsPerOwnEdit, 0.25);
  assert.deepEqual(s.hints, [{questionId: 'q1', opened: 1, shown: 2, highestLevel: 'concept'}]);
});
