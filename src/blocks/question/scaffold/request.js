/**
 * The scaffold's conversation with the agent: build a ScaffoldRequest, check the
 * ScaffoldResult against the spots and rules, and fall back to rule-picked spots
 * with template text when the agent is missing or its output doesn't hold up.
 */

import {AGENT_TIMEOUT_MS} from '../../../agent/services/contracts.js';
import {blockTypeName} from '../../block_names.js';
import {blockTypes} from '../../registry.js';
import {overlaps, rankSpots} from './spots.js';

const TEMPLATES = {
  value: {prompt: 'What value belongs here?', instruction: 'Work out what this part of the program needs.'},
  statement: {prompt: 'What should the program do here?', instruction: 'Add the step that belongs at this point.'},
  control: {prompt: 'How should the program repeat or decide here?', instruction: 'Choose the structure that controls these steps.'},
  sequence: {prompt: 'Which steps come next?', instruction: 'Add the steps in the right order.'},
};

/** Plain, speech-ready text: no markdown, code symbols, or emoji. */
function clean(text) {
  return String(text ?? '')
      .replace(/[*_`#>~]+/g, '')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
}

function programCode(workspace) {
  const generator = blockTypes.generator('javascript');
  if (!generator) return '';
  try {
    generator.init(workspace);
    return generator.workspaceToCode(workspace).trim();
  } catch (e) {
    return '';
  }
}

/**
 * @param {!Blockly.Workspace} workspace
 * @param {!Array<!Object>} spots  From findSpots, already limited to the level's kinds.
 * @param {{concept: string, level: string, gapCount: {min: number, max: number}}} plan
 * @returns {!import('../../../agent/services/contracts.js').ScaffoldRequest}
 */
export function buildScaffoldRequest(workspace, spots, plan) {
  return {
    program: programCode(workspace),
    // Most important first, so a simple agent still picks sensible spots.
    spots: rankSpots(spots, plan.concept).map((spot) => ({
      id: spot.id,
      kind: spot.kind,
      code: spot.code,
      concepts: spot.concepts,
      overlapsWith: spots.filter((other) => other !== spot && overlaps(spot, other)).map((other) => other.id),
    })),
    concept: plan.concept,
    level: plan.level,
    gapCount: plan.gapCount,
  };
}

/**
 * Checks the agent's result. Returns the gaps with their spots, or a reason the
 * agent can act on in a retry.
 * @returns {{ok: true, gaps: !Array<!Object>, concept: string} | {ok: false, reason: string}}
 */
export function checkScaffold(result, spots, gapCount) {
  const byId = new Map(spots.map((s) => [s.id, s]));
  const gaps = Array.isArray(result?.gaps) ? result.gaps : null;
  if (!gaps) return {ok: false, reason: 'Return {"concept": string, "gaps": [...]}.'};
  if (gaps.length < gapCount.min || gaps.length > gapCount.max) {
    return {ok: false, reason: `Choose between ${gapCount.min} and ${gapCount.max} gaps.`};
  }
  const chosen = [];
  for (const gap of gaps) {
    const spot = byId.get(gap?.spotId);
    if (!spot) return {ok: false, reason: `Unknown spotId ${gap?.spotId}; use only the given spots.`};
    if (chosen.some((c) => overlaps(c.spot, spot))) return {ok: false, reason: 'Gaps must not share or nest blocks.'};
    const prompt = clean(gap.prompt);
    const instruction = clean(gap.instruction);
    const hints = (Array.isArray(gap.hints) ? gap.hints : []).map(clean).filter(Boolean);
    if (!prompt || !instruction) return {ok: false, reason: 'Every gap needs a prompt and an instruction.'};
    const text = [prompt, instruction, ...hints].join(' ');
    if (/[{};=]|\(\s*\)/.test(text)) return {ok: false, reason: 'Use plain words, no code.'};
    const names = spot.blocks.map((b) => `${blockTypeName(b.type)} block`.toLowerCase());
    if (names.some((name) => text.toLowerCase().includes(name))) {
      return {ok: false, reason: 'Do not name the exact block that answers a gap.'};
    }
    chosen.push({spot, prompt, instruction, hints: hints.slice(0, 2)});
  }
  return {ok: true, gaps: chosen, concept: clean(result.concept) || 'auto'};
}

/**
 * Rule-picked gaps: the most important spots (rankSpots) that don't overlap,
 * in program order; template text and no written hints.
 */
export function fallbackScaffold(spots, plan) {
  const picked = [];
  for (const spot of rankSpots(spots, plan.concept)) {
    if (picked.length >= plan.gapCount.max) break;
    if (!picked.some((p) => overlaps(p, spot))) picked.push(spot);
  }
  const byOrder = (a, b) => spots.indexOf(a) - spots.indexOf(b);
  return picked.sort(byOrder).map((spot) => ({spot, ...TEMPLATES[spot.kind], hints: []}));
}

/**
 * Asks the agent (one retry with the reason), then falls back to the rules.
 * @returns {!Promise<{gaps: !Array<!Object>, concept: string, source: 'agent'|'rules'}>}
 */
export async function chooseGaps(workspace, spots, plan, agent) {
  if (typeof agent?.generateScaffold === 'function') {
    const request = buildScaffoldRequest(workspace, spots, plan);
    let retryReason;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
      try {
        const result = await agent.generateScaffold(retryReason ? {...request, retryReason} : request, {signal: controller.signal});
        const checked = checkScaffold(result, spots, plan.gapCount);
        if (checked.ok) return {gaps: checked.gaps, concept: checked.concept, source: 'agent'};
        retryReason = checked.reason;
      } catch (e) {
        break;
      } finally {
        clearTimeout(timer);
      }
    }
  }
  return {gaps: fallbackScaffold(spots, plan), concept: plan.concept, source: 'rules'};
}
