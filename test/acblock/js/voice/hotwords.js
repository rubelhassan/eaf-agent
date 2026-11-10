// @ts-check
const STACK_WORDS = [...'abcdefgh'].map((letter) => `stack ${letter}`);
const ANSWER_WORDS = ['yes do it', 'do all', 'undo', 'undo it', 'take it back', 'stop', 'go there', 'say that again'];

/** The app and replay use the same vocabulary, in the same order.
 * @param {!Array<string>} blockNames
 */
export function recognizerHotwords(blockNames = []) {
  return [...new Set(blockNames.map((name) => name.toLowerCase())), ...STACK_WORDS, ...ANSWER_WORDS];
}
