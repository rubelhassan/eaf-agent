// The app's events: a batch per request, checked, text masked, stored once per event id. No HTTP here.

import {DEFAULT_ASSISTANT_NAME, assistantNameProblem} from './envelope.js';
import type {Guard} from './guard/index.js';
import type {EventRow} from './store/logs.js';

const MAX_EVENTS = 200;
const KIND = /^[a-z]+(?:\.[a-z]+)+$/;
const RESERVED = ['id', 'seq', 'time', 'kind', 'taskId', 'revision'];
// Free text in an event: the learner's words, what the assistant said, steps in words.
const TEXT_FIELDS = ['text', 'words', 'before', 'after'];

export interface EventStore {
  touchSession(session: {id: string; learnerCode?: string | null; client?: unknown}, at: string): void;
  addEvents(sessionId: string, events: EventRow[]): void;
}

type Batch = {session: {id: string; learnerCode?: string | null; assistantName?: string | null; client?: unknown};
  events: Array<Record<string, unknown>>};

/** @returns what is wrong with a batch; empty when it can be stored */
export function batchProblems(body: unknown): string[] {
  const b = body as Batch;
  if (!b || typeof b !== 'object') return ['the batch must be an object'];
  const problems: string[] = [];
  if (typeof b.session?.id !== 'string' || !b.session.id) problems.push('session.id must be text');
  if (b.session?.learnerCode != null && typeof b.session.learnerCode !== 'string') problems.push('session.learnerCode must be text or null');
  const name = assistantNameProblem('session', b.session?.assistantName);
  if (name) problems.push(name);
  if (!Array.isArray(b.events)) return [...problems, 'events must be a list'];
  if (b.events.length > MAX_EVENTS) problems.push(`at most ${MAX_EVENTS} events per batch`);
  b.events.forEach((e, i) => {
    if (!e || typeof e !== 'object') return problems.push(`events[${i}] must be an object`);
    if (typeof e.id !== 'string' || !e.id || e.id.length > 120) problems.push(`events[${i}].id must be text`);
    if (!Number.isInteger(e.seq)) problems.push(`events[${i}].seq must be a whole number`);
    if (typeof e.time !== 'string' || Number.isNaN(Date.parse(e.time))) problems.push(`events[${i}].time must be a time`);
    if (typeof e.kind !== 'string' || !KIND.test(e.kind)) problems.push(`events[${i}].kind must look like task.done`);
    if (e.taskId != null && typeof e.taskId !== 'string') problems.push(`events[${i}].taskId must be text or null`);
    if (e.revision != null && !Number.isInteger(e.revision)) problems.push(`events[${i}].revision must be a whole number or null`);
  });
  return problems;
}

/** Masks free-text fields at any depth, except the assistant's name; ids and labels stay. */
async function maskData(value: unknown, guard: Guard | null, keep: string, key = ''): Promise<unknown> {
  if (!guard) return value;
  if (typeof value === 'string') return TEXT_FIELDS.includes(key) ? guard.maskText(value, keep) : value;
  if (Array.isArray(value)) return Promise.all(value.map((v) => maskData(v, guard, keep, key)));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await maskData(v, guard, keep, k);
    return out;
  }
  return value;
}

export function createEventIntake({store, guard = null, now = () => Date.now()}:
  {store: EventStore; guard?: Guard | null; now?: () => number}) {
  return {
    /** @returns the ids now stored (including ones stored before), so the browser drops them */
    async take(body: unknown): Promise<{ok: true; stored: string[]} | {ok: false; problems: string[]}> {
      const problems = batchProblems(body);
      if (problems.length) return {ok: false, problems};
      const {session, events} = body as Batch;
      const keep = session.assistantName || DEFAULT_ASSISTANT_NAME;
      const rows: EventRow[] = [];
      for (const e of events) {
        const data = Object.fromEntries(Object.entries(e).filter(([k]) => !RESERVED.includes(k)));
        rows.push({id: e.id as string, seq: e.seq as number, time: e.time as string, kind: e.kind as string,
          taskId: (e.taskId as string) ?? null, revision: (e.revision as number) ?? null,
          data: await maskData(data, guard, keep) as Record<string, unknown>});
      }
      store.touchSession(session, new Date(now()).toISOString());
      store.addEvents(session.id, rows);
      return {ok: true, stored: rows.map((r) => r.id)};
    },
  };
}

export type EventIntake = ReturnType<typeof createEventIntake>;
