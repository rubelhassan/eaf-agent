// A small named-entity model run on this machine (transformers.js). Files come from `npm run models`.

import fs from 'node:fs';
import path from 'node:path';
import {env, pipeline} from '@huggingface/transformers';

export interface Entity {
  type: 'PER' | 'LOC' | 'ORG' | 'MISC';
  start: number;
  end: number;
  score: number;
}

export type FindEntities = (text: string) => Promise<Entity[]>;

type Token = {entity: string; score: number; index: number; word: string};

const MIN_SCORE = 0.5;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Token pieces back into spans of the text ("##" pieces join the word before). */
export function spans(text: string, tokens: Token[]): Entity[] {
  const groups: Array<{type: string; words: string[]; scores: number[]; last: number}> = [];
  for (const t of [...tokens].sort((a, b) => a.index - b.index)) {
    const type = t.entity.replace(/^[BI]-/, '');
    const prev = groups[groups.length - 1];
    const joins = prev && prev.type === type && t.index === prev.last + 1 && (t.entity.startsWith('I-') || t.word.startsWith('##'));
    if (joins) {
      prev.words.push(t.word);
      prev.scores.push(t.score);
      prev.last = t.index;
    } else {
      groups.push({type, words: [t.word], scores: [t.score], last: t.index});
    }
  }
  const found: Entity[] = [];
  let from = 0;
  for (const g of groups) {
    const source = g.words.map((w, i) => (w.startsWith('##') ? escape(w.slice(2)) : `${i ? '\\s*' : ''}${escape(w)}`)).join('');
    const re = new RegExp(source, 'g');
    re.lastIndex = from;
    const m = re.exec(text);
    if (!m) continue;
    // The model may tag only a word's first piece ("Z" of "Zara"); the whole word goes.
    let start = m.index;
    let end = m.index + m[0].length;
    while (start > 0 && /\w/.test(text[start - 1])) start--;
    while (end < text.length && /\w/.test(text[end])) end++;
    from = end;
    const score = g.scores.reduce((a, b) => a + b, 0) / g.scores.length;
    if (score >= MIN_SCORE) found.push({type: g.type as Entity['type'], start, end, score});
  }
  return found;
}

/**
 * Speech comes all lower case, and names often do in typing ("hi zoe"); the model leans on capitals. A lower-case
 * word its vocabulary knows only with a capital ("liam", "chicago") gets one back; with `unknown`, so does a word it
 * doesn't know at all. Same length, same offsets.
 */
export function trueCase(text: string, vocab: Set<string>, {unknown = false} = {}): string {
  return text.replace(/\b[a-z]+\b/g, (w) => {
    const capital = w[0].toUpperCase() + w.slice(1);
    if (vocab.has(w)) return w;
    return vocab.has(capital) || (unknown && w.length > 2) ? capital : w;
  });
}

/**
 * Loads a model from `dir` (server/models). Throws when its files are missing.
 * @param name e.g. Xenova/bert-base-NER
 */
export async function loadNer(name: string, dir: string, {unknown = true} = {}): Promise<FindEntities> {
  if (!fs.existsSync(path.join(dir, name, 'onnx', 'model_quantized.onnx'))) {
    throw new Error(`the name finder ${name} is missing; run "npm run models" in server/`);
  }
  env.localModelPath = dir.endsWith('/') ? dir : `${dir}/`;
  env.allowRemoteModels = false;
  const run = await pipeline('token-classification', name, {dtype: 'q8'});
  const vocab = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, name, 'tokenizer.json'), 'utf8')).model.vocab));
  return async (text) => {
    if (!text.trim()) return [];
    const cased = trueCase(text, vocab, {unknown});
    return spans(cased, (await run(cased)) as Token[]);
  };
}
