/**
 * Question block configuration: schema, defaults, and normalization.
 * Pure data with no Blockly dependency, so it can be validated anywhere.
 */

export const QUESTION_TYPE = 'question';

/** The slot a learner puts their answer into (the question then vanishes). */
export const ANSWER_INPUT = 'ANSWER';

export const Expects = Object.freeze({
  VALUE: 'value',
  STATEMENT: 'statement',
  SEQUENCE: 'sequence',
});

/** How much help AI hints may give, in escalation order. */
export const AiHintLevel = Object.freeze({
  OFF: 'off',
  NUDGE: 'nudge',
  POINT: 'point',
  KIND: 'kind',
});
export const AI_LEVEL_ORDER = [AiHintLevel.NUDGE, AiHintLevel.POINT, AiHintLevel.KIND];
export const MAX_AI_HINTS = 5;

export const CONFIG_VERSION = 1;

/** Event groups made by the system (e.g. a scaffold) start with this; they never open the Edit question form. */
export const GENERATED_GROUP_PREFIX = 'eaf-generated:';

/**
 * @typedef {Object} QuestionConfig
 * @property {number} v
 * @property {string} expects  One of Expects.
 * @property {number} minBlocks  Minimum answer blocks for a sequence gap (>= 1).
 * @property {!Array<string>} intendedTypes  Block type ids that may fill the gap; empty = any.
 * @property {?string} needLabel  Teacher override for the spoken "needs …" phrase.
 * @property {string} prompt  Short description of what the gap should accomplish.
 * @property {string} instruction  Longer guidance.
 * @property {!Array<string>} hints  Static hints, revealed in order.
 * @property {!AiHintConfig} ai  AI hint settings.
 * @property {?Object} reference  Hidden reference answer (Blockly block state), or null.
 * @property {boolean} offerChoices  Learners may open choices built from the reference.
 */

/**
 * @typedef {Object} AiHintConfig
 * @property {string} level  Ceiling, one of AiHintLevel.
 * @property {number} count  How many AI hints the learner may ask for (1..MAX_AI_HINTS).
 * @property {string} note  Optional guidance for the AI from the teacher.
 * @property {boolean} allowInQuiz  AI hints are off in quizzes unless this is true.
 */

/** @returns {!QuestionConfig} */
export function defaultConfig() {
  return {
    v: CONFIG_VERSION,
    expects: Expects.VALUE,
    minBlocks: 1,
    intendedTypes: [],
    needLabel: null,
    prompt: '',
    instruction: '',
    hints: [],
    ai: {level: AiHintLevel.OFF, count: 2, note: '', allowInQuiz: false},
    reference: null,
    offerChoices: true,
  };
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');

const textList = (value) =>
  Array.isArray(value) ? value.map(text).filter(Boolean) : [];

/**
 * Coerces any input (saved state, teacher form, older versions) into a valid config.
 * Never throws; unknown or malformed fields fall back to defaults.
 * @param {*} raw
 * @returns {!QuestionConfig}
 */
export function normalizeConfig(raw) {
  const config = defaultConfig();
  if (!raw || typeof raw !== 'object') return config;

  if (Object.values(Expects).includes(raw.expects)) config.expects = raw.expects;

  const min = Number(raw.minBlocks);
  config.minBlocks = Number.isInteger(min) && min >= 1 ? min : 1;

  config.intendedTypes = [...new Set(textList(raw.intendedTypes))];
  config.needLabel = text(raw.needLabel) || null;
  config.prompt = text(raw.prompt);
  config.instruction = text(raw.instruction);
  config.hints = textList(raw.hints);

  if (raw.ai && typeof raw.ai === 'object') {
    const level = Object.values(AiHintLevel).includes(raw.ai.level) ? raw.ai.level : AiHintLevel.OFF;
    const count = Number(raw.ai.count);
    config.ai = {
      level,
      count: Number.isInteger(count) ? Math.min(MAX_AI_HINTS, Math.max(1, count)) : 2,
      note: text(raw.ai.note),
      allowInQuiz: raw.ai.allowInQuiz === true,
    };
  }
  config.offerChoices = raw.offerChoices !== false;
  const ref = raw.reference;
  config.reference = ref && typeof ref === 'object' && typeof ref.type === 'string' ? structuredClone(ref) : null;
  return config;
}

/**
 * @param {!QuestionConfig} config
 * @returns {boolean} True if the gap holds statements (statement or sequence).
 */
export function isStatementGap(config) {
  return config.expects !== Expects.VALUE;
}
