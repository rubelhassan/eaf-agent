// @ts-check
// Explicit spelling and quotes protect literal text from later correction.

const LETTER_NAMES = Object.freeze({
  a: 'A', ay: 'A', b: 'B', bee: 'B', c: 'C', see: 'C', sea: 'C', d: 'D', dee: 'D',
  e: 'E', ee: 'E', f: 'F', ef: 'F', eff: 'F', g: 'G', gee: 'G', h: 'H', aitch: 'H', haitch: 'H',
  i: 'I', eye: 'I', j: 'J', jay: 'J', k: 'K', kay: 'K', l: 'L', el: 'L', ell: 'L',
  m: 'M', em: 'M', n: 'N', en: 'N', o: 'O', oh: 'O', p: 'P', pee: 'P', q: 'Q', cue: 'Q', queue: 'Q',
  r: 'R', are: 'R', ar: 'R', s: 'S', ess: 'S', es: 'S', t: 'T', tee: 'T', tea: 'T',
  u: 'U', you: 'U', v: 'V', vee: 'V', w: 'W', x: 'X', ex: 'X', y: 'Y', why: 'Y', z: 'Z', zee: 'Z', zed: 'Z',
});
const DIGITS = Object.freeze({zero: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9'});
const edgePunctuation = (text) => text.replace(/^[\s,.]+|[\s,.]+$/g, '');

/** @typedef {{text: string, kind: 'heard'|'spelled'|'quoted'}} ModeSegment */

function spellingToken(token) {
  const word = token.replace(/[.,]$/, '');
  const lower = word.toLowerCase();
  if (Object.hasOwn(LETTER_NAMES, lower)) return LETTER_NAMES[lower];
  if (Object.hasOwn(DIGITS, lower)) return DIGITS[lower];
  if (/^[0-9]+$/.test(word)) return word;
  if (/^[A-Z0-9]+$/.test(word) || /^[a-z0-9](?:[.-][a-z0-9])+$/i.test(word)) return word.replace(/[.-]/g, '').toUpperCase();
  return null;
}

function readSpelling(text, start) {
  const tokens = [...text.slice(start).matchAll(/\S+/g)];
  let value = '';
  let end = start;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    let lower = false;
    if (/^small[,.]?$/i.test(token[0])) {
      lower = true;
      i++;
      if (!tokens[i]) break;
    }
    const current = tokens[i];
    let letter = spellingToken(current[0]);
    if (/^double$/i.test(current[0]) && /^you[,.]?$/i.test(tokens[i + 1]?.[0] || '')) {
      letter = 'W'; i++;
    }
    if (!letter || (lower && !/^[A-Z]$/.test(letter))) break;
    value += lower ? letter.toLowerCase() : letter;
    end = start + tokens[i].index + tokens[i][0].length;
  }
  return value ? {text: value, end} : null;
}

function spellSegments(text) {
  const segments = [];
  let position = 0;
  for (const trigger of text.matchAll(/\bspell\b[,.]?\s*/gi)) {
    if (trigger.index < position) continue;
    const result = readSpelling(text, trigger.index + trigger[0].length);
    if (!result) continue;
    segments.push({text: text.slice(position, trigger.index).replace(/[,.]\s*$/, ' '), kind: 'heard'},
        {text: result.text, kind: 'spelled'});
    position = result.end;
  }
  segments.push({text: text.slice(position), kind: 'heard'});
  return segments;
}

function quoteParts(text) {
  const tokens = [...text.matchAll(/"[^"]*"|\b(?:end[\s,.]+)?(?:quote|quotation)\b/gi)];
  const parts = [];
  let position = 0;
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i];
    if (open[0].startsWith('"')) {
      let end = open.index + open[0].length;
      const ending = tokens[i + 1];
      if (ending && !ending[0].startsWith('"') && (/^end/i.test(ending[0]) || !tokens[i + 2]) &&
          /^[\s,.]*$/.test(text.slice(end, ending.index))) {
        end = ending.index + ending[0].length;
        end += text.slice(end).match(/^[,.]+/)?.[0].length || 0;
        i++;
      }
      parts.push({start: open.index, end, text: open[0]});
      continue;
    }
    if (/^end/i.test(open[0])) continue;
    const next = tokens[i + 1];
    if (!next) continue;
    let close = next;
    let content;
    if (next[0].startsWith('"') && /^[\s,.]*$/.test(text.slice(open.index + open[0].length, next.index))) {
      content = next[0].slice(1, -1);
      i++;
      const ending = tokens[i + 1];
      if (ending && !ending[0].startsWith('"') && /^[\s,.]*$/.test(text.slice(next.index + next[0].length, ending.index))) {
        close = ending; i++;
      }
    } else {
      let closeIndex = i + 1;
      while (tokens[closeIndex]?.[0].startsWith('"')) closeIndex++;
      close = tokens[closeIndex];
      if (!close) continue;
      content = edgePunctuation(text.slice(open.index + open[0].length, close.index));
      i = closeIndex;
      if (content.startsWith('"') && content.endsWith('"')) content = content.slice(1, -1);
    }
    let start = open.index;
    const preceding = text.slice(position, start).match(/[,.]\s*$/);
    if (preceding) start -= preceding[0].length;
    let end = close.index + close[0].length;
    end += text.slice(end).match(/^[,.]+/)?.[0].length || 0;
    parts.push({start, end, text: `${preceding ? ' ' : ''}"${edgePunctuation(content)}"`});
    position = end;
  }
  return parts;
}

/** Apply explicit modes without guessing at ordinary words or unclosed quotes.
 * @param {string} text
 * @returns {{text: string, segments: !Array<!ModeSegment>}}
 */
export function applyModes(text) {
  if (typeof text !== 'string') throw new TypeError('A transcript must be text.');
  const segments = [];
  let position = 0;
  for (const part of quoteParts(text)) {
    segments.push(...spellSegments(text.slice(position, part.start)), {text: part.text, kind: 'quoted'});
    position = part.end;
  }
  segments.push(...spellSegments(text.slice(position)));
  const kept = segments.filter((segment) => segment.text);
  return {text: kept.map((segment) => segment.text).join(''), segments: kept};
}
