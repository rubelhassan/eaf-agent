/**
 * Connection checker that layers custom block rules (from the block type registry)
 * on top of Blockly's standard type checks. It governs mouse drags and keyboard
 * connects alike, since both ask the workspace's connection checker.
 */

import * as Blockly from 'blockly/core';
import {blockTypes} from './registry.js';

export const CONNECTION_CHECKER_NAME = 'eaf-custom-rules';

let suspended = 0;

/**
 * Runs `fn` with custom rules switched off, e.g. while loading a saved program:
 * pedagogical rules constrain what learners do, not what a file may contain.
 * @template T
 * @param {function(): T} fn
 * @returns {T}
 */
export function withConnectionRulesSuspended(fn) {
  suspended++;
  try {
    return fn();
  } finally {
    suspended--;
  }
}

export class CustomRulesConnectionChecker extends Blockly.ConnectionChecker {
  /** @override */
  doTypeChecks(a, b) {
    if (!super.doTypeChecks(a, b)) return false;
    return suspended > 0 || blockTypes.allowsConnection(a, b);
  }
}

/** Registers the checker under CONNECTION_CHECKER_NAME. Idempotent. */
export function registerConnectionChecker() {
  Blockly.registry.register(
      Blockly.registry.Type.CONNECTION_CHECKER,
      CONNECTION_CHECKER_NAME,
      CustomRulesConnectionChecker,
      /* opt_allowOverrides= */ true,
  );
}
