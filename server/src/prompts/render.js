// Turns an agent call into the model request: system prompt, user message, inference settings.

import {DEFAULT_PROMPT_VERSIONS, getPrompt} from './index.js';
import {inferenceFor} from '../models/settings.js';

const said = (c) => JSON.stringify(c.learnerText ?? '');
const soFar = (c) => (c.input.taskContext ? `\n\nTask so far:\n${c.input.taskContext}` : '');

function hintLines(input) {
  const earlier = input.earlierHints?.length ? input.earlierHints.map((h, i) => `${i + 1}. ${h}`).join(' ') : 'none';
  const lines = [
    `Level: ${input.level}. ${input.levelRule}`,
    `Learner level: ${input.learnerLevel}`,
    `Question: ${JSON.stringify(input.question || '')}; instruction: ${JSON.stringify(input.instruction || '')}; ` +
      `needs ${input.needs}; the teacher intends: ${input.intended?.join(', ') || 'any'}`,
    `Earlier hints: ${earlier}`,
  ];
  if (input.teacherNote) lines.push(`Teacher note: ${input.teacherNote}`);
  return lines.join('\n');
}

// One user template per task; every prompt version of a task uses it so far.
const TEMPLATES = {
  INTENT: (c) => [`Learner said: ${said(c)}`, `At the cursor: ${c.input.atCursor}`,
    ...(c.input.taskContext ? ['Task:', c.input.taskContext] : []),
    ...(c.input.answers?.length ? ['Answers they can give now:', ...c.input.answers.map((a) => `- ${a}`)] : [])].join('\n'),
  COMPREHEND: (c) => `Learner asked: ${said(c)}\nScope: ${c.input.scope}\nWord limit: ${c.input.wordLimit}`,
  COMPREHEND_PROPOSAL: (c) => `Learner asked: ${said(c)}\nWord limit: ${c.input.wordLimit}\nTask:\n${c.input.taskContext}`,
  // A revision or an answer to a question asked back also gets the task so far; a new request is unchanged.
  DEBUG: (c) => `Learner said: ${said(c)}${soFar(c)}`,
  EDIT_GUIDE: (c) => `Instruction: ${said(c)}${soFar(c)}`,
  SEARCH: (c) => `Learner asked: ${said(c)}`,
  HINT: (c) => hintLines(c.input),
};

/**
 * @param {!import('./agent_client.js').AgentCall} call
 * @param {{model: string, version?: string, overrides?: ?Object}} options  overrides: inference settings, e.g. reasoningEffort
 * @returns {{payload: !Object, version: string}}
 */
export function renderRequest(call, {model, version, overrides = null}) {
  const template = TEMPLATES[call.task];
  if (!template) throw new Error(`No template for ${call.task}`);
  const v = version || DEFAULT_PROMPT_VERSIONS[call.task];
  return {
    version: v,
    payload: {
      model,
      ...inferenceFor(call.task, {model, ...overrides}),
      messages: [
        {role: 'system', content: getPrompt(call.task, v)},
        {role: 'user', content: `${template(call)}\n\nProgram:\n${call.input.program}`},
      ],
    },
  };
}

/** The repair round: the first request, the model's reply, and what was wrong with it. */
export function renderRepair(payload, replyText, problems) {
  return {
    ...payload,
    messages: [
      ...payload.messages,
      {role: 'assistant', content: replyText || ''},
      {role: 'user', content: `Your reply can't be used:\n- ${problems.join('\n- ')}\nReply again with the whole JSON object.`},
    ],
  };
}
