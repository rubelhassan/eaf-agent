// @ts-check
// Spoken words into the draft: recognizers give upper-case text without punctuation.

/** Recognizer text as the learner would type it: lower case, single spaces. */
export function cleanTranscript(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The draft with a finished piece of speech added at the end.
 * @param {string} draft  What is in the text box now (typed or spoken earlier).
 * @param {string} words
 */
export function appendToDraft(draft, words) {
  const said = cleanTranscript(words);
  if (!said) return draft;
  const before = String(draft || '').replace(/\s+$/, '');
  return before ? `${before} ${said}` : said;
}
