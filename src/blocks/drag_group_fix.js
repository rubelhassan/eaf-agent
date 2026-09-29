/**
 * Workarounds for Blockly 11.2 undo grouping, so one learner action (and the gap
 * tracker's follow-up changes) is one undo step:
 *
 * 1. Taking a block from the flyout (mouse drag or keyboard insert) leaves an
 *    event group open (Flyout.createBlock opens it; nothing closes it), so every
 *    later action lands in the same group. Once an action has settled and no
 *    gesture is in progress, a group still open is closed.
 * 2. On drop, Blockly closes the drag's group and then synchronously fires the
 *    grid-snap (and bump) moves without a group, splitting the drop across undo
 *    steps. Those moves join the drop's group.
 *
 * Re-check on Blockly upgrades; remove once fixed upstream.
 */

import * as Blockly from 'blockly/core';

/**
 * @param {!Blockly.Workspace} workspace
 * @returns {{dispose: function()}}
 */
export function attachDragGroupFix(workspace) {
  if (!workspace.rendered) return {dispose() {}};
  /** Group of the drop being processed in this tick, if any. */
  let dropGroup = null;

  /** Closes `group` if it is still open once rendering and follow-up work settled. */
  const closeWhenSettled = (group) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
      const gestureInProgress = Blockly.Gesture?.inProgress?.();
      if (!gestureInProgress && Blockly.Events.getGroup() === group) Blockly.Events.setGroup(false);
    }, 0)));
  };

  const listener = (event) => {
    if (event.type === Blockly.Events.BLOCK_DRAG && !event.isStart && event.group) {
      dropGroup = event.group;
      setTimeout(() => {
        dropGroup = null;
      }, 0);
      closeWhenSettled(event.group);
      return;
    }
    const followUp = event.type === Blockly.Events.BLOCK_MOVE &&
      (event.reason || []).some((r) => r === 'snap' || r === 'bump');
    if (followUp && !event.group && dropGroup) event.group = dropGroup;
    if (!event.isUiEvent && event.group) closeWhenSettled(event.group);
  };
  workspace.addChangeListener(listener);
  return {dispose: () => workspace.removeChangeListener(listener)};
}
