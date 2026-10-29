// @ts-check
// Splits spoken text into sentences, so the AI voice can start early and stop between them.

const ABBREVIATIONS = new Set(['e.g.', 'i.e.', 'etc.', 'vs.', 'mr.', 'mrs.', 'ms.', 'dr.', 'no.']);

/**
 * @param {string} text
 * @returns {!Array<string>}
 */
export function splitSentences(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const sentences = [];
  let current = [];
  for (const [i, word] of words.entries()) {
    current.push(word);
    const next = words[i + 1];
    // An end mark before a capital (or quote) ends a sentence; "2.5" and "e.g." don't.
    const ends = /[.?!]["')]*$/.test(word) && !ABBREVIATIONS.has(word.toLowerCase());
    if (ends && (!next || /^["'(]?[A-Z0-9]/.test(next))) {
      sentences.push(current.join(' '));
      current = [];
    }
  }
  if (current.length) sentences.push(current.join(' '));
  return sentences;
}
