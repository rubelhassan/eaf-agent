// Logs in SQLite: sessions, every model call (masked), the browser's verdict on each reply, and the app's events (text
// masked). Kept on this machine until wiped.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type {CallLog} from '../core.js';

export interface EventRow {
  id: string;
  seq: number;
  time: string;
  kind: string;
  taskId: string | null;
  revision: number | null;
  data: Record<string, unknown>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
  request_id TEXT NOT NULL, repair INTEGER NOT NULL, session_id TEXT, learner_code TEXT, task_id TEXT, revision INTEGER,
  at TEXT NOT NULL, task TEXT NOT NULL, prompt_version TEXT, model TEXT, settings TEXT, request TEXT, reply TEXT,
  status TEXT NOT NULL, code TEXT, latency_ms INTEGER, tokens_in INTEGER, tokens_out INTEGER, tokens_reasoning INTEGER,
  cost_usd REAL, cached INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS calls_request ON calls (request_id);
CREATE TABLE IF NOT EXISTS results (request_id TEXT NOT NULL, at TEXT NOT NULL, valid INTEGER NOT NULL, problems TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY, learner_code TEXT, started TEXT NOT NULL, last_seen TEXT NOT NULL, client TEXT
);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, time TEXT NOT NULL, kind TEXT NOT NULL,
  task_id TEXT, revision INTEGER, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session ON events (session_id, seq);
`;

export const TABLES = ['sessions', 'calls', 'results', 'events'] as const;

/** @param file  a path, or ':memory:' for tests */
export function openLogs(file: string): CallLog & {
  db: Database.Database;
  /** A session seen now; the learner code and client details are kept when given. */
  touchSession(session: {id: string; learnerCode?: string | null; client?: unknown}, at: string): void;
  /** Stores events once each (a repeated id is ignored). */
  addEvents(sessionId: string, events: EventRow[]): void;
  close(): void;
} {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), {recursive: true});
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  const addCall = db.prepare(`INSERT INTO calls (request_id, repair, session_id, learner_code, task_id, revision, at, task,
    prompt_version, model, settings, request, reply, status, code, latency_ms, tokens_in, tokens_out, tokens_reasoning, cost_usd, cached)
    VALUES (@requestId, @repair, @sessionId, @learnerCode, @taskId, @revision, @at, @task, @promptVersion, @model, @settings,
    @request, @reply, @status, @code, @latencyMs, @tokensIn, @tokensOut, @tokensReasoning, @costUsd, @cached)`);
  const addResult = db.prepare('INSERT INTO results (request_id, at, valid, problems) VALUES (?, ?, ?, ?)');
  const touch = db.prepare(`INSERT INTO sessions (session_id, learner_code, started, last_seen, client) VALUES (@id, @code, @at, @at, @client)
    ON CONFLICT (session_id) DO UPDATE SET last_seen = @at, learner_code = coalesce(@code, learner_code),
    client = coalesce(@client, client)`);
  const addEvent = db.prepare(`INSERT OR IGNORE INTO events (event_id, session_id, seq, time, kind, task_id, revision, data)
    VALUES (@id, @sessionId, @seq, @time, @kind, @taskId, @revision, @data)`);
  const touchSession = (session: {id: string; learnerCode?: string | null; client?: unknown}, at: string) =>
    touch.run({id: session.id, code: session.learnerCode ?? null, at, client: session.client ? JSON.stringify(session.client) : null});

  return {
    db,
    call({call, model, promptVersion, payload, reply, replyText, at}) {
      if (call.session?.id) touchSession(call.session, at);
      const meta = (reply.meta || {}) as Record<string, any>;
      const {messages, model: _, ...settings} = payload || {};
      addCall.run({
        requestId: call.requestId, repair: call.repair ? 1 : 0, sessionId: call.session?.id ?? null,
        learnerCode: call.session?.learnerCode ?? null, taskId: call.taskId ?? null, revision: call.revision ?? null, at,
        task: call.task, promptVersion, model, settings: JSON.stringify(settings), request: JSON.stringify(messages ?? null),
        reply: replyText, status: reply.status, code: reply.status === 'error' ? reply.code : null,
        latencyMs: meta.latencyMs ?? null, tokensIn: meta.tokens?.input ?? null, tokensOut: meta.tokens?.output ?? null,
        tokensReasoning: meta.tokens?.reasoning ?? null, costUsd: typeof meta.costUsd === 'number' ? meta.costUsd : null,
        cached: meta.cached ? 1 : 0,
      });
    },
    result({requestId, valid, problems, at}) {
      addResult.run(requestId, at, valid ? 1 : 0, JSON.stringify(problems));
    },
    touchSession,
    addEvents: db.transaction((sessionId: string, events: EventRow[]) => {
      for (const e of events) addEvent.run({...e, sessionId, data: JSON.stringify(e.data)});
    }),
    close: () => db.close(),
  };
}
