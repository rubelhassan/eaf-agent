// HTTP routes: model calls, results, events and health. Only the app's own pages on this machine may call them.

import Fastify from 'fastify';
import cors from '@fastify/cors';
import type {AgentCore} from './core.js';
import type {EventIntake} from './events.js';
import {registerVoice, type VoiceRecord} from './voice/socket.js';
import type {VoiceEngine, VoiceHealth} from './voice/protocol.js';
import type {FindEntities} from './guard/ner.js';
import type {WorkSave, WorkStore} from './store/logs.js';

const PROGRAM_BYTES = 1024 * 1024;
const SUMMARY_BYTES = 512 * 1024;
const WORK_BODY_BYTES = 10 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));

function validWork(body: unknown): body is WorkSave {
  if (!object(body) || !keys(body, ['session', 'task', 'savedAt', 'programXml', 'summary'])) return false;
  if (!object(body.session) || !keys(body.session, ['id', 'learnerCode']) || !text(body.session.id, 200) ||
      !(body.session.learnerCode == null || text(body.session.learnerCode, 100))) return false;
  if (!text(body.task, 512) || !text(body.savedAt, 40) || !Number.isFinite(Date.parse(body.savedAt))) return false;
  if (typeof body.programXml !== 'string' || !body.programXml.length || Buffer.byteLength(body.programXml) > PROGRAM_BYTES) return false;
  const summary = body.summary;
  if (!object(summary) || Buffer.byteLength(JSON.stringify(summary)) > SUMMARY_BYTES ||
      !Array.isArray(summary.blocks) || !Array.isArray(summary.deleted) || !object(summary.session) || !object(summary.counts)) return false;
  const counts = summary.counts;
  const blocks = counts.blocks;
  if (!object(blocks) || !['created', 'assisted', 'learner'].every((kind) => Number.isSafeInteger(blocks[kind]) &&
      (blocks[kind] as number) >= 0)) return false;
  return ['learnerChangedAiBlocks', 'learnerDeleted'].every((key) => Number.isSafeInteger(counts[key]) && (counts[key] as number) >= 0) &&
    object(counts.aiActions) && object(counts.deleted);
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

export async function buildApp({core, events = null, health, origins = LOCAL_ORIGIN, logger = false, voice, work}:
    {core: AgentCore; events?: EventIntake | null; health: () => Health; origins?: RegExp; logger?: boolean;
      work?: WorkStore;
      voice?: {engine: VoiceEngine; utteranceMaxMs: number; logTranscripts: boolean; ner?: FindEntities | null;
        log?: (record: VoiceRecord) => void; now?: () => number; helloMs?: number; idleMs?: number}}) {
  const app = Fastify({logger, bodyLimit: 1024 * 1024});
  await app.register(cors, {origin: (origin, done) => done(null, !origin || origins.test(origin)), methods: ['GET', 'POST']});
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

  if (work) app.post('/v1/work', {bodyLimit: WORK_BODY_BYTES}, async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && !origins.test(origin)) return reply.code(403).send({error: 'local origins only'});
    if (!validWork(request.body)) return reply.code(400).send({error: 'invalid saved work or size limit exceeded'});
    return {workId: work.saveWork(request.body)};
  });

  app.get('/v1/health', async () => ({...health(), ...(voice ? {voice: voice.engine.status()} : {})}));
  return app;
}
