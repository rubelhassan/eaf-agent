// @ts-check
// Keep displayed words separate from the text used for matching.

const FILLERS = new Set(['a', 'an', 'and', 'the', 'uh', 'um', 'hmm', 'mm', 'oh', 'ah']);

/** Lower case and single spaces for matching only. */
export function cleanTranscript(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** @param {*} text @param {{cased?: boolean}} options */
export function shownTranscript(text, {cased = false} = {}) {
  const shown = String(text || '').replace(/\s+/g, ' ').trim();
  return cased ? shown : shown.toLowerCase();
}

/** @param {!Array<string>} plainWords */
export function isStraySound(plainWords) {
  return plainWords.every((word) => FILLERS.has(word) || word.length === 1) &&
      plainWords.filter((word) => word.length === 1 && !FILLERS.has(word)).length < 2;
}

/**
 * The draft with a finished piece of speech added at the end.
 * @param {string} draft  What is in the text box now (typed or spoken earlier).
 * @param {string} words
 */
export function appendToDraft(draft, words) {
  const said = String(words || '').trim();
  if (!said) return draft;
  const before = String(draft || '').replace(/\s+$/, '');
  return before ? `${before} ${said}` : said;
}

/** Empty anchors gain a separating space only when a replay fills them. */
function segmentLayout(pieces) {
  const out = [];
  let text = '';
  let previous;
  for (const piece of pieces) {
    if (piece.utterance !== undefined && piece.utterance !== previous && piece.text && text && !/\s$/.test(text) && !/^\s/.test(piece.text)) {
      out.push({text: ' ', kind: 'heard'}); text += ' ';
    }
    out.push(piece); text += piece.text;
    previous = piece.utterance;
  }
  return out;
}

function joinHeard(pieces) {
  const joined = [];
  for (const piece of pieces) {
    const previous = joined[joined.length - 1];
    if (piece.kind === 'heard' && previous?.kind === 'heard' &&
        piece.utterance === previous.utterance && piece.provisional === previous.provisional) {
      joined[joined.length - 1] = {...previous, text: previous.text + piece.text};
    } else joined.push(piece);
  }
  return joined;
}

/**
 * @typedef {{id?: number, text: string, kind?: string, utterance?: number, provisional?: boolean,
 *     covers?: !Array<number>}} DraftPiece
 */

/**
 * Applies one complete covering group, or leaves an edited group alone.
 * @param {!Array<!DraftPiece>} pieces
 * @param {!Array<{utterance: number, text: string, segments?: !Array<!DraftPiece>}>} updates
 * @returns {?{segments: !Array<!DraftPiece>, text: string}}
 */
export function reviseSegments(pieces, updates) {
  if (updates.some((update) => !pieces.some((piece) => piece.provisional && piece.utterance === update.utterance))) return null;
  const replacements = new Map(updates.map((update) => [update.utterance, update]));
  const replaced = new Set();
  const segments = pieces.flatMap((piece) => {
    const update = replacements.get(piece.utterance);
    if (!update) return [{...piece}];
    if (replaced.has(piece.utterance)) return [];
    replaced.add(piece.utterance);
    const parts = update.segments?.length ? update.segments : [{text: update.text, kind: 'heard'}];
    return parts.map((part, index) => ({...part, utterance: piece.utterance, provisional: false,
      ...(index === 0 ? {id: piece.id, ...(piece.covers ? {covers: [...piece.covers]} : {})} : {})}));
  });
  return {segments, text: segmentLayout(segments).map((piece) => piece.text).join('')};
}

/**
 * Spoken pieces keep their provenance until the learner edits them.
 * @param {{onDrop?: function(number): void}=} options
 */
export function createDraftSegments({onDrop = () => {}} = {}) {
  let pieces = [];
  let next = 0;
  const value = () => segmentLayout(pieces).map((piece) => piece.text).join('');
  const plain = (text) => ({id: ++next, text, kind: 'heard'});

  function set(text) {
    text = String(text || '');
    const before = value();
    if (before === text) return;
    let start = 0;
    while (start < before.length && start < text.length && before[start] === text[start]) start++;
    let oldEnd = before.length;
    let newEnd = text.length;
    while (oldEnd > start && newEnd > start && before[oldEnd - 1] === text[newEnd - 1]) { oldEnd--; newEnd--; }
    const delta = newEnd - oldEnd;
    const inserted = text.slice(start, newEnd);
    const kept = [];
    const dropped = new Set();
    let position = 0;
    for (const piece of segmentLayout(pieces)) {
      const end = position + piece.text.length;
      const overlap = position < oldEnd && (end > start || (!piece.text && position >= start));
      const inside = oldEnd === start && position < start && end > start;
      const joined = oldEnd === start && ((start === end && /^\S/.test(inserted)) ||
        (start === position && /\S$/.test(inserted)));
      const protectedPiece = piece.utterance !== undefined || piece.kind === 'spelled' || piece.kind === 'quoted';
      if (protectedPiece && !(overlap || inside || joined)) {
        kept.push({piece, start: position >= oldEnd ? position + delta : position});
      } else if (piece.provisional) dropped.add(piece.utterance);
      position = end;
    }
    pieces = [];
    position = 0;
    for (const entry of kept) {
      if (entry.start > position) pieces.push(plain(text.slice(position, entry.start)));
      pieces.push(entry.piece);
      position = entry.start + entry.piece.text.length;
    }
    if (position < text.length) pieces.push(plain(text.slice(position)));
    dropped.forEach(onDrop);
  }

  function append(text, metadata = {}) {
    text = String(text || '').trim();
    if (!text) return value();
    const {segments: parts = [{text, kind: 'heard'}], ...provenance} = metadata;
    const previous = metadata.provisional && pieces.find((piece) => piece.provisional && piece.utterance === metadata.utterance);
    const added = parts.map((part) => ({...plain(part.text), ...part, ...provenance}));
    if (previous) {
      const indices = pieces.flatMap((piece, index) => piece.utterance === metadata.utterance ? [index] : []);
      const last = indices[indices.length - 1];
      if (pieces[last].text) pieces.splice(last + 1, 0, {...plain(' '), ...provenance}, ...added);
      else pieces.splice(last, 1, ...added);
    } else {
      const before = value().replace(/\s+$/, '');
      set(before);
      if (before) pieces.push(plain(' '));
      pieces.push(...added);
    }
    pieces = joinHeard(pieces);
    return value();
  }

  return {
    value, set, append,
    segments: () => segmentLayout(pieces).map((piece) => ({...piece})),
    reserve(utterance) {
      pieces.push({...plain(''), utterance, provisional: true});
    },
    cover(ids) {
      const piece = pieces.find((piece) => piece.utterance === ids[0]);
      if (piece) piece.covers = [...ids];
    },
    replaceGroup(updates) {
      const result = reviseSegments(pieces, updates);
      if (!result) return false;
      pieces = result.segments;
      return true;
    },
    replace(utterance, text) {
      const result = reviseSegments(pieces, [{utterance, text}]);
      if (!result) return false;
      pieces = result.segments;
      return true;
    },
    release(utterance) {
      for (const piece of pieces) if (piece.utterance === utterance) piece.provisional = false;
    },
    take() {
      const sent = segmentLayout(pieces).map((piece) => ({...piece}));
      pieces = [];
      return sent;
    },
    clear() {
      const dropped = new Set(pieces.filter((piece) => piece.provisional).map((piece) => piece.utterance));
      pieces = [];
      dropped.forEach(onDrop);
    },
  };
}
