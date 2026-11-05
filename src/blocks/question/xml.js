/**
 * Readable XML form of the question configuration, used as the block's <mutation>.
 * Blockly's XML serializer only supports mutationToDom/domToMutation, and task
 * files are XML that teachers may edit by hand, so each field gets its own element:
 *
 *   <mutation expects="sequence" min_blocks="2" need="">
 *     <intended type="text_print"/>
 *     <prompt>Greet the user twice</prompt>
 *     <instruction>Use print blocks.</instruction>
 *     <hint>Which block shows text?</hint>
 *     <ai level="point" count="2" quiz="false">Focus on the greeting</ai>
 *     <reference><block type="text_print">…</block></reference>
 *   </mutation>
 */

import * as Blockly from 'blockly/core';
import {normalizeConfig} from './model.js';

/**
 * @param {!import('./model.js').QuestionConfig} config
 * @returns {!Element}
 */
export function configToDom(config) {
  const create = (tag, textContent) => {
    const element = Blockly.utils.xml.createElement(tag);
    if (textContent !== undefined) element.appendChild(Blockly.utils.xml.createTextNode(textContent));
    return element;
  };

  const mutation = create('mutation');
  mutation.setAttribute('expects', config.expects);
  mutation.setAttribute('min_blocks', String(config.minBlocks));
  if (config.needLabel) mutation.setAttribute('need', config.needLabel);
  if (!config.offerChoices) mutation.setAttribute('choices', 'false');

  for (const type of config.intendedTypes) {
    const intended = create('intended');
    intended.setAttribute('type', type);
    mutation.appendChild(intended);
  }
  if (config.prompt) mutation.appendChild(create('prompt', config.prompt));
  if (config.instruction) mutation.appendChild(create('instruction', config.instruction));
  for (const hint of config.hints) mutation.appendChild(create('hint', hint));

  if (config.ai.level !== 'off') {
    const ai = create('ai', config.ai.note || undefined);
    ai.setAttribute('level', config.ai.level);
    ai.setAttribute('count', String(config.ai.count));
    ai.setAttribute('quiz', String(config.ai.allowInQuiz));
    mutation.appendChild(ai);
  }
  const block = config.reference && referenceToDom(config.reference);
  if (block) {
    const reference = create('reference');
    reference.appendChild(block);
    mutation.appendChild(reference);
  }
  return mutation;
}

/**
 * @param {!Element} mutation
 * @returns {!import('./model.js').QuestionConfig}
 */
export function configFromDom(mutation) {
  const children = (parent, tag) => [...parent.childNodes].filter((n) => n.nodeName?.toLowerCase() === tag);
  const texts = (parent, tag) => children(parent, tag).map((n) => n.textContent);
  const [ai] = children(mutation, 'ai');
  const [reference] = children(mutation, 'reference');
  const referenceBlock = reference && children(reference, 'block')[0];

  return normalizeConfig({
    expects: mutation.getAttribute('expects'),
    minBlocks: mutation.getAttribute('min_blocks'),
    needLabel: mutation.getAttribute('need'),
    offerChoices: mutation.getAttribute('choices') !== 'false',
    intendedTypes: children(mutation, 'intended').map((n) => n.getAttribute('type')),
    prompt: texts(mutation, 'prompt')[0],
    instruction: texts(mutation, 'instruction')[0],
    hints: texts(mutation, 'hint'),
    ai: ai ? {
      level: ai.getAttribute('level'),
      count: ai.getAttribute('count'),
      note: ai.textContent,
      allowInQuiz: ai.getAttribute('quiz') === 'true',
    } : undefined,
    reference: referenceBlock ? referenceFromDom(referenceBlock) : null,
  });
}

/** Converts through a scratch workspace; Blockly has no direct JSON ↔ XML for blocks. */
function referenceToDom(reference) {
  const scratch = new Blockly.Workspace();
  try {
    return Blockly.Xml.blockToDom(Blockly.serialization.blocks.append(reference, scratch, {recordUndo: false}));
  } catch (e) {
    return null;
  } finally {
    scratch.dispose();
  }
}

function referenceFromDom(blockElement) {
  const scratch = new Blockly.Workspace();
  try {
    return Blockly.serialization.blocks.save(Blockly.Xml.domToBlock(blockElement, scratch), {addCoordinates: false});
  } catch (e) {
    return null;
  } finally {
    scratch.dispose();
  }
}
