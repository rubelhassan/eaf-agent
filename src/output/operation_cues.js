// @ts-check
// The connected cue from workspace events: a block got a new parent (keyboard insert, paste, drag, undo).

import * as Blockly from 'blockly/core';

/**
 * @param {!Blockly.Workspace} workspace
 * @param {{cue: function(string): void}} output
 * @returns {function(): void} stops listening
 */
export function watchOperationCues(workspace, output) {
  const listener = (e) => {
    if (e.type === Blockly.Events.BLOCK_MOVE && e.newParentId && e.newParentId !== e.oldParentId) output.cue('connected');
  };
  workspace.addChangeListener(listener);
  return () => workspace.removeChangeListener(listener);
}
