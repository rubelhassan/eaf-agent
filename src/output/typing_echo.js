// @ts-check
// Typing echo for the built-in voice, the way a screen reader echoes keys: what was typed (characters, words or
// both), the character Backspace or Delete removes, and the character the caret lands on with Left or Right.
// Every text field in the page; nothing while navigation speech goes to the screen reader (it echoes by itself).

export const TYPING_ECHO_MODES = Object.freeze(['characters', 'words', 'both', 'off']);

const NAMES = {
  ' ': 'space', '.': 'period', ',': 'comma', '?': 'question mark', '!': 'exclamation mark', ':': 'colon',
  ';': 'semicolon', "'": 'apostrophe', '"': 'quote', '-': 'dash', '_': 'underscore', '+': 'plus', '=': 'equals',
  '*': 'star', '/': 'slash', '\\': 'backslash', '(': 'left paren', ')': 'right paren', '[': 'left bracket',
  ']': 'right bracket', '{': 'left brace', '}': 'right brace', '<': 'less than', '>': 'greater than', '@': 'at',
  '#': 'hash', '$': 'dollar', '%': 'percent', '^': 'caret', '&': 'and', '|': 'bar', '~': 'tilde', '`': 'back quote',
  '\t': 'tab', '\n': 'new line',
};

/** How one character is said: spaces and punctuation in words, capitals as "capital H". */
export function charName(ch) {
  if (NAMES[ch]) return NAMES[ch];
  if (ch !== ch.toLowerCase()) return `capital ${ch}`;
  return ch;
}

const sayText = (text) => (text.length === 1 ? charName(text) : text);
const WORD_END = /[^\p{L}\p{N}_']/u;
const TEXT_TYPES = new Set(['text', 'search', 'number', 'email', 'url', 'tel']);

/** A text field the learner types in (not a password, not read-only). */
function isTextField(el) {
  if (!el || el.readOnly || el.disabled) return false;
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && TEXT_TYPES.has((el.getAttribute('type') || 'text').toLowerCase());
}

/**
 * What to say after an insert: the character, the word it ended, or both.
 * @param {string} mode characters, words or both
 * @param {string} typed the inserted text
 * @param {string} before the field's text before the caret, the inserted text included
 * @returns {string} empty when there is nothing to say
 */
export function insertEcho(mode, typed, before) {
  const chars = mode === 'words' ? '' : sayText(typed);
  const ended = typed.length === 1 && WORD_END.test(typed);
  const word = mode !== 'characters' && ended ? before.slice(0, -1).match(/[\p{L}\p{N}_']+$/u)?.[0] || '' : '';
  return [word, chars].filter(Boolean).join(', ');
}

/**
 * @param {{document: !Document, output: {say: function(!Object): void, settings: function(): !Object}}} options
 *     output: the output manager; its settings say the route (systemOutput) and the mode (typingEcho)
 * @returns {function(): void} stops listening
 */
export function bindTypingEcho({document: doc, output}) {
  const mode = () => {
    const {systemOutput, typingEcho = 'characters'} = output.settings();
    return systemOutput === 'systemVoice' ? typingEcho : 'off';
  };
  const say = (text) => text && output.say({source: 'system', kind: 'echo', text});
  const win = doc.defaultView;
  const later = (fn) => (win ? win.setTimeout(fn, 0) : setTimeout(fn, 0));

  // The removed text is known only before the input changes.
  const onBeforeInput = (e) => {
    const field = e.target;
    if (!isTextField(field) || mode() === 'off' || !e.inputType?.startsWith('delete')) return;
    const {value, selectionStart: start, selectionEnd: end} = field;
    if (start == null || end == null) return;
    let removed = value.slice(start, end);
    if (!removed && e.inputType === 'deleteContentBackward') removed = value.slice(Math.max(0, start - 1), start);
    if (!removed && e.inputType === 'deleteContentForward') removed = value.slice(start, start + 1);
    say(removed && sayText(removed));
  };
  const onInput = (e) => {
    const field = e.target;
    const now = mode();
    if (!isTextField(field) || now === 'off' || e.inputType !== 'insertText' || !e.data) return;
    const caret = field.selectionStart ?? field.value.length;
    say(insertEcho(now, e.data, field.value.slice(0, caret)));
  };
  const onKeyDown = (e) => {
    const field = e.target;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || !isTextField(field) || mode() === 'off') return;
    // After the caret moved: the character it is on now.
    later(() => {
      if (doc.activeElement !== field || field.selectionStart == null) return;
      const ch = field.value.charAt(field.selectionStart);
      say(ch ? charName(ch) : 'blank');
    });
  };
  doc.addEventListener('beforeinput', onBeforeInput, true);
  doc.addEventListener('input', onInput, true);
  doc.addEventListener('keydown', onKeyDown, true);
  return () => {
    doc.removeEventListener('beforeinput', onBeforeInput, true);
    doc.removeEventListener('input', onInput, true);
    doc.removeEventListener('keydown', onKeyDown, true);
  };
}
