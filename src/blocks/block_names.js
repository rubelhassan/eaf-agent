/**
 * Human-readable names for block types, for speech and the teacher UI.
 * The code always stores real type ids; these names are presentation only.
 */

/** @type {!Object<string, string>} */
const NAMES = {
  // Logic
  controls_if: 'if',
  logic_compare: 'compare',
  logic_operation: 'and or',
  logic_negate: 'not',
  logic_boolean: 'true or false',
  logic_null: 'null',
  logic_ternary: 'test then else',
  // Loops
  controls_repeat_ext: 'repeat times',
  controls_whileUntil: 'repeat while',
  controls_for: 'count with',
  controls_forEach: 'for each item',
  controls_flow_statements: 'break or continue',
  // Math
  math_number: 'number',
  math_arithmetic: 'arithmetic',
  math_single: 'square root and other math functions',
  math_trig: 'trigonometry',
  math_constant: 'math constant',
  math_number_property: 'number is even or odd',
  math_round: 'round',
  math_on_list: 'math on list',
  math_modulo: 'remainder',
  math_constrain: 'constrain',
  math_random_int: 'random integer',
  math_random_float: 'random fraction',
  math_atan2: 'atan2',
  math_change: 'change variable by',
  // Text
  text: 'text',
  text_print: 'print',
  text_prompt_ext: 'prompt for input',
  text_join: 'create text with',
  text_append: 'append text',
  text_length: 'length of text',
  text_isEmpty: 'text is empty',
  text_indexOf: 'find in text',
  text_charAt: 'letter in text',
  text_getSubstring: 'part of text',
  text_changeCase: 'change text case',
  text_trim: 'trim spaces',
  text_count: 'count in text',
  text_replace: 'replace in text',
  text_reverse: 'reverse text',
  // Lists
  lists_create_with: 'create list with',
  lists_repeat: 'list with item repeated',
  lists_length: 'length of list',
  lists_isEmpty: 'list is empty',
  lists_indexOf: 'find in list',
  lists_getIndex: 'get item from list',
  lists_setIndex: 'set item in list',
  lists_getSublist: 'part of list',
  lists_split: 'split or join',
  lists_sort: 'sort list',
  lists_reverse: 'reverse list',
  // Variables and functions
  variables_get: 'variable',
  variables_set: 'set variable',
  procedures_defnoreturn: 'define function',
  procedures_defreturn: 'define function with result',
  procedures_callnoreturn: 'call function',
  procedures_callreturn: 'call function with result',
  procedures_ifreturn: 'if return',
};

/**
 * @param {string} type
 * @returns {string} A readable name, falling back to the type id with underscores as spaces.
 */
export function blockTypeName(type) {
  if (!type) return 'block';
  return NAMES[type] || type.replace(/_/g, ' ');
}

/** "a compare", "an arithmetic": the indefinite article for a spoken name. */
export function withArticle(name) {
  return `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`;
}

/**
 * Joins names for speech: ["a"] → "a", ["a","b"] → "a or b", ["a","b","c"] → "a, b, or c".
 * @param {!Array<string>} names
 * @returns {string}
 */
export function joinAlternatives(names) {
  if (names.length <= 1) return names[0] || '';
  if (names.length === 2) return `${names[0]} or ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, or ${names[names.length - 1]}`;
}

/** Spoken phrase for a Blockly output check value (a single check name). */
const VALUE_PHRASES = {
  Boolean: 'a true or false value',
  Number: 'a number',
  String: 'text',
  Array: 'a list',
};

/**
 * @param {?Array<string>} check  An output connection check, or null for "any".
 * @returns {?string}
 */
export function valuePhrase(check) {
  if (!check || check.length !== 1) return null;
  return VALUE_PHRASES[check[0]] || null;
}
