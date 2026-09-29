/**
 * AI hints: which levels a learner may get, grounded requests for
 * AgentServices.generateHint, output checks, a cache, and a safe fallback when
 * the agent is unavailable or its output fails the checks.
 */

import {AGENT_TIMEOUT_MS} from '../../agent/contracts.js';
import {Activity, getPolicy} from '../policy.js';
import {blockTypeName} from '../block_names.js';
import {blockTypes} from '../registry.js';
import {QUESTION_MARKER} from './generator.js';
import {AI_LEVEL_ORDER, AiHintLevel, Expects} from './model.js';
import {membersOf} from './rules.js';
import {needPhrase} from './speech.js';

/** What each level may say; sent to the model and used for fallbacks. */
export const LEVEL_RULES = Object.freeze({
  [AiHintLevel.NUDGE]: 'Ask one short guiding question. Do not name any block or category.',
  [AiHintLevel.POINT]: 'Name the idea or the toolbox category that helps. Do not name the exact block.',
  [AiHintLevel.KIND]: 'Name the block to use and what goes into it. Do not give exact values or the finished answer.',
});

const FALLBACKS = Object.freeze({
  [AiHintLevel.NUDGE]: 'What does this part of the program need to do? Try saying it in your own words first.',
  [AiHintLevel.POINT]: 'Think about which toolbox category has blocks that do that kind of job.',
  [AiHintLevel.KIND]: 'Look again at what the question needs, then find a block that matches it.',
});

/**
 * The AI levels a learner may ask for, in order: escalating one level per hint
 * up to the teacher's ceiling, then staying there, up to the allowed count.
 * @param {!import('./model.js').QuestionConfig} config
 * @param {string} activity  One of Activity.
 * @returns {!Array<string>} Empty when AI hints are off here.
 */
export function aiHintLevels(config, activity) {
  const {level, count, allowInQuiz} = config.ai;
  if (level === AiHintLevel.OFF) return [];
  if (activity === Activity.QUIZ && !allowInQuiz) return [];
  const ceiling = AI_LEVEL_ORDER.indexOf(level);
  return Array.from({length: count}, (_, i) => AI_LEVEL_ORDER[Math.min(i, ceiling)]);
}

/**
 * The program as JavaScript with the question marked (or, if answered, the answer
 * code on its own), for grounding. Empty strings when no generator is installed.
 * @returns {{program: string, answer: ?string}}
 */
function programContext(block, gap) {
  const generator = blockTypes.generator('javascript');
  if (!generator) return {program: '', answer: null};
  const workspace = block.workspace;
  generator.eafMarkQuestion = gap;
  try {
    generator.init(workspace);
    const program = generator.workspaceToCode(workspace).trim();
    let answer = null;
    const members = membersOf(workspace, gap);
    if (members.length) {
      generator.init(workspace);
      const code = generator.blockToCode(members[0], /* opt_thisOnly= */ members.length === 1);
      answer = (Array.isArray(code) ? code[0] : code).trim();
    }
    return {program, answer};
  } catch (e) {
    return {program: '', answer: null};
  } finally {
    generator.eafMarkQuestion = null;
  }
}

/**
 * Everything the model needs to write one hint.
 * @param {!Blockly.Block} block  The question block or a block answering it.
 * @param {{gap: string, config: !Object}} question
 * @param {string} level  One of AiHintLevel (not OFF).
 * @param {!Array<string>} previousHints  Hint texts already given, in order.
 */
export function buildHintRequest(block, question, level, previousHints) {
  const {config, gap} = question;
  const {program, answer} = programContext(block, gap);
  return {
    level,
    levelRule: LEVEL_RULES[level],
    learnerLevel: getPolicy(block.workspace).learnerLevel,
    question: {
      kind: config.expects === Expects.VALUE ? 'value' : 'statement',
      prompt: config.prompt,
      instruction: config.instruction,
      needs: needPhrase(config),
      intendedBlocks: config.intendedTypes.map(blockTypeName),
    },
    programMarker: QUESTION_MARKER,
    program,
    learnerAnswer: answer,
    previousHints,
    teacherNote: config.ai.note,
  };
}

/**
 * Makes model output speech-ready and checks it against the level's limits.
 * @param {*} text
 * @param {string} level
 * @param {!import('./model.js').QuestionConfig} config
 * @returns {{ok: boolean, text: string, reason?: string}}
 */
export function checkHint(text, level, config) {
  let clean = String(text ?? '')
      .replace(/[*_`#>~]+/g, '')
      .replace(/^\s*[-•\d.)]+\s+/gm, '')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  const sentences = clean.match(/[^.!?]+[.!?]+/g) || (clean ? [clean] : []);
  clean = sentences.slice(0, 2).map((x) => x.trim()).join(' ').slice(0, 240).trim();

  if (!clean) return {ok: false, text: '', reason: 'The hint was empty.'};
  if (/[{};=]|\bwindow\.|\bconsole\.|\(\s*\)/.test(clean)) {
    return {ok: false, text: clean, reason: 'Do not include code. Use plain words.'};
  }
  if (level !== AiHintLevel.KIND) {
    const lower = clean.toLowerCase();
    const named = config.intendedTypes.find((type) =>
      lower.includes(type.toLowerCase()) || lower.includes(`${blockTypeName(type).toLowerCase()} block`));
    if (named) return {ok: false, text: clean, reason: 'Do not name the exact block at this level.'};
  }
  return {ok: true, text: clean};
}

/** Generates, checks, and caches AI hints for a workspace. */
export class AiHintService {
  /** @param {?import('../../agent/contracts.js').AgentServices} agent */
  constructor(agent) {
    this.agent_ = agent;
    /** @type {!Map<string, string>} */
    this.cache_ = new Map();
  }

  /** @returns {boolean} */
  available() {
    return typeof this.agent_?.generateHint === 'function';
  }

  /**
   * @param {!Blockly.Block} block
   * @param {{gap: string, config: !Object}} question
   * @param {string} level
   * @param {!Array<string>} previousHints
   * @returns {!Promise<string>} A checked hint (or a safe fallback).
   */
  async generate(block, question, level, previousHints) {
    const request = buildHintRequest(block, question, level, previousHints);
    const key = JSON.stringify([question.gap, level, previousHints.length, request.program, request.learnerAnswer]);
    if (this.cache_.has(key)) return this.cache_.get(key);

    let hint = FALLBACKS[level];
    if (this.available()) {
      let retryReason = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const raw = await withTimeout((signal) =>
            this.agent_.generateHint(retryReason ? {...request, retryReason} : request, {signal}));
          const result = checkHint(raw?.hint, level, question.config);
          if (result.ok) {
            hint = result.text;
            break;
          }
          retryReason = result.reason;
        } catch (e) {
          break;
        }
      }
    }
    this.cache_.set(key, hint);
    return hint;
  }
}

/** Aborts the call and rejects after AGENT_TIMEOUT_MS. */
async function withTimeout(call) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
  try {
    return await call(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
