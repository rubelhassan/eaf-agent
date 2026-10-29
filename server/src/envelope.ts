// The call envelope from the browser: known fields only, with their types. Anything else is refused.

export const TASKS = ['INTENT', 'COMPREHEND', 'COMPREHEND_PROPOSAL', 'DEBUG', 'EDIT_GUIDE', 'SEARCH', 'HINT'] as const;
export type Task = (typeof TASKS)[number];

export interface AgentCall {
  requestId: string;
  session?: {id: string; learnerCode?: string | null};
  taskId?: string | null;
  revision?: number | null;
  task: Task;
  learnerText: string;
  input: Record<string, unknown>;
  policy?: {activity?: string; wholePlan?: boolean} | null;
  repair?: {problems: string[]} | null;
}

type Kind = 'string' | 'number' | 'boolean' | 'object' | 'strings';
type Field = {kind: Kind; optional?: boolean; nullable?: boolean};

const req = (kind: Kind): Field => ({kind});
const opt = (kind: Kind): Field => ({kind, optional: true, nullable: true});

const ENVELOPE: Record<string, Field> = {
  requestId: req('string'),
  session: opt('object'),
  taskId: opt('string'),
  revision: opt('number'),
  task: req('string'),
  learnerText: req('string'),
  input: req('object'),
  policy: opt('object'),
  repair: opt('object'),
};

const SESSION: Record<string, Field> = {id: req('string'), learnerCode: opt('string')};
const POLICY: Record<string, Field> = {activity: opt('string'), wholePlan: opt('boolean')};
const REPAIR: Record<string, Field> = {problems: req('strings')};

// The input parts each task sends (the harness modules build them).
const INPUTS: Record<Task, Record<string, Field>> = {
  INTENT: {atCursor: req('string'), program: req('string'), taskContext: opt('string'), answers: opt('strings')},
  COMPREHEND: {scope: req('string'), wordLimit: req('number'), program: req('string')},
  COMPREHEND_PROPOSAL: {wordLimit: req('number'), taskContext: req('string'), program: req('string')},
  DEBUG: {program: req('string'), taskContext: opt('string')},
  EDIT_GUIDE: {program: req('string'), taskContext: opt('string')},
  SEARCH: {program: req('string')},
  HINT: {
    level: req('string'), levelRule: req('string'), learnerLevel: req('string'), question: req('string'),
    instruction: req('string'), needs: req('string'), intended: req('strings'), earlierHints: req('strings'),
    teacherNote: opt('string'), program: req('string'),
  },
};

function kindOf(value: unknown): Kind | 'array' | 'null' | 'other' {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.every((v) => typeof v === 'string') ? 'strings' : 'array';
  const t = typeof value;
  return t === 'string' || t === 'number' || t === 'boolean' || t === 'object' ? t : 'other';
}

function fieldProblems(where: string, value: unknown, fields: Record<string, Field>): string[] {
  if (kindOf(value) !== 'object') return [`${where} must be an object`];
  const object = value as Record<string, unknown>;
  const problems = Object.keys(object).filter((k) => !(k in fields)).map((k) => `${where}.${k} is not a known field`);
  for (const [name, field] of Object.entries(fields)) {
    const v = object[name];
    if (v === undefined) {
      if (!field.optional) problems.push(`${where}.${name} is missing`);
    } else if (v === null) {
      if (!field.nullable) problems.push(`${where}.${name} must not be null`);
    } else if (kindOf(v) !== field.kind) {
      problems.push(`${where}.${name} must be ${field.kind === 'strings' ? 'a list of text' : field.kind}`);
    }
  }
  return problems;
}

/** What is wrong with a call envelope; empty when it can go to a model. */
export function envelopeProblems(body: unknown): string[] {
  const problems = fieldProblems('call', body, ENVELOPE);
  if (problems.length) return problems;
  const call = body as AgentCall;
  if (!(TASKS as readonly string[]).includes(call.task)) return [`call.task must be one of ${TASKS.join(', ')}`];
  if (call.session) problems.push(...fieldProblems('call.session', call.session, SESSION));
  if (call.policy) problems.push(...fieldProblems('call.policy', call.policy, POLICY));
  if (call.repair) problems.push(...fieldProblems('call.repair', call.repair, REPAIR));
  problems.push(...fieldProblems('call.input', call.input, INPUTS[call.task]));
  return problems;
}
