// HTTP routes: model calls, results, events and health. Only the app's own pages on this machine may call them.

import Fastify from 'fastify';
import cors from '@fastify/cors';
import type {AgentCore} from './core.js';
import type {EventIntake} from './events.js';

/** Pages served from this machine (the test app runs on its own port). */
export const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export interface Health {
  version: string;
  models: Record<string, string>;
  promptVersions: Record<string, string>;
  keySet: boolean;
  nameFinder?: string;
}

export async function buildApp({core, events = null, health, origins = LOCAL_ORIGIN, logger = false}:
    {core: AgentCore; events?: EventIntake | null; health: () => Health; origins?: RegExp; logger?: boolean}) {
  const app = Fastify({logger, bodyLimit: 1024 * 1024});
  await app.register(cors, {origin: (origin, done) => done(null, !origin || origins.test(origin)), methods: ['GET', 'POST']});
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

  app.get('/v1/health', async () => health());
  return app;
}
