// Personal information is replaced by typed ids (NAME_1, PHONE_1...) before a request leaves this machine, and put
// back in the reply. The learner's words get every finder; program text only emails, phones and addresses, since
// names in a program are its content. The map lives only for a request and its repair round.

import type {AgentCall} from '../envelope.js';
import type {FindEntities} from './ner.js';

export const MASK_TYPES = ['NAME', 'SCHOOL', 'AGE', 'LOCATION', 'EMAIL', 'PHONE', 'ADDRESS', 'HANDLE'] as const;
export type MaskType = (typeof MASK_TYPES)[number];

export interface MaskMap {
  /** lower-case value -> id */
  ids: Map<string, string>;
  /** id -> value */
  values: Map<string, string>;
}

interface Span {
  start: number;
  end: number;
  type: MaskType;
}

export const newMaskMap = (): MaskMap => ({ids: new Map(), values: new Map()});

const PATTERNS: Array<[MaskType, RegExp]> = [
  ['EMAIL', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g],
  ['HANDLE', /(?<![\w.@])@[a-z0-9_.]{2,30}\b/gi],
  ['PHONE', /(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g],
  ['ADDRESS', /\b\d{1,6}\s+(?:[a-z]+\s+){1,3}(?:street|st|avenue|ave|road|rd|drive|dr|lane|court|boulevard|blvd|circle|terrace|parkway)\b/gi],
];
const PROGRAM_TYPES: MaskType[] = ['EMAIL', 'PHONE', 'ADDRESS'];

// Words that end a name or place said after a cue ("my name is ava and ...").
const STOP = new Set(['and', 'but', 'so', 'or', 'i', 'im', "i'm", 'my', 'the', 'a', 'an', 'is', 'am', 'are', 'can', 'could', 'please',
  'help', 'what', 'why', 'how', 'with', 'to', 'in', 'at', 'on', 'from', 'for', 'of', 'not', 'very', 'really', 'too', 'also', 'then',
  'now', 'this', 'that', 'it', 'you', 'your', 'me', 'we', 'our', 'they', 'he', 'she', 'years', 'year', 'old', 'when', 'if',
  'after', 'before', 'later', 'back', 'again', 'maybe', 'just', 'about', 'there', 'here']);
const NUMBER_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen';
const SCHOOL_WORD = /\b(?:elementary|middle|high|primary|intermediate|junior|school|academy)\b/i;

/** Up to `max` words after a cue, stopping at a stop word or punctuation. */
function wordsAfter(text: string, from: number, max: number): [number, number] | null {
  const re = /[a-z][\w'-]*/giy;
  let start = -1;
  let end = -1;
  let pos = from;
  for (let n = 0; n < max; n++) {
    const gap = /^[ \t]+/.exec(text.slice(pos));
    if (n && !gap) break;
    re.lastIndex = pos + (gap ? gap[0].length : 0);
    const m = re.exec(text);
    if (!m || STOP.has(m[0].toLowerCase())) break;
    if (start < 0) start = m.index;
    end = m.index + m[0].length;
    pos = end;
  }
  return start < 0 ? null : [start, end];
}

const CUES: Array<[MaskType, RegExp, number]> = [
  ['NAME', /\b(?:my name is|my name['’]s|i am called|i['’]m called|call me|my nickname is)\s+/gi, 2],
  ['NAME', /\bmy (?:mom|mum|mother|dad|father|brother|sister|friend|best friend|teacher|grandma|grandpa|cousin)(?:['’]s name is| is called| named| is named)\s+/gi, 2],
  ['LOCATION', /\b(?:i live in|i live on|we live in|i['’]m from|i am from|im from|my town is|my city is)\s+/gi, 3],
];

function cueSpans(text: string): Span[] {
  const found: Span[] = [];
  for (const [type, re, max] of CUES) {
    for (const m of text.matchAll(re)) {
      const at = wordsAfter(text, m.index + m[0].length, max);
      if (at) found.push({type, start: at[0], end: at[1]});
    }
  }
  // "I'm 9", "I am nine years old", "10 years old"
  const age = new RegExp(String.raw`\b(?:i am|i['’]m|im)\s+(\d{1,2}|${NUMBER_WORDS})(?=\s+years?\s+old\b|\s*(?:[.,!?]|$|\s+and\b))|\b(\d{1,2}|${NUMBER_WORDS})(?=\s+years?\s+old\b)`, 'gi');
  for (const m of text.matchAll(age)) {
    const value = m[1] || m[2];
    const start = m.index + m[0].lastIndexOf(value);
    found.push({type: 'AGE', start, end: start + value.length});
  }
  // "I go to Lincoln Elementary", "at lincoln middle school"
  const school = /\b(?:go to|goes to|attend|attends|at|from|in)\s+((?:[a-z.'-]+\s+){1,3}?(?:elementary|middle|high|primary|intermediate)(?:\s+school)?|(?:[a-z.'-]+\s+){1,3}?(?:school|academy))\b/gi;
  for (const m of text.matchAll(school)) {
    const value = m[1];
    const first = value.split(/\s+/)[0].toLowerCase();
    if (STOP.has(first) || ['high', 'middle', 'elementary', 'primary'].includes(first)) continue;
    const start = m.index + m[0].length - value.length;
    found.push({type: 'SCHOOL', start, end: start + value.length});
  }
  return found;
}

function patternSpans(text: string, types: readonly MaskType[] = MASK_TYPES): Span[] {
  return PATTERNS.filter(([type]) => types.includes(type))
      .flatMap(([type, re]) => [...text.matchAll(re)].map((m) => ({type, start: m.index, end: m.index + m[0].length})));
}

async function entitySpans(text: string, ner: FindEntities | null): Promise<Span[]> {
  if (!ner) return [];
  const spans: Span[] = [];
  for (const e of await ner(text)) {
    if (e.type === 'PER') spans.push({type: 'NAME', start: e.start, end: e.end});
    else if (e.type === 'LOC') spans.push({type: 'LOCATION', start: e.start, end: e.end});
    else if (e.type === 'ORG' && SCHOOL_WORD.test(text.slice(e.start, e.end))) spans.push({type: 'SCHOOL', start: e.start, end: e.end});
  }
  return spans;
}

/** Replaces spans with ids; earlier finders win where spans overlap (patterns, then cues, then the model). */
function replaceSpans(text: string, spans: Span[], map: MaskMap): string {
  const kept: Span[] = [];
  for (const s of spans) {
    if (s.end > s.start && !kept.some((k) => s.start < k.end && k.start < s.end)) kept.push(s);
  }
  kept.sort((a, b) => b.start - a.start);
  let out = text;
  for (const s of kept) out = out.slice(0, s.start) + idFor(text.slice(s.start, s.end), s.type, map) + out.slice(s.end);
  return out;
}

function idFor(value: string, type: MaskType, map: MaskMap): string {
  const key = value.trim().toLowerCase();
  let id = map.ids.get(key);
  if (!id) {
    const n = [...map.values.keys()].filter((k) => k.startsWith(`${type}_`)).length + 1;
    id = `${type}_${n}`;
    map.ids.set(key, id);
    map.values.set(id, value.trim());
  }
  return id;
}

/** Masks the learner's own words with every finder. */
export async function maskWords(text: string, map: MaskMap, ner: FindEntities | null): Promise<string> {
  const spans = [...patternSpans(text), ...cueSpans(text), ...(await entitySpans(text, ner))];
  return replaceSpans(text, spans, map);
}

/** Masks program or other text: emails, phones and addresses, plus values already masked in this request. */
export function maskProgram(text: string, map: MaskMap): string {
  return replaceSpans(text, [...patternSpans(text, PROGRAM_TYPES), ...knownSpans(text, map, PROGRAM_TYPES)], map);
}

/** Every value this request already masked, wherever it appears (for repair problems and logs). */
export function maskKnown(text: string, map: MaskMap): string {
  return replaceSpans(text, knownSpans(text, map), map);
}

function knownSpans(text: string, map: MaskMap, types: readonly MaskType[] = MASK_TYPES): Span[] {
  const spans: Span[] = [];
  const lower = text.toLowerCase();
  for (const [id, value] of map.values) {
    const type = id.replace(/_\d+$/, '') as MaskType;
    if (!types.includes(type)) continue;
    const re = new RegExp(`(?<![\\w@])${value.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'g');
    for (const m of lower.matchAll(re)) spans.push({type, start: m.index, end: m.index + m[0].length});
  }
  return spans;
}

/** Learner words quoted in the task so far ("Learner asked: "..."") get every finder; the rest is program text. */
async function maskTaskContext(text: string, map: MaskMap, ner: FindEntities | null): Promise<string> {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    out += maskProgram(text.slice(last, m.index), map) + `"${await maskWords(m[1], map, ner)}"`;
    last = m.index + m[0].length;
  }
  return out + maskProgram(text.slice(last), map);
}

/** A copy of the call with personal information masked, and the map to restore it. */
export async function maskCall(call: AgentCall, ner: FindEntities | null): Promise<{call: AgentCall; map: MaskMap}> {
  const map = newMaskMap();
  const learnerText = await maskWords(call.learnerText, map, ner);
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(call.input)) {
    if (key === 'taskContext' && typeof value === 'string') input[key] = await maskTaskContext(value, map, ner);
    else if (typeof value === 'string') input[key] = maskProgram(value, map);
    else if (Array.isArray(value)) input[key] = value.map((v) => (typeof v === 'string' ? maskProgram(v, map) : v));
    else input[key] = value;
  }
  return {call: {...call, learnerText, input}, map};
}

const ID = new RegExp(String.raw`\b(?:${MASK_TYPES.join('|')})_\d+\b`, 'g');

/**
 * Puts the masked values back in a reply (JSON-escaped, as replies are JSON text).
 * @returns unknown: ids the request never had, left as they are
 */
export function restore(text: string, map: MaskMap): {text: string; unknown: string[]} {
  const unknown = new Set<string>();
  const out = text.replace(ID, (id) => {
    const value = map.values.get(id);
    if (value === undefined) {
      unknown.add(id);
      return id;
    }
    return JSON.stringify(value).slice(1, -1);
  });
  return {text: out, unknown: [...unknown]};
}
