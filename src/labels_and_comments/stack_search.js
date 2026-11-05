/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Implements stack search functionality in Blockly.
 * Allows users to quickly navigate to stacks by their alphabetical labels.
 * Activated with Alt+Shift+G (safe for screen readers).
 */

import * as Blockly from 'blockly/core';
import { getStackLabelManager } from './stack_labels.js';
import {getOutputManager} from '../output/active.js';
import {sayDialog, speakDialogFocus} from '../util/dialog_speech.js';
import {stackName} from './stack_name.js';

// Global registry to track all StackSearchManager instances by workspace ID
const stackSearchManagerRegistry = new Map();

/**
 * Get a StackSearchManager instance for a specific workspace.
 * @param {!Blockly.WorkspaceSvg} workspace The workspace to get the manager for.
 * @return {StackSearchManager|null} The manager for the workspace, or null if none exists.
 */
export function getStackSearchManager(workspace) {
  if (!workspace || !workspace.id) return null;
  return stackSearchManagerRegistry.get(workspace.id) || null;
}

/**
 * Class for managing stack search functionality.
 * Allows quick navigation to stacks by their alphabetical labels.
 */
export class StackSearchManager {
  /**
   * Constructor for the StackSearchManager.
   * @param {!Blockly.WorkspaceSvg} workspace The workspace to manage stack search for.
   */
  constructor(workspace, speech) {
    /**
     * The workspace this manager is associated with.
     * @type {!Blockly.WorkspaceSvg}
     * @private
     */
    this.workspace_ = workspace;

    // Register this instance in the global registry
    if (workspace && workspace.id) {
      stackSearchManagerRegistry.set(workspace.id, this);
    }

    this.speech = speech;
    /**
     * Whether the manager is currently enabled.
     * @type {boolean}
     * @private
     */
    this.enabled_ = false;

    /**
     * The currently active search overlay, if any.
     * @type {HTMLElement|null}
     * @private
     */
    this.activeOverlay_ = null;

    /**
     * Whether search mode is currently active.
     * @type {boolean}
     * @private
     */
    this.searchActive_ = false;

    /**
     * Current search query text.
     * @type {string}
     * @private
     */
    this.searchQuery_ = '';

    /**
     * Current active panel: 'stacks' or 'blocks'
     * @type {string}
     * @private
     */
    this.activePanel_ = 'stacks';

    /**
     * Current selection index in blocks panel.
     * @type {number}
     * @private
     */
    this.blockSelectionIndex_ = 0;

    /**
     * Available blocks for currently selected stack.
     * @type {!Array<{number: number, blockId: string, description: string}>}
     * @private
     */
    this.availableBlocks_ = [];

    /**
     * Bound event handlers for cleanup.
     * @type {!Array<function()>}
     * @private
     */
    this.boundEventHandlers_ = [];
  }

  /**
   * Initialize the stack search manager.
   */
  init() {
    if (this.enabled_) return;

    this.enabled_ = true;
    console.log('Stack search: Initialized for workspace', this.workspace_.id);
  }

  findStackByLetter(workspace, letter) {
    if (!workspace || !letter) return null;

    const stackLabelManager = getStackLabelManager(workspace);
    if (!stackLabelManager) return null;

    const L = String(letter).toUpperCase();

    // Current implementation relies on stackLetters_ Map<blockId, letter>
    if (!stackLabelManager.stackLetters_) return null;

    let targetBlockId = null;
    for (const [blockId, stackLetter] of stackLabelManager.stackLetters_.entries()) {
      if (String(stackLetter).toUpperCase() === L) {
        targetBlockId = blockId;
        break;
      }
    }

    if (!targetBlockId) return null;

    const block = workspace.getBlockById(targetBlockId);
    if (!block) return null;

    const customText = stackName(block);
    const label = customText ? `${L} with custom label ${customText}` : L;

    return { block, blockId: targetBlockId, letter: L, customText, label };
  }

  /**
   * Handle the stack search shortcut activation.
   * @param {!Blockly.WorkspaceSvg} workspace The workspace to search in.
   * @return {boolean} True if the shortcut was handled.
   */
  handleStackSearchShortcut_(workspace) {
    console.log('Stack search: Shortcut activated');

    if (!workspace) return false;

    // If search is already active, cancel it
    if (this.searchActive_) {
      this.cancelSearch_();
      return true;
    }

    // Get available stacks from stack label manager
    const stackLabelManager = getStackLabelManager(workspace);
    if (!stackLabelManager) {
      console.log('Stack search: No stack label manager found');
      return false;
    }

    // Get all available stack letters
    const availableStacks = this.getAvailableStacks_(stackLabelManager);

    if (availableStacks.length === 0) {
      this.announceMessage_('No labeled stacks available to search');
      return false;
    }

    // Start search mode
    this.startSearchMode_(availableStacks);
    return true;
  }

  /**
   * Get all available stack letters from the stack label manager.
   * @param {!StackLabelManager} stackLabelManager The stack label manager.
   * @return {!Array<{letter: string, blockId: string, label: string}>} Available stacks.
   * @private
   */
  getAvailableStacks_(stackLabelManager) {
    const stacks = [];

    try {
      // Access the internal stackLetters_ map to get all labeled stacks
      if (stackLabelManager.stackLetters_) {
        for (const [blockId, letter] of stackLabelManager.stackLetters_.entries()) {
          // Get the block to ensure it still exists
          const block = this.workspace_.getBlockById(blockId);
          if (block) {
            // Find the actual top block of this stack (in case blocks were added above)
            let topBlock = block;
            while (topBlock.previousConnection && topBlock.previousConnection.isConnected()) {
              topBlock = topBlock.previousConnection.targetBlock();
            }

            const customText = stackName(topBlock);
            const fullLabel = customText ? `${letter} ${customText}` : letter;

            stacks.push({
              letter: letter,
              blockId: topBlock.id, // Use the actual top block ID
              label: fullLabel
            });
          }
        }
      }
    } catch (e) {
      console.warn('Stack search: Error getting available stacks', e);
    }

    // Sort by letter for consistent ordering
    stacks.sort((a, b) => a.letter.localeCompare(b.letter));

    return stacks;
  }

  /**
   * Start search mode and show available stacks.
   * @param {!Array<{letter: string, blockId: string, label: string}>} availableStacks Available stacks.
   * @private
   */
  startSearchMode_(availableStacks) {
    this.searchActive_ = true;

    // Create search overlay
    this.createSearchOverlay_(availableStacks);

    // Bind keyboard handlers for search
    this.bindSearchKeyHandlers_();

    // Announce to screen readers
    const stackList = availableStacks.map(s => s.label).join('.  ');
    this.announceMessage_(`Stack search active. ${availableStacks.length} stacks are available.  Press WASD to navigate, or Escape to close.`);
  }

  /**
   * Create and show the search overlay.
   * @param {!Array<{letter: string, blockId: string, label: string}>} availableStacks Available stacks.
   * @private
   */
  createSearchOverlay_(availableStacks) {
    // Remove any existing overlay
    this.removeSearchOverlay_();

    // Store available stacks and initialize selection
    this.allAvailableStacks_ = availableStacks;
    this.availableStacks_ = availableStacks;
    this.currentSelectionIndex_ = 0;
    this.blockSelectionIndex_ = 0;
    this.activePanel_ = 'stacks';
    this.searchQuery_ = '';

    // Create overlay element
    const overlay = document.createElement('div');
    overlay.className = 'blockly-stack-search-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Stack Search');
    // Results are announced explicitly; making the whole dialog live repeats every list update.
    overlay.setAttribute('aria-live', 'off');

    // Create content
    const content = document.createElement('div');
    content.className = 'blockly-stack-search-content';

    const title = document.createElement('div');
    title.className = 'blockly-stack-search-title';
    title.textContent = 'Navigate to Stack';

    const instructions = document.createElement('div');
    instructions.className = 'blockly-stack-search-instructions';
    instructions.textContent = 'W/S: navigate | A/D: switch panels | /: toggle search bar | Enter: select';

    // Create search input
    const searchInputContainer = document.createElement('div');
    searchInputContainer.className = 'blockly-stack-search-input-container';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search stacks... (Press / to focus) (e.g., "App" for "B Apple")';
    searchInput.className = 'blockly-stack-search-input';
    searchInput.setAttribute('aria-label', 'Search stacks by name');
    searchInput.setAttribute('tabindex', '-1'); // Prevent default tab focus
    searchInput.addEventListener('focus', () => {
      speakDialogFocus(searchInput);
    });
    searchInputContainer.appendChild(searchInput);

    // Create dual-panel container
    const panelContainer = document.createElement('div');
    panelContainer.className = 'blockly-stack-search-panels';

    // Left panel - Stack list
    const stackPanel = document.createElement('div');
    stackPanel.className = 'blockly-stack-search-panel stack-panel active';

    const stackPanelTitle = document.createElement('div');
    stackPanelTitle.className = 'panel-title';
    stackPanelTitle.textContent = 'Stacks';
    stackPanel.appendChild(stackPanelTitle);

    const stackList = document.createElement('div');
    stackList.className = 'blockly-stack-search-list stack-results';

    // Right panel - Block list
    const blockPanel = document.createElement('div');
    blockPanel.className = 'blockly-stack-search-panel block-panel';

    const blockPanelTitle = document.createElement('div');
    blockPanelTitle.className = 'panel-title';
    blockPanelTitle.textContent = 'Blocks';
    blockPanel.appendChild(blockPanelTitle);

    const blockList = document.createElement('div');
    blockList.className = 'blockly-stack-search-list block-results';

    blockPanel.appendChild(blockList);
    stackPanel.appendChild(stackList);

    panelContainer.appendChild(stackPanel);
    panelContainer.appendChild(blockPanel);

    const cancelInstructions = document.createElement('div');
    cancelInstructions.className = 'blockly-stack-search-cancel';
    cancelInstructions.textContent = 'Press Escape to cancel';

    content.appendChild(title);
    content.appendChild(instructions);
    content.appendChild(searchInputContainer);
    content.appendChild(panelContainer);
    content.appendChild(cancelInstructions);
    overlay.appendChild(content);

    // Set up search input event listener
    searchInput.addEventListener('input', (e) => {
      // Remove any "/" characters that might have slipped through
      let value = e.target.value;
      if (value.includes('/')) {
        value = value.replace(/\//g, '');
        e.target.value = value;
      }
      this.handleSearchInput_(value);
    });

    // Add multiple event listeners to completely prevent "/" from being typed
    const preventSlash = (e) => {
      if (e.key === '/' || e.data === '/') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return false;
      }
    };
    
    searchInput.addEventListener('keydown', preventSlash, true);
    searchInput.addEventListener('keypress', preventSlash, true);
    searchInput.addEventListener('beforeinput', preventSlash, true);
    searchInput.addEventListener('textInput', preventSlash, true);

    // Add to document
    document.body.appendChild(overlay);
    this.activeOverlay_ = overlay;

    // Initialize the display
    this.updateStackList_();
    this.updateBlockList_();

    // Don't auto-focus search input - let users choose navigation method
    // Focus the overlay for accessibility, but allow W/S navigation by default
    overlay.setAttribute('tabindex', '0');
    overlay.focus();
  }

  /**
   * Bind keyboard event handlers for search mode.
   * @private
   */
  bindSearchKeyHandlers_() {
    console.log('Stack search: Binding keyboard handlers');
    const keyHandler = (event) => {
      if (!this.searchActive_) return;

      console.log('Stack search: Key pressed:', event.key);
      const key = event.key.toUpperCase();

      // Check if user is actively typing in the search input
      const isTypingInInput = event.target && event.target.classList.contains('blockly-stack-search-input');

      // Handle Escape to cancel search (works from anywhere)
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.cancelSearch_();
        return;
      }

      // Handle "/" key to toggle between search input and stacks panel
      if (event.key === '/') {
        console.log('Stack search: "/" key pressed, isTypingInInput:', isTypingInInput);
        event.preventDefault();
        event.stopPropagation();
        const searchInput = this.activeOverlay_?.querySelector('.blockly-stack-search-input');
        
        if (isTypingInInput) {
          // Currently in search input, move back to stacks panel
          console.log('Stack search: Moving focus from search input to stacks panel');
          searchInput.blur(); // Remove focus from input
          this.activeOverlay_?.focus();
          this.activePanel_ = 'stacks';
          this.updateSelectionHighlight_();
          this.announceMessage_('Focus moved to stacks panel. Use W/S to navigate.');
        } else {
          // Currently in stacks/blocks panel, move to search input
          console.log('Stack search: Moving focus from panel to search input');
          if (searchInput) {
            searchInput.focus();
          }
        }
        return;
      }

      // Handle W key (up navigation) - works even when typing in search input
      if (key === 'W') {
        event.preventDefault();
        event.stopPropagation();
        this.moveSelection_(-1);
        return;
      }

      // Handle S key (down navigation) - works even when typing in search input
      if (key === 'S') {
        event.preventDefault();
        event.stopPropagation();
        this.moveSelection_(1);
        return;
      }

      // Handle A key (switch to left panel - stacks) - only when not typing and not on stacks already
      if (key === 'A' && !isTypingInInput && this.activePanel_ === 'blocks') {
        event.preventDefault();
        event.stopPropagation();
        this.switchToPanel_('stacks');
        return;
      }

      // Handle D key (switch to right panel - blocks) - only when not typing and on stacks panel
      if (key === 'D' && !isTypingInInput && this.activePanel_ === 'stacks') {
        event.preventDefault();
        event.stopPropagation();
        this.switchToPanel_('blocks');
        return;
      }

      // Handle Enter key (select current stack or block)
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        this.selectCurrentItem_();
        return;
      }

      // Handle single letter keys for direct navigation (A-Z) - only when not typing in input
      if (key.length === 1 && key >= 'A' && key <= 'Z' && !isTypingInInput) {
        event.preventDefault();
        event.stopPropagation();

        // Try to navigate directly to the stack with this letter
        if (this.navigateToStack_(key)) {
          this.cancelSearch_();
        } else {
          this.announceMessage_(`No stack found with label ${key}`);
        }
        return;
      }
    };

    // Bind to document to catch all key events
    document.addEventListener('keydown', keyHandler, true);
    this.boundEventHandlers_.push(() => {
      document.removeEventListener('keydown', keyHandler, true);
    });
  }

  /**
   * Switch to a specific panel (stacks or blocks).
   * @param {string} panelType Either 'stacks' or 'blocks'.
   * @private
   */
  switchToPanel_(panelType) {
    if (!this.activeOverlay_) return;

    // Update active panel
    this.activePanel_ = panelType;

    // Update visual indicators
    const stackPanel = this.activeOverlay_.querySelector('.stack-panel');
    const blockPanel = this.activeOverlay_.querySelector('.block-panel');

    if (panelType === 'stacks') {
      stackPanel?.classList.add('active');
      blockPanel?.classList.remove('active');
      // Reset block selection when switching back to stacks
      this.blockSelectionIndex_ = 0;
      const message = 'Stack panel selected. Use W/S to navigate stacks, D to view blocks.';
      this.announceMessage_(message);
    } else {
      stackPanel?.classList.remove('active');
      blockPanel?.classList.add('active');
      // Ensure we have blocks to navigate to
      if (this.availableBlocks_.length === 0) {
        this.updateBlockList_();
      }

      // Announce the currently selected block
      const selectedBlock = this.availableBlocks_[this.blockSelectionIndex_];
      if (selectedBlock) {
        const message = `Block panel selected. Block ${selectedBlock.number}: ${selectedBlock.description}`;
        this.announceMessage_(message);
      } else {
        const message = `Block panel selected. ${this.availableBlocks_.length} blocks available. Use W/S to navigate, A to go back to stacks.`;
        this.announceMessage_(message);
      }
    }

    // Update selection highlight
    this.updateSelectionHighlight_();
  }

  /**
   * Move selection up or down in the current panel.
   * @param {number} direction -1 for up, 1 for down
   * @private
   */
  moveSelection_(direction) {
    if (!this.activeOverlay_) return;

    if (this.activePanel_ === 'stacks') {
      // Navigate in stacks panel
      const newIndex = Math.max(0, Math.min(this.availableStacks_.length - 1, this.currentSelectionIndex_ + direction));

      if (newIndex !== this.currentSelectionIndex_) {
        this.currentSelectionIndex_ = newIndex;
        this.updateSelectionHighlight_();

        // Update blocks panel for newly selected stack
        this.updateBlockList_();

        // Announce selection
        const selectedStack = this.availableStacks_[newIndex];
        if (selectedStack) {
          this.announceMessage_(`Stack ${selectedStack.label}`);
        }
      }
    } else {
      // Navigate in blocks panel
      const newIndex = Math.max(0, Math.min(this.availableBlocks_.length - 1, this.blockSelectionIndex_ + direction));

      if (newIndex !== this.blockSelectionIndex_) {
        this.blockSelectionIndex_ = newIndex;
        this.updateSelectionHighlight_();

        // Announce selection
        const selectedBlock = this.availableBlocks_[newIndex];
        if (selectedBlock) {
          this.announceMessage_(`Block ${selectedBlock.number}: ${selectedBlock.description}`);
        }
      }
    }
  }

  /**
   * Select the currently highlighted item (stack or block).
   * @private
   */
  selectCurrentItem_() {
    if (this.activePanel_ === 'stacks') {
      // Select entire stack (existing behavior)
      this.selectCurrentStack_();
    } else {
      // Select specific block
      this.selectCurrentBlock_();
    }
  }

  /**
   * Select the currently highlighted stack.
   * @private
   */
  selectCurrentStack_() {
    if (!this.availableStacks_ || this.currentSelectionIndex_ < 0 || this.currentSelectionIndex_ >= this.availableStacks_.length) {
      return;
    }

    const selectedStack = this.availableStacks_[this.currentSelectionIndex_];
    const stackLetter = selectedStack.letter;

    if (stackLetter) {
      if (this.navigateToStack_(stackLetter)) {
        this.cancelSearch_();
      }
    }
  }

  /**
   * Select the currently highlighted block.
   * @private
   */
  selectCurrentBlock_() {
    if (!this.availableBlocks_ || this.blockSelectionIndex_ < 0 || this.blockSelectionIndex_ >= this.availableBlocks_.length) {
      return;
    }

    const selectedBlock = this.availableBlocks_[this.blockSelectionIndex_];

    if (this.navigateToBlock_(selectedBlock.blockId)) {
      this.cancelSearch_();
    }
  }

  /**
   * Navigate to a specific block by its ID.
   * @param {string} blockId The ID of the block to navigate to.
   * @return {boolean} True if navigation was successful.
   * @private
   */
  navigateToBlock_(blockId) {
    // Get the target block
    const targetBlock = this.workspace_.getBlockById(blockId);
    if (!targetBlock) {
      this.announceMessage_('Block not found');
      return false;
    }

    // Move cursor to the target block
    const cursor = this.workspace_.getCursor();
    if (!cursor) {
      this.announceMessage_('Workspace cursor not available');
      return false;
    }

    try {
      // Create an AST node for the block and move cursor to it
      const astNode = Blockly.ASTNode.createBlockNode(targetBlock);
      cursor.setCurNode(astNode);

      // Get block description for announcement
      const blockText = typeof targetBlock.toString === 'function' ?
          targetBlock.toString(undefined, ' ').trim() : 'Block';

      // Announce successful navigation
      this.announceMessage_(`Navigated to block: ${blockText}`);

      return true;
    } catch (e) {
      console.warn('Stack search: Error navigating to block', e);
      this.announceMessage_('Error navigating to block');
      return false;
    }
  }

  /**
   * Navigate to a specific stack by its letter.
   * @param {string} letter The stack letter to navigate to.
   * @return {boolean} True if navigation was successful.
   * @private
   */
  navigateToStack_(letter, speech) {
    const stackLabelManager = getStackLabelManager(this.workspace_);
    if (!stackLabelManager) {
      this.announceMessage_('Stack label manager not available');
      return false;
    }

    // Find the block with this letter
    let targetBlockId = null;
    if (stackLabelManager.stackLetters_) {
      for (const [blockId, stackLetter] of stackLabelManager.stackLetters_.entries()) {
        if (stackLetter === letter) {
          targetBlockId = blockId;
          break;
        }
      }
    }

    if (!targetBlockId) {
      this.announceMessage_(`No stack found with letter ${letter}`);
      return false;
    }

    // Get the target block
    let targetBlock = this.workspace_.getBlockById(targetBlockId);
    if (!targetBlock) {
      this.announceMessage_(`Stack ${letter} block not found`);
      return false;
    }

    // Find the actual top block of this stack (in case blocks were added above)
    while (targetBlock.previousConnection && targetBlock.previousConnection.isConnected()) {
      targetBlock = targetBlock.previousConnection.targetBlock();
    }

    // Move cursor to the target block
    const cursor = this.workspace_.getCursor();
    if (!cursor) {
      this.announceMessage_('Workspace cursor not available');
      return false;
    }

    try {
      console.log('Stack search: Successfully navigated to stack', letter, 'actual top block:', targetBlock.id);
      // Create an AST node for the WHOLE STACK and move cursor to it
      const astNode = Blockly.ASTNode.createStackNode(targetBlock);
      cursor.setCurNode(astNode);

      // Get label for announcement
      const customText = stackName(targetBlock);
      const fullLabel = customText ? `${letter} ${customText}` : letter;

      // Announce successful navigation
      this.announceMessage_(`Navigated to stack ${fullLabel}`);
      console.log('Stack search log: Successfully navigated to stack', letter, 'top block:', targetBlock.id);
      return true;
    } catch (e) {
      console.warn('Stack search log: Error navigating to block', e);
      this.announceMessage_(`Error navigating to stack ${letter}`);
      return false;
    }
  }

  /**
   * Update the stack list display with current filtered results.
   * @private
   */
  updateStackList_() {
    if (!this.activeOverlay_) return;

    const stackList = this.activeOverlay_.querySelector('.stack-results');
    if (!stackList) return;

    // Clear existing items
    stackList.innerHTML = '';

    // Add filtered stacks
    this.availableStacks_.forEach((stack, index) => {
      const stackItem = document.createElement('div');
      stackItem.className = 'blockly-stack-search-item stack-result-item';
      stackItem.textContent = `${stack.letter} - ${stack.label}`;
      stackItem.setAttribute('data-stack-id', stack.blockId);
      stackItem.setAttribute('data-stack-letter', stack.letter);

      // Highlight selected item
      if (index === this.currentSelectionIndex_ && this.activePanel_ === 'stacks') {
        stackItem.classList.add('selected');
      }

      stackList.appendChild(stackItem);
    });
  }

  /**
   * Get semantic block name for accessibility.
   * @param {!Blockly.Block} block The block to get name for.
   * @return {string} Human-readable block name.
   * @private
   */
  getActualBlockName_(block) {
    if (!block) return 'unknown block';

    try {
      // Get visible text from block's fields
      const allText = [];
      if (block.inputList) {
        block.inputList.forEach(input => {
          if (input.fieldRow) {
            input.fieldRow.forEach(field => {
              if (field.constructor.name === 'FieldLabel' && field.text_) {
                allText.push(field.text_);
              }
            });
          }
        });
      }

      let blockName = allText.join(' ').trim();

      // If we got text, clean it up
      if (blockName) {
        blockName = blockName.toLowerCase();
        return blockName.includes('block') ? blockName : blockName + ' block';
      }

      // Fallback to common block names
      const typeMap = {
        'controls_if': 'if do block',
        'controls_repeat_ext': 'repeat times block',
        'logic_compare': 'comparison block',
        'math_arithmetic': 'math block',
        'text': 'text block',
        'variables_get': 'variable block',
        'variables_set': 'set variable block'
      };

      return typeMap[block.type] || block.type.replace(/_/g, ' ') + ' block';
    } catch (e) {
      return block.type.replace(/_/g, ' ') + ' block';
    }
  }

  /**
   * Update the block list for the currently selected stack.
   * @private
   */
  updateBlockList_() {
    if (!this.activeOverlay_) return;

    const blockList = this.activeOverlay_.querySelector('.block-results');
    if (!blockList) return;

    // Clear existing items
    blockList.innerHTML = '';

    // Get blocks for currently selected stack
    this.availableBlocks_ = this.getBlocksForCurrentStack_();

    // Add block items - show number with block name
    console.log(`Stack search: Displaying ${this.availableBlocks_.length} blocks in right panel`);
    this.availableBlocks_.forEach((blockInfo, index) => {
      const blockItem = document.createElement('div');
      blockItem.className = 'blockly-stack-search-item block-result-item';
      blockItem.textContent = `${blockInfo.number} ${blockInfo.description}`;
      blockItem.setAttribute('data-block-id', blockInfo.blockId);
      blockItem.setAttribute('data-block-number', blockInfo.number.toString());
      blockItem.setAttribute('aria-label', `Block ${blockInfo.number}: ${blockInfo.description}`);

      console.log(`Stack search: Adding block item ${blockInfo.number} to display`);

      // Highlight selected item
      if (index === this.blockSelectionIndex_ && this.activePanel_ === 'blocks') {
        blockItem.classList.add('selected');
        console.log(`Stack search: Highlighting block ${blockInfo.number} as selected`);
      }

      blockList.appendChild(blockItem);
    });
  }

  /**
   * Get block information for the currently selected stack.
   * @return {!Array<{number: number, blockId: string, description: string}>} Block info array.
   * @private
   */
  getBlocksForCurrentStack_() {
    if (!this.availableStacks_ || this.currentSelectionIndex_ < 0 || this.currentSelectionIndex_ >= this.availableStacks_.length) {
      console.log('Stack search: No valid stack selected for block retrieval');
      return [];
    }

    const selectedStack = this.availableStacks_[this.currentSelectionIndex_];
    const topBlockId = selectedStack.blockId;
    const topBlock = this.workspace_.getBlockById(topBlockId);

    console.log(`Stack search: Getting blocks for stack ${selectedStack.label}, top block ID: ${topBlockId}`);

    if (!topBlock) {
      console.log('Stack search: Top block not found');
      return [];
    }

    const blocks = [];
    let currentBlock = topBlock;
    let blockNumber = 1;

    // Walk through the stack and collect block information
    while (currentBlock) {
      const blockName = this.getActualBlockName_(currentBlock);

      console.log(`Stack search: Found block ${blockNumber}: ${currentBlock.id} (${blockName})`);

      blocks.push({
        number: blockNumber,
        blockId: currentBlock.id,
        description: blockName
      });

      blockNumber++;

      // Get next block in the stack - only follow nextConnection (main chain)
      if (currentBlock.nextConnection && currentBlock.nextConnection.isConnected()) {
        currentBlock = currentBlock.nextConnection.targetBlock();
        console.log(`Stack search: Found next block via nextConnection: ${currentBlock.id}`);
      } else {
        console.log(`Stack search: No more blocks in main chain`);
        break;
      }
    }

    console.log(`Stack search: Total blocks found in stack: ${blocks.length}`);
    return blocks;
  }

  /**
   * Update the visual selection highlight.
   * @private
   */
  updateSelectionHighlight_() {
    if (!this.activeOverlay_) return;

    console.log(`Stack search: Updating highlights - active panel: ${this.activePanel_}, stack index: ${this.currentSelectionIndex_}, block index: ${this.blockSelectionIndex_}`);

    // Update stack highlights
    const stackItems = this.activeOverlay_.querySelectorAll('.stack-result-item');
    console.log(`Stack search: Found ${stackItems.length} stack items`);
    stackItems.forEach((item, index) => {
      if (index === this.currentSelectionIndex_ && this.activePanel_ === 'stacks') {
        item.classList.add('selected');
        console.log(`Stack search: Highlighting stack item ${index} as selected`);
      } else {
        item.classList.remove('selected');
      }
    });

    // Update block highlights
    const blockItems = this.activeOverlay_.querySelectorAll('.block-result-item');
    console.log(`Stack search: Found ${blockItems.length} block items`);
    blockItems.forEach((item, index) => {
      if (index === this.blockSelectionIndex_ && this.activePanel_ === 'blocks') {
        item.classList.add('selected');
        console.log(`Stack search: Highlighting block item ${index} as selected`);
      } else {
        item.classList.remove('selected');
      }
    });
  }

  /**
   * Handle search input text changes and filter stacks.
   * @param {string} searchText The text to search for.
   * @private
   */
  handleSearchInput_(searchText) {
    this.searchQuery_ = searchText.toLowerCase();

    // Filter stacks based on search query
    if (this.searchQuery_.length === 0) {
      this.availableStacks_ = this.allAvailableStacks_;
    } else {
      this.availableStacks_ = this.allAvailableStacks_.filter(stack => {
        const labelLower = stack.label.toLowerCase();
        const letterLower = stack.letter.toLowerCase();
        return labelLower.includes(this.searchQuery_) || letterLower.includes(this.searchQuery_);
      });
    }

    // Reset selection to first item
    this.currentSelectionIndex_ = 0;

    // Update the displays
    this.updateStackList_();
    this.updateBlockList_();

    // Announce results to screen reader
    if (this.availableStacks_.length === 0) {
      this.announceMessage_(`No stacks found matching "${searchText}"`);
    } else if (this.searchQuery_.length > 0) {
      this.announceMessage_(`${this.availableStacks_.length} stacks found matching "${searchText}"`);
    }
  }

  /**
   * Cancel the current search and cleanup.
   * @private
   */
  cancelSearch_() {
    console.log('Stack search: Canceling search');

    this.searchActive_ = false;
    this.removeSearchOverlay_();
    this.unbindSearchKeyHandlers_();

    // Restore focus to workspace
    this.restoreWorkspaceFocus_();

    this.announceMessage_('Stack search closed. Focus is on workspace.');
  }

  /**
   * Remove the search overlay from the DOM.
   * @private
   */
  removeSearchOverlay_() {
    if (this.activeOverlay_) {
      if (this.activeOverlay_.parentNode) {
        this.activeOverlay_.parentNode.removeChild(this.activeOverlay_);
      }
      this.activeOverlay_ = null;
    }
  }

  /**
   * Unbind all search-related keyboard event handlers.
   * @private
   */
  unbindSearchKeyHandlers_() {
    this.boundEventHandlers_.forEach(unbinder => unbinder());
    this.boundEventHandlers_.length = 0;
  }

  /**
   * Restore focus to the workspace after search.
   * @private
   */
  restoreWorkspaceFocus_() {
    try {
      const workspaceDiv = this.workspace_.getParentSvg();
      if (workspaceDiv && workspaceDiv.parentNode) {
        const blocklyDiv = workspaceDiv.closest('.blocklyDiv') || workspaceDiv.parentNode;
        if (blocklyDiv && blocklyDiv.focus) {
          blocklyDiv.focus();
        }
      }
    } catch (e) {
      console.warn('Stack search: Could not restore workspace focus', e);
    }
  }

  /**
   * Announce a message to screen readers.
   * @param {string} message The message to announce.
   * @private
   */
  announceMessage_(message) {
    const output = getOutputManager();
    if (output) {
      sayDialog(message);
      return;
    }
    try {
      // Create temporary announcement element for screen readers
      const announcement = document.createElement('div');
      announcement.setAttribute('aria-live', 'assertive');
      announcement.setAttribute('aria-atomic', 'true');
      announcement.style.position = 'absolute';
      announcement.style.left = '-10000px';
      announcement.style.width = '1px';
      announcement.style.height = '1px';
      announcement.style.overflow = 'hidden';
      announcement.textContent = message;

      document.body.appendChild(announcement);

      // Remove after announcement
      setTimeout(() => {
        if (announcement.parentNode) {
          announcement.parentNode.removeChild(announcement);
        }
      }, 1000);

      console.log('Stack search:', message);
    } catch (e) {
      console.warn('Stack search: Could not announce message', e);
    }
  }

  /**
   * Disable the stack search manager and clean up.
   */
  disable() {
    this.enabled_ = false;

    // Cancel any active search
    if (this.searchActive_) {
      this.cancelSearch_();
    }

    // Remove from registry
    if (this.workspace_ && this.workspace_.id) {
      stackSearchManagerRegistry.delete(this.workspace_.id);
    }

    console.log('Stack search: Disabled for workspace', this.workspace_.id);
  }
}

/**
 * Initialize stack search for a workspace.
 * @param {!Blockly.WorkspaceSvg} workspace The workspace to initialize search on.
 * @return {!StackSearchManager} The stack search manager instance.
 */
export function initStackSearch(workspace, speech) {
  // Validate workspace
  if (!workspace || !workspace.id) {
    console.error('Cannot initialize stack search: invalid workspace');
    return null;
  }

  // Check if an instance already exists for this workspace
  let manager = stackSearchManagerRegistry.get(workspace.id);

  // If no instance exists, create one
  if (!manager) {
    manager = new StackSearchManager(workspace, speech);
    manager.init();
  } else {
    // If a manager already exists, just ensure it's initialized
    if (!manager.enabled_) {
      manager.init();
    }
  }

  return manager;
}

/**
 * Dispose stack search for a workspace.
 * @param {!Blockly.WorkspaceSvg} workspace The workspace to dispose search for.
 */
export function disposeStackSearch(workspace) {
  if (!workspace || !workspace.id) return;

  const manager = stackSearchManagerRegistry.get(workspace.id);
  if (manager) {
    manager.disable();
  }
}

// Add styles for the search overlay
document.head.insertAdjacentHTML('beforeend', `
<style>
  .blockly-stack-search-overlay {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: white;
    border: 2px solid var(--eaf-accent, #1976d2);
    border-radius: 8px;
    padding: 20px;
    width: 700px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
    z-index: 10000;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    outline: none;
  }
  
  .blockly-stack-search-content {
    width: 100%;
  }
  
  .blockly-stack-search-panels {
    display: flex;
    gap: 20px;
    margin-bottom: 16px;
    width: 100%;
  }
  
  .blockly-stack-search-panel {
    flex: 1;
    min-width: 0;
    border: 2px solid var(--eaf-line, #ddd);
    border-radius: 4px;
    background: var(--eaf-surface-alt, #f9f9f9);
  }
  
  .blockly-stack-search-input-container {
    width: 100%;
    margin-bottom: 16px;
  }
  
  .blockly-stack-search-input {
    width: 100%;
    padding: 8px 12px;
    font-size: 14px;
    border: 2px solid var(--eaf-line, #ddd);
    border-radius: 4px;
    box-sizing: border-box;
  }
  
  .blockly-stack-search-input:focus {
    outline: none;
    border-color: var(--eaf-accent, #1976d2);
  }
  
  .blockly-stack-search-panel.active {
    border-color: var(--eaf-accent, #1976d2);
    background: var(--eaf-selected-bg, #e3f2fd);
  }
  
  .panel-title {
    background: var(--eaf-accent, #1976d2);
    color: white;
    padding: 8px 12px;
    font-weight: bold;
    font-size: 14px;
    margin: 0;
    border-top-left-radius: 2px;
    border-top-right-radius: 2px;
  }
  
  .blockly-stack-search-panel.active .panel-title {
    background: var(--eaf-accent-strong, #0d47a1);
  }
  
  .blockly-stack-search-title {
    font-size: 18px;
    font-weight: bold;
    color: var(--eaf-accent, #1976d2);
    margin-bottom: 12px;
    text-align: center;
  }
  
  .blockly-stack-search-instructions {
    font-size: 14px;
    color: var(--eaf-fg, #333);
    margin-bottom: 16px;
    text-align: center;
  }
  
  .blockly-stack-search-list {
    max-height: 200px;
    overflow-y: auto;
    margin: 0;
    border: none;
    border-radius: 0;
    background: transparent;
    padding: 8px;
  }
  
  .blockly-stack-search-item {
    padding: 8px 12px;
    border-bottom: 1px solid var(--eaf-line-soft, #eee);
    font-family: monospace;
    font-size: 14px;
    color: var(--eaf-fg, #333);
  }
  
  .blockly-stack-search-item:last-child {
    border-bottom: none;
  }
  
  .blockly-stack-search-item:hover {
    background: var(--eaf-selected-bg, #e3f2fd);
  }
  
  .blockly-stack-search-item.selected {
    background: var(--eaf-accent, #1976d2) !important;
    color: white !important;
    font-weight: bold;
    border: 2px solid var(--eaf-accent-strong, #0d47a1);
  }
  
  .blockly-stack-search-cancel {
    font-size: 12px;
    color: var(--eaf-fg-muted, #666);
    text-align: center;
    font-style: italic;
  }
</style>
`);
