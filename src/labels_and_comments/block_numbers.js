/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Implements per-stack block numbering in Blockly.
 * Each visually separate stack numbers all blocks sequentially starting at 1.
 */

import * as Blockly from 'blockly/core';

/**
 * Class for managing block numbers within each stack.
 * Every stack's blocks are numbered sequentially starting at 1.
 */
export class BlockNumberManager {
  /**
   * Constructor for the BlockNumberManager.
   * @param {!Blockly.WorkspaceSvg} workspace The workspace to manage block numbers for.
   */
  constructor(workspace) {
    /**
     * The workspace this manager is associated with.
     * @type {!Blockly.WorkspaceSvg}
     * @private
     */
    this.workspace_ = workspace;
    
    /**
     * Map of block IDs to their number badges.
     * @type {!Map<string, SVGElement>}
     * @private
     */
    this.numberBadges_ = new Map();
    
    /**
     * Map of block IDs to their numbers within their stack.
     * @type {!Map<string, number>}
     * @private
     */
    this.blockNumbers_ = new Map();
    
    /**
     * Whether the manager is currently enabled.
     * @type {boolean}
     * @private
     */
    this.enabled_ = false;

    /**
     * Bound event handlers for workspace events.
     * @type {!Array<function(!Blockly.Events.Abstract)>}
     * @private
     */
    this.boundEvents_ = [];
  }

  /**
   * Initialize the block number manager.
   */
  init() {
    if (this.enabled_) return;
    this.enabled_ = true;
    
    // Bind event handlers
    this.bindWorkspaceEvents_();
    
    // Initialize existing blocks
    this.updateAllBlockNumbers_();
  }

  /**
   * Clean up the block number manager.
   */
  dispose() {
    if (!this.enabled_) return;
    this.enabled_ = false;
    
    // Unbind event handlers
    this.unbindWorkspaceEvents_();
    
    // Remove all badges
    this.removeAllBadges_();
    
    // Clear maps
    this.numberBadges_.clear();
    this.blockNumbers_.clear();
  }

  /**
   * Bind workspace events for updating block numbers.
   * @private
   */
  bindWorkspaceEvents_() {
    // Handler for block create, delete, move, change events
    const onBlockEvent = this.onBlockEvent_.bind(this);
    
    // Listen for block events
    this.workspace_.addChangeListener(onBlockEvent);
    
    // Store bound event handlers for cleanup
    this.boundEvents_.push(onBlockEvent);
  }

  /**
   * Unbind workspace events.
   * @private
   */
  unbindWorkspaceEvents_() {
    for (const handler of this.boundEvents_) {
      this.workspace_.removeChangeListener(handler);
    }
    this.boundEvents_.length = 0;
  }

  /**
   * Handle workspace events to update block numbers.
   * @param {!Blockly.Events.Abstract} event The workspace event.
   * @private
   */
  onBlockEvent_(event) {
    // Only process events on our workspace
    if (!event.workspaceId || event.workspaceId !== this.workspace_.id) return;
    
    if (event.type === Blockly.Events.BLOCK_CREATE ||
        event.type === Blockly.Events.BLOCK_DELETE ||
        event.type === Blockly.Events.BLOCK_MOVE ||
        event.type === Blockly.Events.BLOCK_CHANGE) {
      // Use a timeout to ensure all events in this cycle are processed
      setTimeout(() => {
        // Only update if workspace still exists
        if (this.enabled_ && this.workspace_) {
          this.updateAllBlockNumbers_();
        }
      }, 0);
    }
  }

  /**
   * Update numbers for all blocks in the workspace.
   * @private
   */
  updateAllBlockNumbers_() {
    if (!this.workspace_ || !this.enabled_) return;
    
    try {
      // Remove all existing badges
      this.removeAllBadges_();
      this.blockNumbers_.clear();
      
      // Get all top-level blocks - these are the starting points for stacks
      const topBlocks = this.workspace_.getTopBlocks(true);
      if (!topBlocks) return;
      
      // Process each stack starting from the top block
      for (const topBlock of topBlocks) {
        // Skip blocks that aren't valid or aren't rendered
        if (!topBlock || !topBlock.rendered) continue;
        
        // Skip blocks being dragged if the method exists
        if (typeof topBlock.isDragging === 'function' && topBlock.isDragging()) continue;
        
        // Number this stack starting from 1
        this.numberStackFromBlock_(topBlock, 1);
      }
    } catch (e) {
      console.error('Error updating block numbers:', e);
    }
  }
  
  /**
   * Recursively number a block and all blocks connected below it.
   * @param {!Blockly.BlockSvg} block The starting block.
   * @param {number} startNumber The number to start with.
   * @returns {number} The next number to use.
   * @private
   */
  numberStackFromBlock_(block, startNumber) {
    if (!block || !block.rendered) return startNumber;
    
    let currentNumber = startNumber;
    
    // Add badge to this block
    this.addBadge_(block, currentNumber);
    
    // Store the block number
    this.blockNumbers_.set(block.id, currentNumber);
    
    // Increment for the next block
    currentNumber++;
    
    // Get the next block in sequence (connected to the bottom)
    const nextBlock = this.getNextBlockInStack_(block);
    
    // If there's a next block, continue numbering
    if (nextBlock) {
      currentNumber = this.numberStackFromBlock_(nextBlock, currentNumber);
    }
    
    return currentNumber;
  }
  
  /**
   * Get the next block in a stack (the one connected to the output or next connection).
   * @param {!Blockly.BlockSvg} block The block to get the next block from.
   * @return {Blockly.BlockSvg|null} The next block or null.
   * @private
   */
  getNextBlockInStack_(block) {
    if (!block) return null;
    
    // Check if this block has a next connection with a block attached
    if (block.nextConnection && block.nextConnection.isConnected()) {
      return block.nextConnection.targetBlock();
    }
    
    return null;
  }

  /**
   * Add a number badge to a block.
   * @param {!Blockly.BlockSvg} block The block to add a badge to.
   * @param {number} number The number to display on the badge.
   * @private
   */
  addBadge_(block, number) {
    // Remove any existing badge
    this.removeBadge_(block.id);
    
    // Create the badge
    const badge = this.createBadge_(number);
    
    // Position the badge in top-right corner
    try {
      const blockSvg = block.getSvgRoot();
      if (blockSvg) {
        blockSvg.appendChild(badge);
        
        // Store the badge for later removal
        this.numberBadges_.set(block.id, badge);
        
        // Set ARIA attributes for screen readers
        this.addAccessibility_(block, number);
      }
    } catch (e) {
      console.warn('Could not add badge to block', e);
    }
  }

  /**
   * Create an SVG badge with a number.
   * @param {number} number The number to display on the badge.
   * @return {!SVGElement} The badge element.
   * @private
   */
  createBadge_(number) {
    const NS = Blockly.utils.dom.SVG_NS;
    
    // Create a group to hold the badge
    const g = document.createElementNS(NS, 'g');
    g.classList.add('blockly-block-badge');
    
    // Create the badge circle
    const circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('cx', '8');
    circle.setAttribute('cy', '8');
    circle.setAttribute('r', '8');
    circle.setAttribute('fill', '#5c6bc0');
    g.appendChild(circle);
    
    // Create the text label
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', '8');
    text.setAttribute('y', '12');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', '10');
    text.setAttribute('font-weight', 'bold');
    text.setAttribute('fill', 'white');
    text.textContent = number.toString();
    g.appendChild(text);
    
    // Position the badge with distance from block (similar to red border spacing)
    g.setAttribute('transform', 'translate(-24, 0)');
    
    return g;
  }

  /**
   * Add accessibility attributes to the block.
   * @param {!Blockly.BlockSvg} block The block to add accessibility to.
   * @param {number} number The block number within its stack.
   * @private
   */
  addAccessibility_(block, number) {
    try {
      // Get the block's text
      const blockText = typeof block.toString === 'function' ? 
          block.toString(undefined, ' ').trim() : 'Block';
          
      // Create the ARIA label with the block number
      const ariaLabel = `Block ${number}: ${blockText}`;
      
      // Set the ARIA label on the block's SVG group
      const svgRoot = block.getSvgRoot();
      if (svgRoot) {
        svgRoot.setAttribute('aria-label', ariaLabel);
      }
    } catch (e) {
      // Fail quietly if can't set ARIA label
      console.warn('Could not set ARIA label for block number', e);
    }
  }

  /**
   * Remove a badge from a block.
   * @param {string} blockId The ID of the block to remove a badge from.
   * @private
   */
  removeBadge_(blockId) {
    const badge = this.numberBadges_.get(blockId);
    if (badge && badge.parentNode) {
      badge.parentNode.removeChild(badge);
    }
    this.numberBadges_.delete(blockId);
  }

  /**
   * Remove all badges from the workspace.
   * @private
   */
  removeAllBadges_() {
    for (const [blockId, badge] of this.numberBadges_.entries()) {
      if (badge && badge.parentNode) {
        badge.parentNode.removeChild(badge);
      }
    }
    this.numberBadges_.clear();
  }

  /**
   * Get the block number for a block.
   * @param {string} blockId The ID of the block.
   * @return {number|undefined} The block number or undefined if not found.
   */
  getBlockNumber(blockId) {
    return this.blockNumbers_.get(blockId);
  }

  /**
   * Update the block numbers when a workspace event occurs.
   * Public method that can be called externally.
   */
  update() {
    this.updateAllBlockNumbers_();
  }
}

/**
 * Singleton instance of the BlockNumberManager.
 * @type {BlockNumberManager}
 */
let blockNumberManagerInstance = null;

/**
 * Initialize block numbers for a workspace.
 * @param {!Blockly.WorkspaceSvg} workspace The workspace to initialize numbers on.
 * @return {!BlockNumberManager} The block number manager instance.
 */
export function initBlockNumbers(workspace) {
  if (!blockNumberManagerInstance) {
    blockNumberManagerInstance = new BlockNumberManager(workspace);
    blockNumberManagerInstance.init();
  }
  return blockNumberManagerInstance;
}

/**
 * @return {?BlockNumberManager} The block number manager, or null before init.
 */
export function getBlockNumberManager() {
  return blockNumberManagerInstance;
}

/**
 * Dispose of the block number manager.
 */
export function disposeBlockNumbers() {
  if (blockNumberManagerInstance) {
    blockNumberManagerInstance.dispose();
    blockNumberManagerInstance = null;
  }
}
