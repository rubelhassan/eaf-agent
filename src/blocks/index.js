/**
 * Custom blocks: public entry point.
 *
 * Host usage:
 *   const {connectionChecker} = registerCustomBlocks({   // before Blockly.inject
 *     generators: {javascript: javascriptGenerator, python: pythonGenerator},
 *   });
 *   const workspace = Blockly.inject(div, {plugins: {connectionChecker}, ...});
 *   attachCustomBlocks(workspace, {announce: (text) => speech.update(text)});
 */

import {blockTypes} from './registry.js';
import {CONNECTION_CHECKER_NAME, registerConnectionChecker} from './connection_checker.js';
import {questionBlockType} from './question/index.js';
import {attachDragGroupFix} from './drag_group_fix.js';

/** Built-in custom types, in registration order. */
const BUILT_IN_TYPES = [questionBlockType];

/**
 * Registers all custom block types with Blockly. Idempotent.
 * @param {{generators?: !Object<string, !Blockly.CodeGenerator>}=} options
 *     Code generators keyed by language (javascript, python, php, lua, dart).
 * @returns {{connectionChecker: string}} Name to pass as `plugins.connectionChecker` to Blockly.inject.
 */
export function registerCustomBlocks(options = {}) {
  for (const def of BUILT_IN_TYPES) {
    if (!blockTypes.has(def.type)) blockTypes.register(def);
  }
  blockTypes.defineAll();
  registerConnectionChecker();
  blockTypes.installGenerators(options.generators);
  return {connectionChecker: CONNECTION_CHECKER_NAME};
}

/**
 * Per-workspace setup for custom blocks (e.g. the question gap tracker and answer
 * badges). Call once after Blockly.inject.
 * @param {!Blockly.Workspace} workspace
 * @param {{announce?: function(string): void,
 *          agent?: import('../agent/services/contracts.js').AgentServices}=} options
 *     `announce` speaks to the learner (e.g. NavigationController's speech);
 *     `agent` generates AI hints and scaffolds (createFakeAgentServices() works without a model).
 * @returns {{dispose: function()}}
 */
export function attachCustomBlocks(workspace, options = {}) {
  const parts = [attachDragGroupFix(workspace), blockTypes.attachAll(workspace, options)];
  return {dispose: () => parts.forEach((p) => p.dispose())};
}

export {blockTypes, BlockTypeRegistry, GENERATOR_LANGUAGES} from './registry.js';
export {CONNECTION_CHECKER_NAME, withConnectionRulesSuspended} from './connection_checker.js';
export {Activity, LearnerLevel, getPolicy, setPolicy, onPolicyChange} from './policy.js';
export {blockTypeName} from './block_names.js';
export * as QuestionBlock from './question/index.js';
