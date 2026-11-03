// @ts-check
// Search: code answers a unique exact hit with no model call; anything else goes to the model.

import * as Blockly from 'blockly/core';
import {blockPositions, snapshot} from '../context/snapshot.js';
import {speechProblems} from '../guardrails/speech.js';
import {blockTypeName} from '../../blocks/block_names.js';
import {askWithRepair, parseJsonReply} from './run.js';
import {workspaceVersion} from '../context/version.js';
import {inQuestionSlot} from '../guardrails/learner_work.js';


// Words learners use for a kind, besides its toolbox name.
const ALIASES = {
  controls_if: ['if'],
  controls_repeat_ext: ['repeat'],
  controls_whileUntil: ['while', 'repeat while'],
  controls_for: ['for', 'count with', 'count'],
  controls_forEach: ['for each'],
  text_print: ['print'],
  text_prompt_ext: ['prompt', 'ask'],
};

const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The statement a value block sits in (or the block itself). */
function statementOf(block) {
  let b = block;
  while (b.outputConnection && b.getParent()) b = b.getParent();
  return b;
}

function textFields(block) {
  return block.inputList.flatMap((i) => i.fieldRow)
      .filter((f) => f instanceof Blockly.FieldTextInput && !(f instanceof Blockly.FieldNumber))
      .map((f) => String(f.getValue() ?? ''));
}

/** "stack A, block 4" -> "block 4 of stack A"; "inside block 3 of stack A" stays. */
const spokenPlace = (place) => place.replace(/^stack (\w+), block (\d+)$/, 'block $2 of stack $1');

/**
 * A single block the request names exactly: a text the program has, or a kind that appears once.
 * Null for anything less certain, or when the request asks a second question.
 * @returns {?{blockIds: !Array<string>, voiceLine: string}}
 */
export function findExact(ws, learnerSays, {stackLetters = null} = {}) {
  const sentences = String(learnerSays).split(/(?<=[.?!])\s+/).filter((s) => s.trim());
  if (sentences.length !== 1) return null;
  const request = ` ${norm(learnerSays)} `;
  const blocks = ws.getAllBlocks(false).filter((block) => !inQuestionSlot(block));
  const hits = new Map();

  for (const block of blocks) {
    for (const text of textFields(block)) {
      const value = norm(text);
      if ((value.match(/\p{L}/gu) || []).length < 2 || !request.includes(` ${value} `)) continue;
      const statement = statementOf(block);
      hits.set(statement.id, {block: statement, detail: statement.type === 'text_print' ? ` that says ${text}` : ` with the text ${text}`});
    }
  }
  const types = new Set(blocks.filter((b) => !b.isShadow()).map((b) => b.type));
  for (const type of types) {
    const names = [blockTypeName(type), ...(ALIASES[type] || [])].map(norm);
    const named = names.some((n) => new RegExp(`\\b${escape(n)}(?: (?:else|if))* (?:block|loop)s?\\b`).test(request));
    const ofType = blocks.filter((b) => b.type === type && !b.isShadow());
    if (named && ofType.length === 1 && !hits.has(ofType[0].id)) hits.set(ofType[0].id, {block: ofType[0], detail: ''});
  }
  if (hits.size !== 1) return null;
  const [{block, detail}] = hits.values();
  const place = spokenPlace(blockPositions(ws, stackLetters).get(block.id) || '');
  return {blockIds: [block.id], voiceLine: `The ${blockTypeName(block.type)} block${detail}, ${place}.`};
}

/**
 * @param {!Blockly.Workspace} ws
 * @param {{learnerSays?: string, stackLetters?: ?Map<string, string>}} options
 */
export function buildSearchRequest(ws, {learnerSays = '', stackLetters = null}) {
  const view = snapshot(ws, {stackLetters});
  return {call: {task: 'SEARCH', learnerText: learnerSays, input: {program: view.text}}, toReal: view.toReal, toShort: view.toShort};
}

/** Reply with view ids mapped to real ones; unknown ids stay so the check reports them. */
function readSearchReply(text, toReal) {
  const output = parseJsonReply(text);
  if (!output || typeof output !== 'object' || !Array.isArray(output.blocks)) return output;
  return {blockIds: output.blocks.map((id) => (toReal.has(id) ? toReal.get(id) : id)), voiceLine: output.voiceLine};
}

/** @returns {!Array<string>} */
export function checkSearchReply(ws, output, stackLetters = null) {
  if (!output || typeof output !== 'object') return ['the reply must be one JSON object'];
  if (!Array.isArray(output.blockIds)) return ['blocks must be a list of ids'];
  const problems = output.blockIds.filter((id) => !ws.getBlockById(id)).map((id) => `blocks has ${id}, which is not in the program`);
  if (typeof output.voiceLine !== 'string') return [...problems, 'voiceLine must be text'];
  return [...problems, ...speechProblems(output.voiceLine, ws, {stackLetters})];
}

/**
 * @param {!Blockly.Workspace} ws
 * @param {{client: !import('../model/agent_client.js').AgentClient, learnerSays?: string,
 *     stackLetters?: ?Map<string, string>, signal?: AbortSignal}} options
 * @returns {!Promise<{output: ?{blockIds: !Array<string>, voiceLine: string}, byCode: boolean, valid: boolean,
 *     repaired: boolean, problems: !Array<string>, firstProblems: !Array<string>, blocked?: {say: string, reason: string},
 *     error?: string}>}
 *     byCode: answered without a model call
 */
export async function runSearch(ws, options) {
  const exact = findExact(ws, options.learnerSays || '', options);
  if (exact) {
    return {output: exact, byCode: true, valid: true, repaired: false, problems: [], firstProblems: [], workspaceVersion: workspaceVersion(ws)};
  }
  const {call, toReal, toShort} = buildSearchRequest(ws, options);
  const {output, problems, repaired, firstProblems, blocked, error, workspaceVersion: version} = await askWithRepair(ws,
      options.client, call, (text) => readSearchReply(text, toReal), (o) => checkSearchReply(ws, o, options.stackLetters),
      toShort, options);
  return {output, byCode: false, valid: !problems.length, repaired, problems, firstProblems, blocked, error, workspaceVersion: version};
}
