// @ts-check
// Telling speech the app played (the AI voice, navigation speech) from the learner's words when the microphone
// hears it back. The recognizer mishears played speech ("louvre" for "loop"), so words are compared by sound.

import {cleanTranscript} from './draft.js';

// The recognizer writes "i am" where the speech said "I'm", so both are compared without contractions.
const CONTRACTIONS = [[/\b(i)'m\b/g, '$1 am'], [/'re\b/g, ' are'], [/'s\b/g, ' is'], [/'ll\b/g, ' will'], [/'ve\b/g, ' have'],
  [/\bcan't\b/g, 'can not'], [/\bwon't\b/g, 'will not'], [/n't\b/g, ' not'], [/'d\b/g, ' would']];
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** A number as the recognizer writes it ("25" is "twenty five"). */
function numberWords(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ''}`;
  if (n < 10000) return `${ONES[Math.floor(n / 1000)]} thousand${n % 1000 ? ` ${numberWords(n % 1000)}` : ''}`;
  return String(n).split('').map((d) => ONES[Number(d)]).join(' ');
}

/** Words as the recognizer would write them: lower case, contractions and numbers spelled out, no punctuation. */
export function spokenWords(text) {
  return CONTRACTIONS.reduce((t, [from, to]) => t.replace(from, to), cleanTranscript(text))
      .replace(/\d+/g, (d) => ` ${numberWords(Number(d))} `)
      .replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean);
}

// Letters that sound alike share a code; vowels and h, w, y are dropped.
const CODES = {b: '1', f: '1', p: '1', v: '1', c: '2', g: '2', j: '2', k: '2', q: '2', s: '2', x: '2', z: '2',
  d: '3', t: '3', l: '4', m: '5', n: '5', r: '6'};

/** A rough sound key for a word ("print" and "prince" are both 1652). */
export function soundKey(word) {
  const w = word.replace(/^kn/, 'n').replace(/^wr/, 'r').replace(/ph/g, 'f').replace(/gh/g, '').replace(/c(?=[eiy])/g, 's');
  let key = '';
  for (const ch of w) {
    const code = CODES[ch];
    if (code && key[key.length - 1] !== code) key += code;
  }
  return key || w[0] || '';
}

/** Edit distance up to 2 (more is reported as 2). */
function near(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  let edits = 0;
  for (let i = 0, j = 0; i < a.length || j < b.length;) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return 2;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits;
}

/** Whether two words sound alike: the same word, the same sound key, or long keys one sound apart with the same start. */
export function soundsAlike(a, b) {
  if (a === b) return true;
  const ka = soundKey(a);
  const kb = soundKey(b);
  if (ka === kb) return ka.length > 1 || a[0] === b[0];
  return ka.length >= 3 && kb.length >= 3 && a[0] === b[0] && near(ka, kb) === 1;
}

/** The share of heard words that sound like one of the played words (0 when nothing was heard). */
export function playedShare(heard, played) {
  if (!heard.length) return 0;
  const known = new Set(played);
  return heard.filter((w) => known.has(w) || played.some((p) => soundsAlike(w, p))).length / heard.length;
}
