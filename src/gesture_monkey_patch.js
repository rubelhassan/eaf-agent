/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Overrides methods on Blockly.Gesture in order to allow users
 * to move the cursor to blocks or the workspace using shift click.
 * TODO(google/blockly#4584): We do not have a way to do this currently without
 * monkey patching Blockly.
 * @author aschmiedt@google.com (Abby Schmiedt)
 */

import * as Blockly from 'blockly/core';

const oldDoWorkspaceClick = Blockly.Gesture.prototype.doWorkspaceClick;

/**
 * Execute a workspace click: move the cursor to the clicked workspace coordinate.
 * @param {!Event} e A mouse up or touch end event.
 * @this {Blockly.Gesture}
 * @override
 */
Blockly.Gesture.prototype.doWorkspaceClick = function(e) {
  oldDoWorkspaceClick.call(this, e);

  const ws = this.creatorWorkspace;
  const cursor = ws?.getCursor?.();
  if (!ws || !cursor) return;

  e = e || this.mostRecentEvent;
  const screenCoord = new Blockly.utils.Coordinate(e.clientX, e.clientY);
  ws.updateScreenCalculationsIfScrolled?.();
  const wsCoord = Blockly.utils.svgMath.screenToWsCoordinates(ws, screenCoord);
  cursor.suppressNextScroll?.();
  const wsNode = Blockly.ASTNode.createWorkspaceNode(ws, wsCoord);
  cursor.setCurNode(wsNode);
};

const oldDoBlockClick = Blockly.Gesture.prototype.doBlockClick;

/**
 * Execute a block click: move the cursor to the clicked block.
 * @this {Blockly.Gesture}
 * @override
 */
Blockly.Gesture.prototype.doBlockClick = function() {
  oldDoBlockClick.call(this);

  const ws = this.creatorWorkspace;
  const block = this.targetBlock;
  const cursor = ws?.getCursor?.();
  if (!ws || !cursor || !block) return;

  if (this.flyout) return;

  cursor.suppressNextScroll?.();
  cursor.setCurNode(Blockly.ASTNode.createBlockNode(block));
};
