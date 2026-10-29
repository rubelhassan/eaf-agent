/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Implements stack labeling in Blockly.
 * Each visually separate stack gets an alphabetical label (A-Z, AA-ZZ, etc.)
 * with optional custom text added by the user.
 */

import * as Blockly from 'blockly/core';
import {setStackName, stackName} from './stack_name.js';

// Global registry to track all StackLabelManager instances by workspace ID
const stackLabelManagerRegistry = new Map();

/**
 * Get a StackLabelManager instance for a specific workspace.
 * @param {!Blockly.WorkspaceSvg} workspace The workspace to get the manager for.
 * @return {StackLabelManager|null} The manager for the workspace, or null if none exists.
 */
export function getStackLabelManager(workspace) {
  if (!workspace || !workspace.id) return null;
  return stackLabelManagerRegistry.get(workspace.id) || null;
}


/**
 * Get the label for a STACK AST node using the StackLabelManager.
 * Expects `astNode.getType() === Blockly.ASTNode.types.STACK`.
 *
 * @param {!Blockly.ASTNode} stackNode - An AST node of type STACK.
 * @param {!Blockly.WorkspaceSvg} workspace
 * @return {string|null} e.g., "A" or "A My Program", or null if not found.
 */
export function getStackLabelFromStackNode(stackNode, workspace) {
  if (!stackNode || !workspace) return null;
  if (stackNode.getType?.() !== Blockly.ASTNode.types.STACK) return null;

  // for STACK nodes, location should be the top block of the stack.
  const block = stackNode.getLocation?.();
  if (!block || !block.id) return null;

  // ensure that we are at the top-most block.
  let top = block;
  while (typeof top.getParent === 'function' && top.getParent()) {
    top = top.getParent();
  }

  const mgr = getStackLabelManager(workspace);
  if (!mgr) return null;

  const letter = mgr.stackLetters()?.get(top.id) || '';
  const custom = stackName(top);

  if (!letter && !custom) {
    return null;
  }
  return custom ? `${letter} with custom label ${custom}` : letter;
}


/**
 * Class for managing alphabetical labels for block stacks.
 * Every stack gets a label in alphabetical order.
 */
export class StackLabelManager {
  /**
   * Constructor for the StackLabelManager.
   * @param {!Blockly.WorkspaceSvg} workspace The workspace to manage stack labels for.
   */
  constructor(workspace) {
    /**
     * The workspace this manager is associated with.
     * @type {!Blockly.WorkspaceSvg}
     * @private
     */
    this.workspace_ = workspace;

    // Register this instance in the global registry
    if (workspace && workspace.id) {
      stackLabelManagerRegistry.set(workspace.id, this);
    }

    /**
     * Map of block IDs to their stack label elements.
     * @type {!Map<string, SVGElement>}
     * @private
     */
    this.stackLabels_ = new Map();

    /**
     * Map of block IDs to their stack letter labels.
     * @type {!Map<string, string>}
     * @private
     */
    this.stackLetters_ = new Map();

    /**
     * Set of all assigned labels to avoid reuse.
     * @type {!Set<string>}
     * @private
     */
    this.usedLabels_ = new Set();

    /**
     * The next label index to try when assigning new labels.
     * @type {number}
     * @private
     */
    this.nextLabelIndex_ = 0;

    /**
     * Whether the manager is currently enabled.
     * @type {boolean}
     * @private
     */
    this.enabled_ = false;

    /**
     * The currently active label editor, if any.
     * @type {HTMLElement|null}
     * @private
     */
    this.activeEditor_ = null;

    /**
     * The block ID being edited, if any.
     * @type {string|null}
     * @private
     */
    this.editingBlockId_ = null;

    /**
     * Bound event handlers for workspace events.
     * @type {!Array<function(!Blockly.Events.Abstract)>}
     * @private
     */
    this.boundEvents_ = [];
  }

  stackLetters() {
    return this.stackLetters_;
  }

  /**
   * Initialize the stack label manager.
   */
  init() {
    if (this.enabled_) return;

    // Make sure critical methods are defined before we use them
    if (!this.getAllTopBlocks_) {
      this.getAllTopBlocks_ = function() {
        if (!this.workspace_) return [];
        // Use Blockly's native getTopBlocks method
        return this.workspace_.getTopBlocks(false);
      };
    }

    // Make sure cleanupLabelsAndMaps_ is defined
    if (!this.cleanupLabelsAndMaps_) {
      this.cleanupLabelsAndMaps_ = function() {
        // Remove labels for blocks that no longer exist
        const toDelete = [];

        for (const [blockId, letter] of this.stackLetters_.entries()) {
          const block = this.workspace_.getBlockById(blockId);
          if (!block) {
            toDelete.push(blockId);
          }
        }

        for (const blockId of toDelete) {
          const letter = this.stackLetters_.get(blockId);
          this.usedLabels_.delete(letter);
          this.stackLetters_.delete(blockId);

          // Also remove any SVG label elements
          if (this.stackLabels_.has(blockId)) {
            const label = this.stackLabels_.get(blockId);
            if (label && label.parentNode) {
              label.parentNode.removeChild(label);
            }
            this.stackLabels_.delete(blockId);
          }
        }
      };
    }

    // Make sure removeOrphanedLabels_ is defined
    if (!this.removeOrphanedLabels_) {
      this.removeOrphanedLabels_ = function() {
        // First remove any labels whose block doesn't exist anymore
        for (const [blockId, label] of this.stackLabels_.entries()) {
          const block = this.workspace_.getBlockById(blockId);
          if (!block) {
            if (label && label.parentNode) {
              label.parentNode.removeChild(label);
            }
            this.stackLabels_.delete(blockId);
          }
        }
      };
    }

    this.enabled_ = true;

    // Clear any existing state first
    this.resetState();

    // Update all stack labels
    this.updateAllStackLabels_();

    // Register keyboard shortcuts
    this.registerKeyboardShortcuts_();

    // Register workspace change listener for program loading
    this.workspaceChangeListener_ = this.workspace_.addChangeListener(this.onWorkspaceChange_.bind(this));

    // Also listen for finished loading events specifically
    this.workspace_.addChangeListener((event) => {
      if (event.type === Blockly.Events.FINISHED_LOADING) {
        console.log('Stack labels: FINISHED_LOADING event detected');
        setTimeout(() => {
          this.updateAllStackLabels_();
        }, 100);
      }
    });

    // Add a fallback detection system for toolbox blocks
    this.startBlockDetection_();

    // Add DOM mutation observer as additional safety net
    this.startDomObserver_();
  }

  /**
   * Start a fallback block detection system for toolbox-dragged blocks.
   * @private
   */
  startBlockDetection_() {
    // Keep track of known block count
    this.lastBlockCount_ = 0;

    // Set up periodic detection - more aggressive
    this.blockDetectionInterval_ = setInterval(() => {
      const currentBlocks = this.getAllTopBlocks_();
      const currentCount = currentBlocks.length;

      // Check not just count but also if top blocks have changed
      const currentBlockIds = currentBlocks.map(b => b.id).sort().join(',');

      if (currentCount !== this.lastBlockCount_ || currentBlockIds !== this.lastBlockIds_) {
        console.log('Stack labels: Block structure changed from', this.lastBlockCount_, 'blocks to', currentCount, 'blocks');
        console.log('Stack labels: Block IDs changed from', this.lastBlockIds_, 'to', currentBlockIds);

        // Update labels when block structure changes
        setTimeout(() => {
          this.updateAllStackLabels_();
        }, 100);

        this.lastBlockCount_ = currentCount;
        this.lastBlockIds_ = currentBlockIds;
      }
      const names = this.nameSignature_();
      if (names !== this.namesSeen_) {
        this.namesSeen_ = names;
        for (const id of this.stackLetters_.keys()) this.showLabelText_(id);
      }
    }, 150); // Check more frequently to catch keyboard connections

    console.log('Stack labels: Started fallback block detection');
  }

  /**
   * Stop the fallback block detection system.
   * @private
   */
  stopBlockDetection_() {
    if (this.blockDetectionInterval_) {
      clearInterval(this.blockDetectionInterval_);
      this.blockDetectionInterval_ = null;
      console.log('Stack labels: Stopped fallback block detection');
    }
  }

  /**
   * Start DOM mutation observer to catch visual changes.
   * @private
   */
  startDomObserver_() {
    if (!this.workspace_ || !this.workspace_.getParentSvg) return;

    const workspaceSvg = this.workspace_.getParentSvg();
    if (!workspaceSvg) return;

    this.domObserver_ = new MutationObserver((mutations) => {
      let needsUpdate = false;
      mutations.forEach((mutation) => {
        // Check for added or removed block elements
        if (mutation.type === 'childList') {
          const addedNodes = Array.from(mutation.addedNodes);
          const removedNodes = Array.from(mutation.removedNodes);

          if (addedNodes.some(node => node.classList && node.classList.contains('blocklyDraggable')) ||
              removedNodes.some(node => node.classList && node.classList.contains('blocklyDraggable'))) {
            needsUpdate = true;
          }
        }
      });

      if (needsUpdate) {
        console.log('Stack labels: DOM changes detected, updating labels');
        setTimeout(() => {
          this.updateAllStackLabels_();
        }, 200);
      }
    });

    this.domObserver_.observe(workspaceSvg, {
      childList: true,
      subtree: true
    });

    console.log('Stack labels: Started DOM mutation observer');
  }

  /**
   * Stop DOM mutation observer.
   * @private
   */
  stopDomObserver_() {
    if (this.domObserver_) {
      this.domObserver_.disconnect();
      this.domObserver_ = null;
      console.log('Stack labels: Stopped DOM mutation observer');
    }
  }

  /**
   * Register keyboard shortcuts for stack labels.
   * NOTE: Keyboard shortcuts are now handled by NavigationController
   * @private
   */
  registerKeyboardShortcuts_() {
    // Alt+I shortcut is now registered in NavigationController.registerStackLabelEdit()
    // This method is kept for compatibility but no longer registers shortcuts
    console.log('Stack label shortcuts are handled by NavigationController');
  }

  /**
   * Handle keydown events for stack label shortcuts.
   * NOTE: This method is no longer used - shortcuts handled by NavigationController
   * @param {!KeyboardEvent} e The keyboard event.
   * @private
   * @deprecated
   */
  handleKeyDown_(e) {
    // This method is deprecated - Alt+I is now handled by NavigationController
    console.warn('handleKeyDown_ is deprecated - use NavigationController instead');
  }

  /**
   * Common handler for stack label shortcut regardless of registration method.
   * @param {!Blockly.WorkspaceSvg} workspace The workspace to handle shortcut in.
   * @private
   */
  handleStackLabelShortcut_(workspace, speech) {
    console.log('Handling stack label shortcut');
    if (!workspace) return false;

    // Check if we're in keyboard accessibility mode
    if (!workspace.keyboardAccessibilityMode) {
      console.log('Keyboard accessibility mode not enabled, cannot edit stack label');
      return false;
    }

    // Check if a cursor exists and get the current cursor
    const cursor = workspace.getCursor && workspace.getCursor();
    if (!cursor) {
      console.log('No cursor available, cannot edit stack label');
      return false;
    }

    // Get the current node and check if it's a stack
    const curNode = cursor.getCurNode();
    if (!curNode) {
      console.log('No current node under cursor');
      return false;
    }

    // Check if we're in stack mode - this is when the red border and transparent box appears
    // This happens when the user is at the stack level of navigation
    const isStackMode = curNode.getType() === Blockly.ASTNode.types.STACK;
    if (!isStackMode) {
      console.log('Not in stack mode, cannot edit stack label. Current node type:',
                 curNode.getType(), 'Need type:', Blockly.ASTNode.types.STACK);

      // Announce to screen reader that user is on block level
      speech?.update('You are on block level. Please navigate to stack level to change stack label.');

      return false;
    }

    // Get the block at the current location
    const targetBlock = curNode.getLocation();
    if (!targetBlock) {
      console.log('No block at current location');
      return false;
    }

    // Get the top block in the stack
    let topBlock = targetBlock;
    while (topBlock.getParent()) {
      topBlock = topBlock.getParent();
    }

    console.log('Found stack top block for editing:', topBlock.id);

    // Handle label editing inline
    const blockId = topBlock.id;

    // Make sure stack labels are updated before editing
    this.updateAllStackLabels_();

    // Explicitly add a label if one doesn't exist
    if (!this.stackLetters_.has(blockId)) {
      console.log('Explicitly assigning new label to block:', blockId);
      const newLabel = this.getNextAvailableLabel_();
      this.stackLetters_.set(blockId, newLabel);
      this.usedLabels_.add(newLabel);
      this.addLabel_(topBlock, newLabel);
    }

    // Double check we have a label
    const letter = this.stackLetters_.get(blockId);
    console.log('Block now has letter:', letter);

    if (letter) {
      // Open the editor with this label
      this.showEditor_(blockId);
      return true;
    } else {
      console.error('Failed to assign a label to the block');
      return false;
    }
  }

  /**
   * Show the editor for a stack label.
   * @param {string} blockId The ID of the top block to edit label for.
   * @private
   */
  showEditor_(blockId) {
    // Close any existing editor first
    this.closeEditor_();

    // Get the block and its label
    const block = this.workspace_.getBlockById(blockId);
    if (!block) {
      console.warn('Cannot show editor: Block not found', blockId);
      return;
    }

    const letter = this.stackLetters_.get(blockId);
    if (!letter) {
      console.warn('Cannot show editor: Block has no letter label');
      return;
    }

    // Get the custom text part (without the letter prefix)
    const currentLabel = stackName(block);

    // Get the position of the label element in the DOM
    const stackLabelDomElement = document.querySelector('.blocklyStackLabel[data-block-id="' + blockId + '"]');
    if (!stackLabelDomElement) {
      console.warn('Cannot find stack label element for positioning editor');
    }

    // Create editor container
    const editor = document.createElement('div');
    editor.className = 'blockly-stack-label-editor';
    document.body.appendChild(editor);

    // Style the editor
    editor.style.position = 'absolute';
    editor.style.zIndex = '1000';
    editor.style.background = 'white';
    editor.style.border = '1px solid #888';
    editor.style.borderRadius = '4px';
    editor.style.padding = '8px';
    editor.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.3)';
    editor.style.minWidth = '220px';

    // Create title
    const title = document.createElement('div');
    title.textContent = 'Edit Stack Label';
    title.style.fontWeight = 'bold';
    title.style.marginBottom = '8px';
    editor.appendChild(title);

    // Create instruction
    const instruction = document.createElement('div');
    instruction.textContent = `The letter "${letter}" will be preserved. Add your custom text:`;
    instruction.style.marginBottom = '8px';
    editor.appendChild(instruction);

    // Create input field with letter prefix displayed but not editable
    const inputWrapper = document.createElement('div');
    inputWrapper.style.display = 'flex';
    inputWrapper.style.alignItems = 'center';
    inputWrapper.style.marginBottom = '8px';

    const letterPrefix = document.createElement('div');
    letterPrefix.textContent = letter + ' ';
    letterPrefix.style.fontWeight = 'bold';
    letterPrefix.style.marginRight = '4px';
    letterPrefix.style.fontSize = '16px';
    inputWrapper.appendChild(letterPrefix);

    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentLabel;
    input.style.flex = '1';
    input.style.padding = '4px';
    input.style.border = '1px solid #ccc';
    input.style.borderRadius = '3px';

    // Simple fix: Clear "I" if it appears from Shift+I shortcut
    setTimeout(() => {
      if (input.value === 'I' || input.value === 'i') {
        input.value = '';
      }
    }, 100);

    inputWrapper.appendChild(input);

    editor.appendChild(inputWrapper);

    // Create preview of how the label will appear
    const previewContainer = document.createElement('div');
    previewContainer.style.marginBottom = '8px';
    previewContainer.style.fontSize = '13px';
    previewContainer.style.color = '#555';

    const previewLabel = document.createElement('span');
    previewLabel.textContent = 'Preview: ';
    previewContainer.appendChild(previewLabel);

    const preview = document.createElement('span');
    preview.textContent = letter + (input.value ? ' ' + input.value : '');
    preview.style.fontWeight = 'bold';
    previewContainer.appendChild(preview);

    editor.appendChild(previewContainer);

    // Update preview as user types
    input.addEventListener('input', () => {
      preview.textContent = letter + (input.value ? ' ' + input.value : '');
    });

    // Create buttons
    const buttonContainer = document.createElement('div');
    buttonContainer.style.display = 'flex';
    buttonContainer.style.justifyContent = 'space-between';

    const saveButton = document.createElement('button');
    saveButton.textContent = 'Save';
    saveButton.style.padding = '4px 8px';
    saveButton.style.marginRight = '8px';
    buttonContainer.appendChild(saveButton);

    const cancelButton = document.createElement('button');
    cancelButton.textContent = 'Cancel';
    cancelButton.style.padding = '4px 8px';
    buttonContainer.appendChild(cancelButton);

    editor.appendChild(buttonContainer);

    // Position the editor near the stack label if possible
    if (stackLabelDomElement) {
      const labelRect = stackLabelDomElement.getBoundingClientRect();
      editor.style.left = (labelRect.left - 10) + 'px';
      editor.style.top = (labelRect.bottom + 10) + 'px';
    } else {
      // Fallback positioning near the block
      const blockBounds = block.getBoundingRectangle();
      if (blockBounds) {
        const workspaceScale = this.workspace_.scale;
        const workspaceMetrics = this.workspace_.getMetrics();

        editor.style.left = (blockBounds.left * workspaceScale + workspaceMetrics.absoluteLeft) + 'px';
        editor.style.top = (blockBounds.top * workspaceScale + workspaceMetrics.absoluteTop - 50) + 'px';
      } else {
        // Final fallback - center on screen
        editor.style.left = '50%';
        editor.style.top = '50%';
        editor.style.transform = 'translate(-50%, -50%)';
      }
    }

    // Set up event handlers
    saveButton.addEventListener('click', () => {
      this.saveEditorChanges_(blockId, letter, input.value.trim());
    });

    cancelButton.addEventListener('click', () => {
      this.closeEditor_();
    });

    // Submit on Enter key
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.saveEditorChanges_(blockId, letter, input.value.trim());
      } else if (e.key === 'Escape') {
        this.closeEditor_();
      }
    });

    // Prevent 'I' from appearing in input when opened with Shift+I
    // Focus and select after a short delay to avoid key propagation
    setTimeout(() => {
      input.focus();
      input.select();
    }, 10);

    // Store editor reference for later cleanup
    this.editor_ = editor;
    this.focusedBlockId_ = blockId;
  }

  /**
   * Close the stack label editor and clean up all event listeners.
   * @private
   */
  closeEditor_() {
    if (this.editor_) {
      // Store references to elements with event listeners
      try {
        // Get elements with event listeners
        const input = this.editor_.querySelector('input');
        const saveButton = this.editor_.querySelector('button:first-of-type');
        const cancelButton = this.editor_.querySelector('button:last-of-type');

        // Remove event listeners explicitly
        // Note: We need to use the original bound functions to properly remove
        // but since we don't have references to those, we use the cloneNode
        // technique to effectively clear all listeners
        if (input) {
          const newInput = input.cloneNode(true);
          input.parentNode.replaceChild(newInput, input);
        }

        if (saveButton) {
          const newSaveButton = saveButton.cloneNode(true);
          saveButton.parentNode.replaceChild(newSaveButton, saveButton);
        }

        if (cancelButton) {
          const newCancelButton = cancelButton.cloneNode(true);
          cancelButton.parentNode.replaceChild(newCancelButton, cancelButton);
        }
      } catch (e) {
        console.warn('Error while cleaning up editor event listeners:', e);
      }

      // Remove the editor from DOM
      if (this.editor_.parentNode) {
        this.editor_.parentNode.removeChild(this.editor_);
      }

      // Clear references
      this.editor_ = null;
      this.focusedBlockId_ = null;

      // Restore focus to the workspace to ensure keyboard navigation works
      this.restoreWorkspaceFocus_();
    }
  }

  /**
   * Restore focus to the workspace after closing the editor.
   * @private
   */
  restoreWorkspaceFocus_() {
    try {
      // Focus the workspace div to restore keyboard navigation
      const workspaceDiv = this.workspace_.getParentSvg();
      if (workspaceDiv && workspaceDiv.parentNode) {
        // Find the blocklyDiv container
        const blocklyDiv = workspaceDiv.closest('.blocklyDiv') || workspaceDiv.parentNode;
        if (blocklyDiv && blocklyDiv.focus) {
          blocklyDiv.focus();
          console.log('Restored focus to workspace');
        } else {
          // Fallback - focus the SVG directly
          workspaceDiv.focus();
          console.log('Restored focus to workspace SVG');
        }
      }

      // Also ensure keyboard accessibility mode stays active if it was active
      if (this.workspace_.keyboardAccessibilityMode) {
        // Give it a small delay to ensure focus is properly restored
        setTimeout(() => {
          if (this.workspace_.getCursor) {
            const cursor = this.workspace_.getCursor();
            if (cursor && cursor.getCurNode()) {
              console.log('Keyboard accessibility mode focus maintained');
            }
          }
        }, 10);
      }
    } catch (e) {
      console.warn('Could not restore workspace focus:', e);
    }
  }

  /**
   * Save changes from the stack label editor.
   * @param {string} blockId The ID of the block to save changes for.
   * @param {string} letter The letter label for the block.
   * @param {string} customText The custom text to append to the label.
   * @private
   */
  saveEditorChanges_(blockId, letter, customText) {
    console.log('Saving editor changes for block:', blockId, 'Letter:', letter, 'Custom text:', customText);

    // Get the block
    const block = this.workspace_.getBlockById(blockId);
    if (!block) {
      console.warn('Cannot save changes: Block not found', blockId);
      this.closeEditor_();
      return;
    }

    // Make sure we have a letter assigned
    if (!letter) {
      console.error('Cannot save without a letter assigned');
      this.closeEditor_();
      return;
    }

    // Double check the letter is in the stackLetters_ map
    if (!this.stackLetters_.has(blockId)) {
      console.log('Letter not found in stackLetters_ map, adding it now');
      this.stackLetters_.set(blockId, letter);
      this.usedLabels_.add(letter);
    }

    // The custom part is saved with the program and undoable.
    setStackName(block, customText);
    this.namesSeen_ = this.nameSignature_();

    this.showLabelText_(blockId);

    // Close the editor
    this.closeEditor_();
  }

  /** Shows a stack's label as its letter plus its name ("A Apple"). */
  showLabelText_(blockId) {
    const block = this.workspace_.getBlockById(blockId);
    const letter = this.stackLetters_.get(blockId);
    if (!block || !letter) return;
    const customText = stackName(block);
    const displayText = letter + (customText ? ' ' + customText : '');
    const stackLabelDomElement = document.querySelector('.blocklyStackLabel[data-block-id="' + blockId + '"]');
    if (stackLabelDomElement) {
      // Find the text element within the label group
      const textElement = stackLabelDomElement.querySelector('text');
      if (textElement) {
        textElement.textContent = displayText;

        // Also update background size to fit new text
        const background = stackLabelDomElement.querySelector('rect');
        if (background) {
          const padding = 8;
          const textWidth = displayText.length * 8; // Approximate text width
          const textHeight = 16;

          background.setAttribute('width', textWidth + padding * 2);
          background.setAttribute('height', textHeight + padding);
          background.setAttribute('x', -(textWidth + padding * 2) / 2);
          background.setAttribute('y', -(textHeight + padding) / 2);
        }
      } else {
        console.warn('Could not find text element within label group');
      }

      // Also update any ARIA attributes for screen readers
      try {
        const blockElement = block.getSvgRoot();
        if (blockElement) {
          blockElement.setAttribute('aria-label', `Stack ${displayText}`);
          blockElement.setAttribute('title', `Stack ${displayText}`);
        }
      } catch (e) {
        console.warn('Could not update ARIA attributes', e);
      }
    } else {
      console.warn('Could not find label element to update');
      // If element doesn't exist, update all labels
      this.updateAllStackLabels_();
    }
  }

  /** The names of all stacks, to notice a change (undo changes a name without an event). */
  nameSignature_() {
    return [...this.stackLetters_.keys()].map((id) => `${id}:${stackName(this.workspace_.getBlockById(id))}`).join('|');
  }

  /**
   * Unregister the edit label shortcut.
   * @private
   */
  unregisterEditLabelShortcut_() {
    if (this.editShortcutHandler_) {
      document.removeEventListener('keydown', this.editShortcutHandler_);
      this.editShortcutHandler_ = null;
      console.log('Stack label edit shortcut unregistered');
    }
  }

  /**
   * Disable the stack label manager and clean up.
   */
  disable() {
    this.enabled_ = false;

    // Stop block detection
    this.stopBlockDetection_();

    // Stop DOM observer
    this.stopDomObserver_();

    // Unbind event handlers
    this.unbindWorkspaceEvents_();

    // Remove all labels
    this.removeAllLabels_();

    // Clear all state
    this.resetState();
  }

  /**
   * Clean up the stack label manager.
   */
  dispose() {
    if (!this.enabled_) return;
    this.enabled_ = false;

    // Unbind event handlers
    this.unbindWorkspaceEvents_();

    // Remove all labels
    this.removeAllLabels_();

    // No active editor cleanup needed with the new minimal approach

    // Unregister the edit shortcut
    this.unregisterEditLabelShortcut_();

    // Clear maps
    this.stackLabels_.clear();
    this.stackLetters_.clear();

    // Unregister from the global registry
    if (this.workspace_ && this.workspace_.id) {
      stackLabelManagerRegistry.delete(this.workspace_.id);
    }
  }

  /**
   * Bind workspace events for updating stack labels.
   * @private
   */
  bindWorkspaceEvents_() {
    // Handler for block create, delete, move, change events
    const onBlockEvent = this.onBlockEvent_.bind(this);

    // Listen for block events
    this.workspace_.addChangeListener(onBlockEvent);

    // Handler for UI events (specifically for block dragging)
    const onUiEvent = this.onUiEvent_.bind(this);
    this.workspace_.addChangeListener(onUiEvent);

    // Store bound event handlers for cleanup
    this.boundEvents_.push(onBlockEvent, onUiEvent);

    // Patch Blockly's clearWorkspaceAndLoadFromXml to reset stack labels
    if (!Blockly.Xml.clearWorkspaceAndLoadFromXml.__stackLabelPatched) {
      const originalFn = Blockly.Xml.clearWorkspaceAndLoadFromXml;

      Blockly.Xml.clearWorkspaceAndLoadFromXml = function(xml, workspace) {
        // Before clearing workspace and loading new XML, reset stack labels if available
        if (workspace && workspace.id) {
          const manager = stackLabelManagerRegistry.get(workspace.id);
          if (manager) {
            console.log('Stack labels reset due to XML load for workspace', workspace.id);
            manager.resetState();
          }
        }

        // Call the original function
        const result = originalFn.call(this, xml, workspace);

        // After loading XML, ensure stack labels are updated
        if (workspace && workspace.id) {
          const manager = stackLabelManagerRegistry.get(workspace.id);
          if (manager) {
            console.log('Updating stack labels after XML load');
            setTimeout(() => manager.updateAllStackLabels_(), 50);
          }
        }

        return result;
      };

      // Mark as patched to avoid double patching
      Blockly.Xml.clearWorkspaceAndLoadFromXml.__stackLabelPatched = true;
    }
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
   * Handle events from blocks in this workspace.
   * @param {!Object} e The Blockly event.
   * @private
   */
  /**
   * Handle workspace change events.
   * @param {!Blockly.Events.Abstract} e The event.
   * @private
   */
  onWorkspaceChange_(e) {
    // Handle UI events separately
    if (e.isUiEvent) {
      this.handleUiEvent_(e);
      return;
    }

    // Handle different event types
    switch (e.type) {
      case Blockly.Events.BLOCK_CREATE:
        // New block created, update labels after a delay to ensure block is fully initialized
        console.log('Stack labels: Block created event for', e.blockId, 'isDragging:', this.isDragging_);
        // Always handle BLOCK_CREATE events to catch toolbox drags
        setTimeout(() => {
          const block = this.workspace_.getBlockById(e.blockId);
          console.log('Stack labels: Processing created block', e.blockId, 'exists:', !!block, 'isTopLevel:', block && !block.getParent());
          if (block && !block.getParent()) {
            console.log('Stack labels: New top-level block detected, updating all labels');
            this.updateAllStackLabels_();
          }
        }, 150); // Even longer delay for toolbox operations
        break;
      case Blockly.Events.BLOCK_DELETE:
        // Block deleted, update labels
        console.log('Stack labels: Block deleted event for', e.blockId);
        setTimeout(() => {
          this.removeOrphanedLabels_();
          this.updateAllStackLabels_();
        }, 10);
        break;
      case Blockly.Events.BLOCK_CHANGE:
        // Block changed (might affect whether it should have a label)
        console.log('Stack labels: Block changed event for', e.blockId);
        if (!this.isDragging_) {
          setTimeout(() => this.updateAllStackLabels_(), 10);
        }
        break;
      case Blockly.Events.BLOCK_MOVE:
        // Block moved, always update labels as connections might affect stack structure
        console.log('Stack labels: Block moved event for', e.blockId, 'oldParent:', e.oldParentId, 'newParent:', e.newParentId);
        setTimeout(() => {
          console.log('Stack labels: Processing BLOCK_MOVE - updating all labels');
          this.removeOrphanedLabels_();
          this.updateAllStackLabels_();
        }, 100); // Increased delay to ensure connections are complete
        break;
      default:
        // Catch any other events that might affect block connections (especially keyboard navigation)
        if (e.type && (e.type.includes('CONNECT') || e.type.includes('DISCONNECT') ||
                       e.type.includes('CONNECTION') || (e.blockId && !e.isUiEvent))) {
          console.log('Stack labels: Other connection event detected:', e.type, 'for block:', e.blockId);
          setTimeout(() => {
            this.updateAllStackLabels_();
          }, 150);
        }
        break;
    }
  }

  /**
   * Generate an alphabetic label from a numeric index.
   * @param {number} index The index to convert to a label.
   * @return {string} The alphabetic label.
   * @private
   */
  generateAlphabeticLabel_(index) {
    if (index < 0) return '';

    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let label = '';

    // Generate Excel-style column references
    let temp = index;
    do {
      // Get remainder for current letter position
      const remainder = temp % 26;
      // Add current letter to the label
      label = letters.charAt(remainder) + label;
      // Integer divide and subtract 1 to move to next position
      temp = Math.floor(temp / 26) - 1;
    } while (temp >= 0);

    return label;
  }

  /**
   * Generate the next available label for a stack.
   * @return {string} The next available label.
   * @private
   */
  getNextAvailableLabel_() {
    console.log('Getting next available label, used labels:',
      Array.from(this.usedLabels_).sort(),
      'nextLabelIndex:', this.nextLabelIndex_);

    // Start from index 0 (letter A) every time to fill gaps
    let index = 0;
    let attempts = 0;
    let label;

    // Keep trying labels until we find one that's not used
    while (true) {
      // Generate a label for the current index
      label = this.generateAlphabeticLabel_(index);

      // If the label isn't used, use it and return
      if (!this.usedLabels_.has(label)) {
        console.log(`Found unused label: ${label} at index ${index}`);
        // We don't update nextLabelIndex_ here anymore
        return label;
      }

      // Try the next index
      index++;
      attempts++;

      // Safety check to prevent infinite loops
      if (attempts > 100) {
        console.warn('Too many attempts to find unused label, forcing reset');
        this.usedLabels_.clear();
        return this.generateAlphabeticLabel_(0); // Return 'A'
      }
    }
  }

  /**
   * Alias for getNextAvailableLabel_ for backward compatibility.
   * @return {string} The next available letter label.
   * @private
   */
  getNextAvailableLetter_() {
    return this.getNextAvailableLabel_();
  }

  /**
   * Update accessibility attributes for all blocks in a stack.
   * @param {!Blockly.BlockSvg} startBlock The top block of the stack.
   * @param {string} label The stack's label.
   * @private
   */
  updateStackBlocksAccessibility_(startBlock, label) {
    // Start with the top block
    let currentBlock = startBlock;

    // Process each block in the stack
    while (currentBlock) {
      this.addStackAccessibilityToBlock_(currentBlock, label);

      // Move to the next block in the stack
      currentBlock = this.getNextBlockInStack_(currentBlock);
    }
  }

  /**
   * Add accessibility attributes to a block for its stack label.
   * @param {!Blockly.BlockSvg} block The block to add accessibility to.
   * @param {string} stackLabel The stack's label.
   * @private
   */
  addStackAccessibilityToBlock_(block, letterLabel) {
    try {
      // Get the block's text
      const blockText = typeof block.toString === 'function' ?
          block.toString(undefined, ' ').trim() : 'Block';

      // Get custom text if any
      const customText = stackName(block);
      const fullLabel = customText ? `${letterLabel} ${customText}` : letterLabel;

      // Get existing ARIA label if any
      const svgRoot = block.getSvgRoot();
      if (!svgRoot) return;

      let ariaLabel = svgRoot.getAttribute('aria-label') || blockText;

      // Check if the stack label is already in the ARIA label
      if (!ariaLabel.includes(`Stack ${letterLabel}:`)) {
        // Add stack label to the beginning of the ARIA label
        ariaLabel = `Stack ${fullLabel}: ${ariaLabel}`;
        svgRoot.setAttribute('aria-label', ariaLabel);

        // Also set a title for tooltip on hover
        if (customText) {
          svgRoot.setAttribute('title', `Stack ${fullLabel}`);
        }
      }
    } catch (e) {
      // Fail quietly if can't set ARIA label
      console.warn('Could not set stack label ARIA attribute', e);
    }
  }

  /**
   * Gets all top-level blocks in the workspace.
   * These are blocks that have no previous connection.
   * @return {!Array<!Blockly.BlockSvg>} The top-level blocks.
   * @private
   */
  getAllTopBlocks_() {
    if (!this.workspace_) return [];

    // Use Blockly's native getTopBlocks method which is more efficient
    // This returns blocks that aren't connected to other blocks above them
    return this.workspace_.getTopBlocks(false);
  }

  /**
   * Update all stack labels in the workspace.
   * @private
   */
  updateAllStackLabels_() {
    if (!this.workspace_ || !this.enabled_) {
      console.log('Stack labels: workspace or manager not available');
      return;
    }

    // Get all top blocks and sort them by position
    const topBlocks = this.getAllTopBlocks_();
    console.log('Stack labels: Found', topBlocks.length, 'top-level blocks:', topBlocks.map(b => b.type));

    // Clean up stale entries first
    this.cleanupLabelsAndMaps_();

    // Skip further processing if no blocks in workspace
    if (topBlocks.length === 0) {
      console.log('Stack labels: No top-level blocks found, skipping label creation');
      return;
    }

    // Sort blocks by position
    topBlocks.sort((a, b) => {
      const aPos = a.getRelativeToSurfaceXY();
      const bPos = b.getRelativeToSurfaceXY();

      // Sort by y position first, then x
      if (Math.abs(aPos.y - bPos.y) < 20) { // Consider blocks at similar heights as the same row
        return aPos.x - bPos.x;
      }
      return aPos.y - bPos.y;
    });

    // Track used labels to avoid duplicates
    const usedLabels = [];

    // Process each block
    for (const block of topBlocks) {
      console.log('Stack labels: Processing block', block.id, 'type:', block.type);

      // Skip if block no longer exists or has no ID
      if (!block || !block.id) {
        console.log('Stack labels: Skipping invalid block');
        continue;
      }

      // Check if this stack already has a label somewhere in the chain
      let existingLetter = null;
      let existingLabel = null;
      let existingBlockId = null;

      // Walk down the stack to find if any block has a label
      let currentBlock = block;
      while (currentBlock) {
        const blockLabel = this.stackLabels_.get(currentBlock.id);
        const blockLetter = this.stackLetters_.get(currentBlock.id);

        if (blockLabel && blockLetter) {
          existingLabel = blockLabel;
          existingLetter = blockLetter;
          existingBlockId = currentBlock.id;
          console.log(`Stack labels: Found existing label "${blockLetter}" on block ${currentBlock.id} in stack`);
          break;
        }

        // Move to next block in stack
        if (currentBlock.nextConnection && currentBlock.nextConnection.isConnected()) {
          currentBlock = currentBlock.nextConnection.targetBlock();
        } else {
          break;
        }
      }

      let label, letter;

      if (existingLabel && existingLetter) {
        // Stack already has a label, move it to the top block if needed
        if (existingBlockId !== block.id) {
          console.log(`Stack labels: Moving label "${existingLetter}" from block ${existingBlockId} to top block ${block.id}`);

          // Remove from old block
          this.stackLabels_.delete(existingBlockId);
          this.stackLetters_.delete(existingBlockId);

          // Move to new top block
          this.stackLabels_.set(block.id, existingLabel);
          this.stackLetters_.set(block.id, existingLetter);

          // Update label position
          this.positionLabelAboveBlock_(existingLabel, block);
        }

        label = existingLabel;
        letter = existingLetter;
      } else {
        letter = this.getNextAvailableLetter_();
        console.log('Stack labels: Assigned letter', letter, 'to block', block.id);


        // Create the label element
        label = this.createStackLabel_(block, letter);
        console.log('Stack labels: Created label element for block', block.id, 'with letter', letter);

        // Store the label and letter
        this.stackLabels_.set(block.id, label);
        this.stackLetters_.set(block.id, letter);
        this.usedLabels_.add(letter);
      }

      // Track used labels
      if (letter) {
        usedLabels.push(letter);
      }
    }
  }

  /**
   * Create a label element for a stack.
   * @param {!Blockly.BlockSvg} block The block to create a label for.
   * @param {string} letter The letter label.
   * @return {!SVGElement} The created label element.
   * @private
   */
  createStackLabel_(block, letter) {
    // Create a group element to contain both background and text
    const labelGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    labelGroup.setAttribute('class', 'blocklyStackLabel');
    labelGroup.setAttribute('data-block-id', block.id);

    // Create the background rectangle
    const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    background.setAttribute('rx', '8');
    background.setAttribute('ry', '8');
    background.setAttribute('fill', '#4285f4');
    background.setAttribute('stroke', '#1a73e8');
    background.setAttribute('stroke-width', '1');

    // Create the text element
    const textElement = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    textElement.setAttribute('text-anchor', 'middle');
    textElement.setAttribute('dominant-baseline', 'central');
    textElement.setAttribute('font-family', 'sans-serif');
    textElement.setAttribute('font-size', '12');
    textElement.setAttribute('font-weight', 'bold');
    textElement.setAttribute('fill', '#ffffff');

    // Add the text content
    const customText = stackName(block);
    const fullLabel = customText ? `${letter} ${customText}` : letter;
    textElement.textContent = fullLabel;

    // Size the background based on text
    const padding = 8;
    const textWidth = fullLabel.length * 8; // Approximate text width
    const textHeight = 16;

    background.setAttribute('width', textWidth + padding * 2);
    background.setAttribute('height', textHeight + padding);
    background.setAttribute('x', -(textWidth + padding * 2) / 2);
    background.setAttribute('y', -(textHeight + padding) / 2);

    // Add elements to group
    labelGroup.appendChild(background);
    labelGroup.appendChild(textElement);

    // Position it above the block
    this.positionLabelAboveBlock_(labelGroup, block);

    // Add to the workspace
    const workspace = this.workspace_.getCanvas();
    if (workspace) {
      workspace.appendChild(labelGroup);
    }

    return labelGroup;
  }

  /**
   * Get the next block in a stack.
   * @param {!Blockly.BlockSvg} block The current block.
   * @return {Blockly.BlockSvg|null} The next block in the stack or null.
   * @private
   */
  getNextBlockInStack_(block) {
    if (!block) return null;

    // Look for a next connection
    const nextConnection = block.nextConnection;
    if (nextConnection && nextConnection.isConnected()) {
      return nextConnection.targetBlock();
    }

    return null;
  }

  /**
   * Add a stack label to a block.
   * @param {!Blockly.BlockSvg} block The block to add a label to (top of stack).
   * @param {string} label The label to display.
   * @private
   */
  addLabel_(block, letterLabel) {
    // Remove any existing label
    this.removeLabel_(block.id);

    // Get any custom text for this block
    const customText = stackName(block);

    // Create the label with custom text if available
    const labelElement = this.createLabelElement_(letterLabel, customText, block.id);

    try {
      const blockSvg = block.getSvgRoot();
      if (blockSvg) {
        // Get the block's parent group
        const blockGroup = blockSvg.parentNode;
        if (blockGroup) {
          // Insert the label before the block SVG
          blockGroup.insertBefore(labelElement, blockSvg);

          // Position the label above the block
          this.positionLabelAboveBlock_(labelElement, block);

          // Store the label for later removal
          this.stackLabels_.set(block.id, labelElement);
        }
      }
    } catch (e) {
      console.warn('Could not add stack label to block', e);
    }
  }

  /**
   * Position the label above a block.
   * @param {!SVGElement} labelElement The label element.
   * @param {!Blockly.BlockSvg} block The block to position above.
   * @private
   */
  positionLabelAboveBlock_(labelElement, block) {
    try {
      // Get block position
      const blockBox = block.getBoundingRectangle();
      // Position the label above the red border area when stack is selected
      const x = blockBox.left;
      const y = blockBox.top - 18; // Position above the red border for clean appearance

      // Apply the transform to position the label
      labelElement.setAttribute('transform', `translate(${x}, ${y})`);
    } catch (e) {
      console.warn('Could not position label above block', e);

      try {
        // Fallback positioning using the block's SVG position
        const blockSvg = block.getSvgRoot();
        if (blockSvg) {
          const blockPos = blockSvg.getBoundingClientRect();
          const x = blockPos.left;
          const y = blockPos.top - 18;
          labelElement.setAttribute('transform', `translate(${x}, ${y})`);
        }
      } catch (innerError) {
        console.warn('Fallback positioning failed', innerError);
      }
    }
  }

  /**
   * Create an SVG element with a stack label.
   * @param {string} label The label text.
   * @return {!SVGElement} The label element.
   * @private
   */
  createLabelElement_(letter, customText = '', blockId) {
    const NS = Blockly.utils.dom.SVG_NS;

    // Create a group to hold the label
    const g = document.createElementNS(NS, 'g');
    g.classList.add('blockly-stack-label');
    g.style.cursor = 'pointer'; // Ensure pointer cursor even if CSS doesn't load

    // Set block ID as a data attribute so we can find it later
    if (blockId) {
      g.setAttribute('data-block-id', blockId);
    }

    // Determine full label text and calculate width
    const fullLabel = customText ? `${letter} ${customText}` : letter;

    // Calculate width based on label length, with a minimum width
    // The letter part gets fixed space, the custom text can wrap
    const maxLabelLength = 25; // Maximum characters to show before truncating
    const truncatedLabel = fullLabel.length > maxLabelLength ?
        fullLabel.substring(0, maxLabelLength - 3) + '...' : fullLabel;
    const width = Math.max(20 + truncatedLabel.length * 8, 40);

    // Create the label background
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('rx', '4');
    rect.setAttribute('ry', '4');
    rect.setAttribute('width', String(width));
    rect.setAttribute('height', '22');
    rect.setAttribute('fill', '#4285F4');
    rect.setAttribute('stroke', '#3267D6');
    rect.setAttribute('stroke-width', '1');
    g.appendChild(rect);

    // Create the text label
    // We'll style the letter and custom text differently
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', '8'); // Start from left with padding
    text.setAttribute('y', '16');
    text.setAttribute('font-size', '14');
    text.setAttribute('font-weight', 'bold');
    text.setAttribute('fill', 'white');
    text.setAttribute('text-anchor', 'start'); // Left-align text

    // Add the letter part
    const letterSpan = document.createElementNS(NS, 'tspan');
    letterSpan.textContent = letter; // This crucial line was missing!
    letterSpan.setAttribute('font-weight', 'bold');
    text.appendChild(letterSpan);

    // Add the custom text part if it exists
    if (customText) {
      const customSpan = document.createElementNS(NS, 'tspan');
      customSpan.textContent = ` ${truncatedLabel.substring(letter.length + 1)}`;
      customSpan.setAttribute('font-weight', 'normal');
      text.appendChild(customSpan);
    }

    g.appendChild(text);

    return g;
  }

  /**
   * Determines whether a block should be treated as a stack block.
   * A stack block is a block that can have statements attached to it,
   * typically a control flow block like a loop or conditional.
   * @param {!Blockly.BlockSvg} block The block to check.
   * @return {boolean} True if the block is a stack block.
   * @private
   */
  isStackBlock_(block) {
    // If block has a statement input, it's a stack block
    if (!block) return false;

    try {
      // Control flow blocks like loops and conditionals typically have statement inputs
      for (let i = 0; i < block.inputList.length; i++) {
        const input = block.inputList[i];
        if (input.type === Blockly.NEXT_STATEMENT) {
          return true;
        }
      }

      // Standalone blocks without statement inputs but that can connect to others
      // should also be considered stack blocks
      if (block.outputConnection === null &&
          (block.previousConnection || block.nextConnection)) {
        return true;
      }

      // Special case for procedure definitions which are also stack blocks
      if (block.type && block.type.indexOf('procedures_def') === 0) {
        return true;
      }
    } catch (e) {
      console.error('Error in isStackBlock_:', e);
    }

    return false;
  }

  /**
   * Determines whether a block is inside a collapsed block.
   * We don't want to show stack labels for blocks inside collapsed blocks
   * because they're not visible anyway.
   * @param {!Blockly.BlockSvg} block The block to check.
   * @return {boolean} True if the block is inside a collapsed block.
   * @private
   */
  isInsideCollapsedBlock_(block) {
    if (!block) return false;

    try {
      // Check if the block itself is collapsed
      if (block.isCollapsed && block.isCollapsed()) {
        return true;
      }

      // Check if any parent block is collapsed
      let parent = block.getParent();
      while (parent) {
        if (parent.isCollapsed && parent.isCollapsed()) {
          return true;
        }
        parent = parent.getParent();
      }
    } catch (e) {
      console.error('Error in isInsideCollapsedBlock_:', e);
    }

    return false;
  }

  removeLabel_(blockId) {
    // Remove the label from DOM if it exists
    const label = this.stackLabels_.get(blockId);
    if (label && label.parentNode) {
      label.parentNode.removeChild(label);
    }

    // Get the letter that was used for this block
    const letter = this.stackLetters_.get(blockId);
    if (letter) {
      // Remove from stack letters mapping
      this.stackLetters_.delete(blockId);
    }

    // Remove tracking entries
    this.stackLabels_.delete(blockId);
  }

  /**
   * Remove all labels from the workspace.
   * @private
   */
  removeAllLabels_() {
    for (const [blockId, label] of this.stackLabels_.entries()) {
      if (label && label.parentNode) {
        label.parentNode.removeChild(label);
      }
    }
    this.stackLabels_.clear();
  }

  /**
   * Clean up labels and maps by removing entries for blocks that no longer exist.
   * @private
   */
  cleanupLabelsAndMaps_() {
    // Clean up stack labels and letters for blocks that don't exist anymore
    const toDelete = [];

    // Iterate through all stack letters to find orphaned ones
    for (const [blockId, letter] of this.stackLetters_.entries()) {
      const block = this.workspace_.getBlockById(blockId);

      // If block exists and is a top level block, keep its letter
      if (block && !block.getParent() && this.isStackBlock_(block)) {
        // Block still exists as a valid top-level stack block, keep its letter
        console.log('Keeping letter', letter, 'for block', blockId);
      } else {
        // Mark for deletion - don't delete while iterating
        toDelete.push([blockId, letter]);
      }
    }

    // Now delete the entries we marked
    for (const [blockId, letter] of toDelete) {
      console.log('Removing unused letter', letter, 'for non-existent/invalid block', blockId);
      this.usedLabels_.delete(letter);
      this.stackLetters_.delete(blockId);
      // Also remove from stackLabels_ map if present
      if (this.stackLabels_.has(blockId)) {
        const label = this.stackLabels_.get(blockId);
        if (label && label.parentNode) {
          label.parentNode.removeChild(label);
        }
        this.stackLabels_.delete(blockId);
      }
    }

    // Now rebuild usedLabels_ from stackLetters_ to ensure they're in sync
    this.usedLabels_.clear();
    for (const letter of this.stackLetters_.values()) {
      this.usedLabels_.add(letter);
    }

    // Call the specific cleanup methods for thoroughness
    this.removeOrphanedLabels_();

    console.log('Cleaned up used labels, remaining:', Array.from(this.usedLabels_));
    console.log('Cleaned up stack letters map:', Array.from(this.stackLetters_.entries()));
  }


  /**
   * Remove any orphaned label DOM elements that don't correspond to valid blocks.
   * This prevents labels from getting stuck on the workspace after block operations.
   * @private
   */
  removeOrphanedLabels_() {
    // First remove any labels whose block doesn't exist anymore
    for (const [blockId, label] of this.stackLabels_.entries()) {
      const block = this.workspace_.getBlockById(blockId);
      if (!block) {
        if (label && label.parentNode) {
          console.log('Removing orphaned label for non-existent block:', blockId);
          label.parentNode.removeChild(label);
        }
        this.stackLabels_.delete(blockId);
        this.stackLetters_.delete(blockId);
        this.usedLabels_.delete(this.stackLetters_.get(blockId));
      } else if (block && block.getParent()) {
        // If the block exists but has a parent, it's not a top-level block anymore
        // so it shouldn't have its own stack label
        if (label && label.parentNode) {
          console.log('Removing label for connected block:', blockId);
          label.parentNode.removeChild(label);
        }
        const letter = this.stackLetters_.get(blockId);
        this.stackLabels_.delete(blockId);
        this.stackLetters_.delete(blockId);
      }
    }

    // Also check the DOM for any label elements that might be orphaned
    // This is a safety measure to clean up the workspace
    try {
      const svgContainer = this.workspace_.getParentSvg().parentNode;
      const labelElements = svgContainer.querySelectorAll('.blockly-stack-label');

      for (const element of labelElements) {
        // Try to get the block ID from the element or data attribute
        let blockId = element.getAttribute('data-block-id');

        if (!blockId) {
          // If no data-block-id, this is an orphaned element
          if (element.parentNode) {
            console.log('Removing orphaned stack label element with no ID');
            element.parentNode.removeChild(element);
          }
          continue;
        }

        const block = this.workspace_.getBlockById(blockId);
        if (!block || block.getParent() || !this.stackLabels_.has(blockId)) {
          // If no block with this ID exists or the block is not a top block
          // or the block is no longer tracked as having a label, remove the element
          console.log('Removing orphaned stack label element:', blockId);
          if (element.parentNode) {
            element.parentNode.removeChild(element);
          }
        }
      }
    } catch (e) {
      console.warn('Error cleaning up orphaned labels:', e);
    }
  }

  /**
   * Get the stack label for a block.
   * @param {string} blockId The ID of the block.
   * @return {string|undefined} The stack label or undefined if not found.
   */
  getStackLabel(blockId) {
    // First check if this is a top block
    if (this.stackLetters_.has(blockId)) {
      const letter = this.stackLetters_.get(blockId);
      const customText = stackName(this.workspace_.getBlockById(blockId));
      return customText ? `${letter} ${customText}` : letter;
    }

    // If not a top block, find which stack it belongs to
    // This is a simplified approach - in practice we'd want to traverse up
    // to find the top block of the stack this block belongs to
    return undefined;
  }

  /**
   * Update the stack labels when a workspace event occurs.
   * Public method that can be called externally.
   */
  update() {
    this.updateAllStackLabels_();
  }


  /**
   * Unregister the edit label keyboard shortcut.
   * @private
   */
  unregisterEditLabelShortcut_() {
    // If we've stored a bound handler, remove it from the document
    if (this.editShortcutHandler_) {
      document.removeEventListener('keydown', this.editShortcutHandler_);
      this.editShortcutHandler_ = null;
    }
  }


  /**
   * Reset the stack label state, clearing all internal tracking.
   * This should be called when a new program is loaded to ensure
   * stack labels start from "A" again.
   * @public
   */
  resetState() {
    // Reset the next label index to 0 (which corresponds to "A")
    this.nextLabelIndex_ = 0;

    // Clear all tracking sets and maps
    this.usedLabels_.clear();
    this.stackLetters_.clear();
    // Remove all label DOM elements
    for (const [blockId, label] of this.stackLabels_.entries()) {
      if (label && label.parentNode) {
        label.parentNode.removeChild(label);
      }
    }

    // Clear the labels map
    this.stackLabels_.clear();

    console.log('Stack label state fully reset - next label will be "A"');

    // Force update all stack labels after a short delay to ensure DOM is ready
    setTimeout(() => {
      if (this.enabled_ && this.workspace_) {
        this.updateAllStackLabels_();
      }
    }, 50);
  }

  /**
   * Update positions of all stack labels without reassigning them.
   * This ensures labels move with their blocks when blocks are moved.
   * @private
   */
  updateLabelPositions_() {
    if (!this.workspace_ || !this.enabled_) return;

    // Iterate through all blocks that have labels
    for (const [blockId, labelElement] of this.stackLabels_.entries()) {
      const block = this.workspace_.getBlockById(blockId);

      // Skip if block doesn't exist anymore
      if (!block) continue;

      // Update the position of the label
      this.positionLabelAboveBlock_(labelElement, block);
    }
  }

  /**
   * Handle workspace change events, particularly to detect program loading and block moves.
   * @param {!Blockly.Events.Abstract} event The change event.
   * @private
   */
  onWorkspaceChange_(event) {
    // Only listen for finished loads
    if (event.type === Blockly.Events.FINISHED_LOADING) {
      // Reset the label counter to ensure labels always start from A after loading
      this.resetState();

      // Update all stack labels - only once after load
      this.updateAllStackLabels_();
    } else if (event.type === Blockly.Events.BLOCK_MOVE) {
      // When blocks are moved, update label positions but don't reassign labels
      this.updateLabelPositions_();
    }
  }

  /**
   * Handle UI events from Blockly, specifically for dragging blocks.
   * @param {!Blockly.Events.Abstract} event The UI event.
   * @private
   */
  onUiEvent_(event) {
    // Only handle events for this workspace

    if (e.element === 'selected' || e.element === 'drag') {
      // Update label positions without waiting for the drag to end
      // This provides real-time updating of label positions during drag
      this.updateLabelPositions_();
    }

    // Check for workspace changes that might indicate new blocks
    if (e.element === 'dragStop' || e.element === 'click') {
      console.log('Stack labels: Checking for new blocks after UI event');
      setTimeout(() => {
        this.updateAllStackLabels_();
      }, 100);
    }
  }

}

/**
 * Singleton instance of the StackLabelManager.
 * @type {StackLabelManager}
 */
let stackLabelManagerInstance = null;

// Add stack label styles and increase block number font size by 20%
document.head.insertAdjacentHTML('beforeend', `
<style>
  .blockly-stack-label {
    cursor: pointer;
  }
  
  .blockly-stack-label:hover rect {
    filter: brightness(1.1);
  }
  
  .blockly-stack-label-editor {
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  
  .blockly-block-number text {
    font-size: 16.8px; /* Increased from 14px by 20% */
  }
</style>
`);

/**
 * Initialize stack labels for a workspace.
 * @param {!Blockly.WorkspaceSvg} workspace The workspace to initialize labels on.
 * @return {!StackLabelManager} The stack label manager instance.
 */
export function initStackLabels(workspace) {
  // Validate workspace
  if (!workspace || !workspace.id) {
    console.error('🚫 Cannot initialize stack labels: invalid workspace');
    return null;
  }

  // Check if an instance already exists for this workspace
  let manager = stackLabelManagerRegistry.get(workspace.id);

  // If no instance exists, create one
  if (!manager) {
    // Create a new manager instance
    manager = new StackLabelManager(workspace);
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
 * Dispose of the stack label manager for a specific workspace.
 * @param {!Blockly.WorkspaceSvg} workspace The workspace to dispose labels for.
 */
export function disposeStackLabels(workspace) {
  if (!workspace || !workspace.id) return;

  const manager = stackLabelManagerRegistry.get(workspace.id);
  if (manager) {
    manager.dispose();
    // The dispose method will remove the instance from the registry
  }
}

/**
 * Reset stack label counter to start labeling from 'A' again.
 * Call this whenever a new program is loaded to ensure stack labels
 * start from the beginning.
 * @param {!Blockly.WorkspaceSvg} workspace The workspace to reset labels for.
 */
export function resetStackLabels(workspace) {
  if (!workspace || !workspace.id) return;

  const manager = stackLabelManagerRegistry.get(workspace.id);
  if (manager) {
    manager.resetState();
  }
}
