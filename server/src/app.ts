// HTTP routes: model calls, results, events, saved work and tasks, and health. App pages must be local.

import Fastify from 'fastify';
import cors from '@fastify/cors';
import type {AgentCore} from './core.js';
import type {EventIntake} from './events.js';
import {registerVoice, type VoiceRecord} from './voice/socket.js';
import type {VoiceEngine, VoiceHealth} from './voice/protocol.js';
import type {FindEntities} from './guard/ner.js';
import type {WorkSave, WorkStore, TaskSave, TaskStore} from './store/logs.js';

const PROGRAM_BYTES = 1024 * 1024;
const SUMMARY_BYTES = 512 * 1024;
const WORK_BODY_BYTES = 10 * 1024 * 1024;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 &&
  value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const hasOnlyKeys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
const isCount = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const isCountMap = (value: unknown) => isRecord(value) && Object.values(value).every(isCount);
const validTaskId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);

function validTask(body: unknown): body is TaskSave {
  return isRecord(body) && hasOnlyKeys(body, ['taskId', 'title', 'savedAt', 'taskXml']) && validTaskId(body.taskId) &&
    isText(body.title, 200) && isText(body.savedAt, 40) && Number.isFinite(Date.parse(body.savedAt)) &&
    new Date(body.savedAt).toISOString() === body.savedAt && typeof body.taskXml === 'string' &&
    Buffer.byteLength(body.taskXml) <= PROGRAM_BYTES && /^<xml(?:\s|\/?>)/.test(body.taskXml);
}

function validWork(body: unknown): body is WorkSave {
  if (!isRecord(body) || !hasOnlyKeys(body, ['session', 'task', 'savedAt', 'programXml', 'summary'])) return false;
  if (!isRecord(body.session) || !hasOnlyKeys(body.session, ['id', 'learnerCode']) || !isText(body.session.id, 200) ||
      !(body.session.learnerCode == null || isText(body.session.learnerCode, 100))) return false;
  if (!isText(body.task, 512) || !isText(body.savedAt, 40) || !Number.isFinite(Date.parse(body.savedAt))) return false;
  if (typeof body.programXml !== 'string' || !body.programXml.length || Buffer.byteLength(body.programXml) > PROGRAM_BYTES) return false;
  const summary = body.summary;
  if (!isRecord(summary) || !hasOnlyKeys(summary, ['blocks', 'deleted', 'session', 'counts', 'questions']) ||
      Buffer.byteLength(JSON.stringify(summary)) > SUMMARY_BYTES || !Array.isArray(summary.blocks) ||
      !Array.isArray(summary.deleted) || !isRecord(summary.session) || !isRecord(summary.counts)) return false;
  if (summary.questions !== undefined && (!Array.isArray(summary.questions) || summary.questions.length > 50 ||
      !summary.questions.every(validSubmissionQuestion))) return false;
  const counts = summary.counts;
  const blocks = counts.blocks;
  if (!isRecord(blocks) || !['created', 'assisted', 'learner'].every((kind) => isCount(blocks[kind]))) return false;
  if (!['learnerChangedAiBlocks', 'learnerDeleted'].every((key) => isCount(counts[key])) ||
      !isCountMap(counts.learnerActionsOnAiBlocks) || !isRecord(counts.aiActions) || !Object.values(counts.aiActions).every(isCountMap)) return false;
  const deleted = counts.deleted;
  if (!isRecord(deleted) || !['created', 'assisted', 'learner'].every((kind) => isCountMap(deleted[kind]))) return false;
  return summary.blocks.every((block) => isRecord(block) && isText(block.id, 200) && isText(block.type, 200) &&
    ['created', 'assisted', 'learner'].includes(block.kind as string) && (block.added === undefined || typeof block.added === 'boolean') &&
    Array.isArray(block.history) && block.history.length <= 20) &&
    summary.deleted.every((entry) => isRecord(entry) && isText(entry.blockType, 200) &&
      ['created', 'assisted', 'learner'].includes(entry.priorKind as string) && entry.by === 'ai' && entry.action === 'delete' &&
      ['edit', 'debug'].includes(entry.type as string) && isText(entry.task, 200) && isText(entry.at, 40) && Number.isFinite(Date.parse(entry.at)));
}

function validSubmissionQuestion(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ['number', 'solved', 'writtenHints', 'aiHints']) &&
    isCount(value.number) && (value.number as number) >= 1 && (value.number as number) <= 50 &&
    (value.solved === null || typeof value.solved === 'boolean') && isCount(value.writtenHints) && isRecord(value.aiHints) &&
    hasOnlyKeys(value.aiHints, ['count', 'levels']) && isCount(value.aiHints.count) &&
    Array.isArray(value.aiHints.levels) && value.aiHints.levels.length <= 5 &&
    value.aiHints.levels.every(level => ['nudge', 'point', 'kind'].includes(level));
}

/** Pages served from this machine (the test app runs on its own port). */
export const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export interface Health {
  version: string;
  models: Record<string, string>;
  promptVersions: Record<string, string>;
  keySet: boolean;
  nameFinder?: string;
  voice?: VoiceHealth;
}

export async function buildApp({core, events = null, health, origins = LOCAL_ORIGIN, logger = false, voice, work, tasks}:
    {core: AgentCore; events?: EventIntake | null; health: () => Health; origins?: RegExp; logger?: boolean;
      work?: WorkStore; tasks?: TaskStore;
      voice?: {engine: VoiceEngine; utteranceMaxMs: number; logTranscripts: boolean; ner?: FindEntities | null;
        log?: (record: VoiceRecord) => void; now?: () => number; helloMs?: number; idleMs?: number}}) {
  const app = Fastify({logger, bodyLimit: 1024 * 1024});
  await app.register(cors, {origin: (origin, done) => done(null, !origin || origins.test(origin)), methods: ['GET', 'POST', 'DELETE']});
  if (voice) await registerVoice(app, {...voice, origins});
  // A page closing sends its last events with sendBeacon, as text/plain (no preflight); the body is still JSON.
  app.removeContentTypeParser('text/plain');
  app.addContentTypeParser('text/plain', {parseAs: 'string'}, (request, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      done(Object.assign(new Error('the body must be JSON'), {statusCode: 400}), undefined);
    }
  });

  app.post('/v1/agent/call', async (request, reply) => {
    // A browser that gives up (abort, page closed) stops the model call too.
    const controller = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    return core.call(request.body, {signal: controller.signal});
  });

  app.post('/v1/agent/result', async (request, reply) => {
    const body = request.body as {requestId?: unknown; valid?: unknown; problems?: unknown};
    if (typeof body?.requestId !== 'string' || typeof body.valid !== 'boolean') {
      return reply.code(400).send({error: 'requestId (text) and valid (true or false) are needed'});
    }
    const problems = Array.isArray(body.problems) ? body.problems.filter((p): p is string => typeof p === 'string') : [];
    core.result({requestId: body.requestId, valid: body.valid, problems});
    return {ok: true};
  });

  if (events) {
    app.post('/v1/agent/events', async (request, reply) => {
      const result = await events.take(request.body);
      if (!result.ok) return reply.code(400).send({error: result.problems.join('; ')});
      return {stored: result.stored};
    });
  }

  if (work) {
    app.get<{Querystring: {task?: string}}>('/v1/work', async (request, reply) => {
      if (request.headers.origin && !origins.test(request.headers.origin)) return reply.code(403).send({error: 'local origins only'});
      if (!validTaskId(request.query.task)) return reply.code(400).send({error: 'invalid task id'});
      return work.listWork(request.query.task);
    });
    app.get<{Params: {code: string}; Querystring: {task?: string}}>('/v1/work/:code', async (request, reply) => {
      if (request.headers.origin && !origins.test(request.headers.origin)) return reply.code(403).send({error: 'local origins only'});
      if (!validTaskId(request.query.task) || !/^[A-Za-z0-9_-]{4}$/.test(request.params.code)) {
        return reply.code(400).send({error: 'invalid task or submission id'});
      }
      const saved = work.getWork(request.query.task, request.params.code);
      return saved || reply.code(404).send({error: 'submission not found'});
    });
    app.post('/v1/work', {bodyLimit: WORK_BODY_BYTES}, async (request, reply) => {
      const origin = request.headers.origin;
      if (origin && !origins.test(origin)) return reply.code(403).send({error: 'local origins only'});
      if (!validWork(request.body)) return reply.code(400).send({error: 'invalid saved work or size limit exceeded'});
      return work.saveWork(request.body);
    });
  }

  if (tasks) {
    app.delete<{Params: {taskId: string}}>('/v1/tasks/:taskId', async (request, reply) => {
      const origin = request.headers.origin;
      if (origin && !origins.test(origin)) return reply.code(403).send({error: 'local origins only'});
      if (!validTaskId(request.params.taskId)) return reply.code(400).send({error: 'invalid task id'});
      return {removed: tasks.removeTask(request.params.taskId)};
    });
    app.post('/v1/tasks', {bodyLimit: WORK_BODY_BYTES}, async (request, reply) => {
      const origin = request.headers.origin;
      if (origin && !origins.test(origin)) return reply.code(403).send({error: 'local origins only'});
      if (!validTask(request.body)) return reply.code(400).send({error: 'invalid task or size limit exceeded'});
      return {versionId: tasks.saveTask(request.body)};
    });
    app.get<{Params: {taskId: string}}>('/v1/tasks/:taskId/latest', async (request, reply) => {
      const origin = request.headers.origin;
      if (origin && !origins.test(origin)) return reply.code(403).send({error: 'local origins only'});
      if (!validTaskId(request.params.taskId)) return reply.code(400).send({error: 'invalid task id'});
      const task = tasks.latestTask(request.params.taskId);
      return task || reply.code(404).send({error: 'task not found'});
    });
  }

  app.get('/v1/health', async () => ({...health(), ...(voice ? {voice: voice.engine.status()} : {})}));
  return app;
}
