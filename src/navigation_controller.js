import './gesture_monkey_patch';

import * as Blockly from 'blockly/core';
import * as Constants from './constants';
import {Navigation} from './navigation';
import {AccessibleCursor} from "./cursors/accessible_cursor";
import {Speech} from "./audio/speech";
import {initBlockNumbers, disposeBlockNumbers} from './labels_and_comments/block_numbers';
import {
  initStackLabels,
  disposeStackLabels,
  getStackLabelManager,
  getStackLabelFromStackNode
} from './labels_and_comments/stack_labels.js';
import {initStackSearch, disposeStackSearch, getStackSearchManager} from './labels_and_comments/stack_search.js';
import {ShortcutAssistance} from "./util/shortcut_assistance";
import {NavigationalHint} from "./util/navigational_hint";
import {ZoomingControl} from './util/zooming_controls';
import {ModeBadge} from './util/mode_badge';
import {observeProperty} from './util/observe';
import {FlyoutCompatibilityManager} from "./util/flyout_compatibility_manager"
import {WorkspaceContainerFilter} from "./util/workspace_flyout_manager";
import {blockTypes} from './blocks/registry';

/**
 * Class for registering shortcuts for keyboard navigation.
 */
export class NavigationController {
  /** Data copied by the copy or cut keyboard shortcuts. */
  copyData = null;

  /** The workspace a copy or cut keyboard shortcut happened in. */
  copyWorkspace = null;

  detachedBlock = null;

  detachedWorkspace = null;

  /**
   * Constructor used for registering shortcuts.
   * This will register any default shortcuts for keyboard navigation.
   * This is intended to be a singleton.
   * @param accessibility
   * @param {!Navigation=} optNavigation The class that handles keyboard
   *     navigation shortcuts. (Ex: inserting a block, focusing the flyout).
   */
  constructor(accessibility = true, optNavigation) {
    /**
     * Handles any keyboard navigation shortcuts.
     * @type {!Navigation}
     * @public
     */
    this.navigation = optNavigation || new Navigation();
    if (accessibility) {
      this.accessibleCursor = new AccessibleCursor();
      this.speech = new Speech();
      this.accessibleCursor.setSpeechListener(this.speech);
      this.shortcutAssistance = new ShortcutAssistance(this.speech);
      this.navHint = new NavigationalHint({ speech: this.speech });
      /** Visible Navigation/Edit mode cue; hosts can call modeBadge.setEnabled(false). */
      this.modeBadge = new ModeBadge();
    }
    this.keyHintListener = null;
    this.zooming = new ZoomingControl(this.speech);
    this.flyoutCompatibilityMgr = new FlyoutCompatibilityManager();
    this.workspaceContainerFilter = new WorkspaceContainerFilter();
  }

  /**
   * Registers the default keyboard shortcuts for keyboard navigation.
   * @public
   */
  init() {
    this.addShortcutHandlers();
    this.registerDefaults();
    this.lockMovesWhileEditing_();
  }

  /**
   * Some blocks (e.g. a learner's question) are edited as a whole: while Edit
   * mode is on them, moving between their connections is refused with the
   * block type's hint. Only in the workspace; the toolbox and flyout keep their keys.
   */
  lockMovesWhileEditing_() {
    const names = [
      Constants.SHORTCUT_NAMES.PREVIOUS, Constants.SHORTCUT_NAMES.NEXT,
      Constants.SHORTCUT_NAMES.OUT, Constants.SHORTCUT_NAMES.IN,
      Constants.SHORTCUT_NAMES.LAYER_IN, Constants.SHORTCUT_NAMES.LAYER_OUT,
      Constants.SHORTCUT_NAMES.DISCONNECT, Constants.SHORTCUT_NAMES.PASTE,
      Constants.SHORTCUT_NAMES.MOVE_STATEMENT_UP, Constants.SHORTCUT_NAMES.MOVE_STATEMENT_DOWN,
    ];
    const registry = Blockly.ShortcutRegistry.registry;
    const shortcuts = registry.getRegistry();
    for (const name of names) {
      const shortcut = shortcuts[name];
      if (!shortcut?.callback) continue;
      const original = shortcut.callback;
      registry.register({
        ...shortcut,
        callback: (workspace, ...rest) => {
          const hint = this.editLockHint_(workspace);
          if (!hint) return original(workspace, ...rest);
          this.speech?.update(`You can't move inside it. ${hint}`);
          return true;
        },
      }, /* allowOverrides= */ true);
    }
  }

  /** @returns {?string} The hint when Edit mode is on a block that is edited as a whole. */
  editLockHint_(workspace) {
    if (this.navigation.getState(workspace) !== Constants.STATE.WORKSPACE) return null;
    const cursor = workspace.getCursor?.();
    if (!cursor?.editMode) return null;
    return blockTypes.editLock(cursor.editingBlock?.getSourceBlock?.() || null);
  }

  addKeyHintListener(keyHint) {
    if (typeof keyHint === 'function') {
      this.keyHintListener = keyHint;
    }
  }

  emitKeyHints(workspace) {
    const hints = this.navHint.compute(workspace);
    if (this.keyHintListener) {
      try {
        this.keyHintListener(hints);
      } catch (e) {
        console.error('keyHint listener error:', e);
      }
    }
    try { this.navHint?.setHints(hints); } catch {}
  }

  patchCursor(workspace) {
    const cursor = workspace?.getCursor?.();
    if (!cursor || cursor.__keyHintPatched) return;

    const intercept = (targetObj, method) => {
      const origMethod = targetObj[method];
      if (typeof origMethod !== 'function') return;
      targetObj[method] = (...args) => {
        const previousNode = cursor.getCurNode?.();
        const result = origMethod.apply(targetObj, args);
        const currentNode = cursor.getCurNode?.();
        if (previousNode !== currentNode) {
          this.emitKeyHints(workspace);
        }
        return result;
      };
    };

    intercept(cursor, 'setCurNode');
    intercept(cursor, 'prev');
    intercept(cursor, 'next');
    intercept(cursor, 'in');
    intercept(cursor, 'out');
    intercept(cursor, 'layerIn');
    intercept(cursor, 'layerOut');

    cursor.__keyHintPatched = true;
  }

  /**
   * Adds methods to core Blockly components that allows them to handle keyboard
   * shortcuts when in keyboard navigation mode.
   * @protected
   */
  addShortcutHandlers() {
    if (Blockly.FieldDropdown) {
      Blockly.FieldDropdown.prototype.onShortcut = this.fieldDropdownHandler;
    }

    if (Blockly.Toolbox) {
      Blockly.Toolbox.prototype.onShortcut = this.toolboxHandler;
    }
  }

  /**
   * Removes methods on core Blockly components that allows them to handle
   * keyboard shortcuts.
   * @protected
   */
  removeShortcutHandlers() {
    if (Blockly.FieldDropdown) {
      Blockly.FieldDropdown.prototype.onShortcut = null;
    }

    if (Blockly.Toolbox) {
      Blockly.Toolbox.prototype.onShortcut = null;
    }
  }

  /**
   * Handles the given keyboard shortcut.
   * This is only triggered when keyboard accessibility mode is enabled.
   * @param {!Blockly.ShortcutRegistry.KeyboardShortcut} shortcut The shortcut
   *     to be handled.
   * @returns {boolean} True if the field handled the shortcut,
   *     false otherwise.
   * @this {Blockly.FieldDropdown}
   * @protected
   */
  fieldDropdownHandler(shortcut) {
    if (this.menu_) {
      switch (shortcut.name) {
        case Constants.SHORTCUT_NAMES.PREVIOUS:
          this.menu_.highlightPrevious();
          return true;
        case Constants.SHORTCUT_NAMES.NEXT:
          this.menu_.highlightNext();
          return true;
        default:
          return false;
      }
    }
    // If we haven't already handled the shortcut, let the default Field
    // handler try.
    return Blockly.Field.prototype.onShortcut.call(this, shortcut);
  }

  /**
   * Handles the given keyboard shortcut.
   * This is only triggered when keyboard accessibility mode is enabled.
   * @param {!Blockly.ShortcutRegistry.KeyboardShortcut} shortcut The shortcut
   *     to be handled.
   * @returns {boolean} True if the toolbox handled the shortcut,
   *     false otherwise.
   * @this {Blockly.Toolbox}
   * @protected
   */
  toolboxHandler(shortcut) {
    if (!this.selectedItem_) {
      return false;
    }
    switch (shortcut.name) {
      case Constants.SHORTCUT_NAMES.PREVIOUS:
        return this.selectPrevious();
      case Constants.SHORTCUT_NAMES.OUT:
        return this.selectParent();
      case Constants.SHORTCUT_NAMES.NEXT:
        return this.selectNext();
      case Constants.SHORTCUT_NAMES.IN:
        return this.selectChild();
      default:
        return false;
    }
  }

  /**
   * Adds all necessary event listeners and markers to a workspace for keyboard
   * navigation to work. This must be called for keyboard navigation to work
   * on a workspace.
   * @param {!Blockly.WorkspaceSvg} workspace The workspace to add keyboard
   *     navigation to.
   * @public
   */
  addWorkspace(workspace) {
    this.navigation.addWorkspace(workspace);
    if (this.accessibleCursor) {
      const markerManager = Blockly.getMainWorkspace().getMarkerManager();
      markerManager.setCursor(this.accessibleCursor);
      this.modeBadge.attach(workspace, this.accessibleCursor);
      blockTypes.setNavigationHost(this);
      const cursor = this.accessibleCursor;
      const syncEditTarget = () => blockTypes.editTargetChanged(workspace,
          cursor.editMode ? cursor.editingBlock?.getSourceBlock?.() || null : null);
      this.editWatchers_ = [
        observeProperty(cursor, 'editMode', syncEditTarget),
        observeProperty(cursor, 'editingBlock', syncEditTarget),
      ];
    }

    // Initialize block numbers and stack labels
    initBlockNumbers(workspace);
    // Initialize stack labels for this workspace
    initStackLabels(workspace);
    // Initialize stack search for this workspace
    initStackSearch(workspace, this.speech);

    this.shortcutAssistance?.init();
    this.navHint?.init();

    this.patchCursor(workspace);
    this.emitKeyHints(workspace);
  }

  /**
   * Turns on keyboard navigation.
   * @param {!Blockly.WorkspaceSvg} workspace The workspace to turn on keyboard
   *     navigation for.
   * @public
   */
  enable(workspace) {
    this.navigation.enableKeyboardAccessibility(workspace);
  }

  /**
   * Turns off keyboard navigation.
   * @param {!Blockly.WorkspaceSvg} workspace The workspace to turn off keyboard
   *     navigation on.
   * @public
   */
  disable(workspace) {
    this.navigation.disableKeyboardAccessibility(workspace);
  }

  /**
   * Gives the cursor to the field to handle if the cursor is on a field.
   * @param {!Blockly.WorkspaceSvg} workspace The workspace to check.
   * @param {!Blockly.ShortcutRegistry.KeyboardShortcut} shortcut The shortcut
   *     to give to the field.
   * @returns {boolean} True if the shortcut was handled by the field, false
   *     otherwise.
   * @protected
   */
  fieldShortcutHandler(workspace, shortcut) {
    const cursor = workspace.getCursor();
    if (!cursor || !cursor.getCurNode()) {
      return false;
    }
    const curNode = cursor.getCurNode();
    if (curNode.getType() === Blockly.ASTNode.types.FIELD) {
      return /** @type {!Blockly.Field} */ (curNode.getLocation()).onShortcut(
          shortcut,
      );
    }
    return false;
  }

  /**
   * Keyboard shortcut to go to the previous location when in keyboard
   * navigation mode.
   * @protected
   */
  registerPrevious() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const previousShortcut = {
      name: Constants.SHORTCUT_NAMES.PREVIOUS,
      preconditionFn: (workspace) => {
        return workspace.keyboardAccessibilityMode;
      },
      callback: (workspace, e, shortcut) => {
        const flyout = workspace.getFlyout();
        const toolbox = workspace.getToolbox();
        let isHandled = false;
        switch (this.navigation.getState(workspace)) {
          case Constants.STATE.WORKSPACE:
            isHandled = this.fieldShortcutHandler(workspace, shortcut);
            if (!isHandled) {
              let node = workspace.getCursor().prev();
              if (node?.getType() === Blockly.ASTNode.types.STACK) {
                let stackLabel = getStackLabelFromStackNode(node, workspace);
                this.speech.updateBlockReader(null, stackLabel ? node.getType() + " " +stackLabel : node.getType(), null, Constants.SHORTCUT_NAMES.LAYER_OUT, Constants.STATE.WORKSPACE);
              } else {
                this.speech.process(node, Constants.SHORTCUT_NAMES.PREVIOUS, Constants.STATE.WORKSPACE);
              }
              isHandled = true;
            }
            return isHandled;
          case Constants.STATE.FLYOUT:
            isHandled = this.fieldShortcutHandler(workspace, shortcut);
            if (!isHandled) {
              let node = null;
              let flyoutCursor = flyout.getWorkspace().getCursor();
              if (flyoutCursor) {
                const prevNode = flyoutCursor.prev();
                this._centerFlyoutOnNode(workspace, prevNode);
                node = prevNode ? prevNode.in() : null;
              }
              this.speech.announceFlyoutItem(
                  node,
                  Constants.SHORTCUT_NAMES.PREVIOUS
              );
              isHandled = true;
            }
            return isHandled;
          case Constants.STATE.TOOLBOX:
            if (toolbox && typeof toolbox.onShortcut === 'function') {
              const handled = toolbox.onShortcut(shortcut);
              if (handled) {
                this.speech.announceCategory(toolbox.getSelectedItem(), Constants.SHORTCUT_NAMES.PREVIOUS);
                this.applyToolboxFilter(workspace);
              }
              return handled;
            }
            return false;
            // return toolbox && typeof toolbox.onShortcut == 'function'
            //     ? toolbox.onShortcut(shortcut)
            //     : false;
          default:
            return false;
        }
      },
    };

    Blockly.ShortcutRegistry.registry.register(previousShortcut);
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        Blockly.utils.KeyCodes.W,
        previousShortcut.name,
    );
  }

  /**
   * Keyboard shortcut to turn keyboard navigation on or off.
   * @protected
   */
  registerToggleKeyboardNav() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const toggleKeyboardNavShortcut = {
      name: Constants.SHORTCUT_NAMES.TOGGLE_KEYBOARD_NAV,
      callback: (workspace) => {
        if (workspace.keyboardAccessibilityMode) {
          this.navigation.disableKeyboardAccessibility(workspace);
          this.speech.update("Keyboard navigation disabled");
        } else {
          this.navigation.enableKeyboardAccessibility(workspace);
          this.speech.update("Keyboard navigation enabled");
        }
        return true;
      },
    };

    Blockly.ShortcutRegistry.registry.register(toggleKeyboardNavShortcut);
    const ctrlShiftK = Blockly.ShortcutRegistry.registry.createSerializedKey(
        Blockly.utils.KeyCodes.K,
        [Blockly.utils.KeyCodes.CTRL, Blockly.utils.KeyCodes.SHIFT],
    );
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        ctrlShiftK,
        toggleKeyboardNavShortcut.name,
    );
  }

  /**
   * Keyboard shortcut to go to the out location when in keyboard navigation
   * mode.
   * @protected
   */
  registerOut() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const outShortcut = {
      name: Constants.SHORTCUT_NAMES.OUT,
      preconditionFn: (workspace) => {
        return workspace.keyboardAccessibilityMode;
      },
      callback: (workspace, e, shortcut) => {
        const toolbox = workspace.getToolbox();
        let isHandled = false;
        switch (this.navigation.getState(workspace)) {
          case Constants.STATE.WORKSPACE:
            isHandled = this.fieldShortcutHandler(workspace, shortcut);
            if (!isHandled) {
              let node = workspace.getCursor().out();
              this.speech.process(node, Constants.SHORTCUT_NAMES.OUT, Constants.STATE.WORKSPACE);
              isHandled = true;
            }
            return isHandled;
          case Constants.STATE.FLYOUT:
            this.navigation.focusToolbox(workspace);
            const category = workspace.getToolbox()?.getSelectedItem();
            this.speech.announceCategory(category, Constants.SHORTCUT_NAMES.OUT);
            return true;
          case Constants.STATE.TOOLBOX:
            return toolbox && typeof toolbox.onShortcut == 'function'
                ? toolbox.onShortcut(shortcut)
                : false;
          default:
            return false;
        }
      },
    };

    Blockly.ShortcutRegistry.registry.register(outShortcut);
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        Blockly.utils.KeyCodes.A,
        outShortcut.name,
    );
  }

  _centerFlyoutOnNode(workspace, node) {
    const flyoutWS = workspace.getFlyout?.()?.getWorkspace?.();
    if (!flyoutWS || !node) return;

    const type = node.getType?.();
    if (type === Blockly.ASTNode.types.STACK || type === Blockly.ASTNode.types.BLOCK) {
      const block = node.getLocation?.();
      if (block?.id) {
        flyoutWS.centerOnBlock(block.id,true);
      }
    }
  }


  /**
   * Keyboard shortcut to go to the next location when in keyboard navigation
   * mode.
   * @protected
   */
  registerNext() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const nextShortcut = {
      name: Constants.SHORTCUT_NAMES.NEXT,
      preconditionFn: (workspace) => {
        return workspace.keyboardAccessibilityMode;
      },
      callback: (workspace, e, shortcut) => {
        const toolbox = workspace.getToolbox();
        const flyout = workspace.getFlyout();
        let isHandled = false;
        switch (this.navigation.getState(workspace)) {
          case Constants.STATE.WORKSPACE:
            isHandled = this.fieldShortcutHandler(workspace, shortcut);
            if (!isHandled) {
              let node = workspace.getCursor().next();
              if (node?.getType() === Blockly.ASTNode.types.STACK) {
                let stackLabel = getStackLabelFromStackNode(node, workspace);
                this.speech.updateBlockReader(null, stackLabel ? node.getType() + " " +stackLabel : node.getType(), null, Constants.SHORTCUT_NAMES.LAYER_OUT, Constants.STATE.WORKSPACE);
              } else {
                this.speech.process(node, Constants.SHORTCUT_NAMES.NEXT, Constants.STATE.WORKSPACE);
              }
              isHandled = true;
            }
            return isHandled;
          case Constants.STATE.FLYOUT:
            isHandled = this.fieldShortcutHandler(workspace, shortcut);
            if (!isHandled) {
              let node = null;
              let flyoutCursor = flyout.getWorkspace().getCursor();
              if (flyoutCursor) {
                const nextNode = flyoutCursor.next();
                this._centerFlyoutOnNode(workspace, nextNode);
                node = nextNode ? nextNode.in() : null;
              }
              this.speech.announceFlyoutItem(
                  node,
                  Constants.SHORTCUT_NAMES.NEXT
              );
              isHandled = true;
            }
            return isHandled;
          case Constants.STATE.TOOLBOX:
            if (toolbox && typeof toolbox.onShortcut === 'function') {
              const handled = toolbox.onShortcut(shortcut);
              if (handled) {
                this.speech.announceCategory(toolbox.getSelectedItem(), Constants.SHORTCUT_NAMES.NEXT);
                this.applyToolboxFilter(workspace);
              }
              return handled;
            }
            return false;
          default:
            return false;
        }
      },
    };

    Blockly.ShortcutRegistry.registry.register(nextShortcut);
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        Blockly.utils.KeyCodes.S,
        nextShortcut.name,
    );
  }

  /**
   * Keyboard shortcut to go to the in location when in keyboard navigation
   * mode.
   * @protected
   */
  registerIn() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const inShortcut = {
      name: Constants.SHORTCUT_NAMES.IN,
      preconditionFn: (workspace) => {
        return workspace.keyboardAccessibilityMode;
      },
      callback: (workspace, e, shortcut) => {
        const toolbox = workspace.getToolbox();
        const flyout = workspace.getFlyout();
        let isHandled = false;
        switch (this.navigation.getState(workspace)) {
          case Constants.STATE.WORKSPACE:
            isHandled = this.fieldShortcutHandler(workspace, shortcut);
            if (!isHandled) {
              let node = workspace.getCursor().in();
              this.speech.process(node, Constants.SHORTCUT_NAMES.IN, Constants.STATE.WORKSPACE);
              isHandled = true;
            }
            return isHandled;
          case Constants.STATE.TOOLBOX:
            isHandled =
                toolbox && typeof toolbox.onShortcut == 'function'
                    ? toolbox.onShortcut(shortcut)
                    : false;
            if (!isHandled) {
              this.navigation.focusFlyout(workspace);
              let node = null;
              let flyoutCursor = flyout.getWorkspace().getCursor();
              if (flyoutCursor) {
                const curNode = flyoutCursor.getCurNode();
                node = curNode ? curNode.in() : null;
              }
              this.speech.announceFlyoutItem(
                  node,
                  Constants.SHORTCUT_NAMES.IN
              );
            }
            return true;
          default:
            return false;
        }
      },
    };

    Blockly.ShortcutRegistry.registry.register(inShortcut);
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        Blockly.utils.KeyCodes.D,
        inShortcut.name,
    );
  }

  _isSelectionOnDetached(workspace) {
    const det = this.detachedBlock;
    if (!det || det.isDisposed?.()) return false;

    const cursor  = workspace.getCursor?.();
    const curNode = cursor?.getCurNode?.();
    if (!curNode) return false;

    const nodeBlock =
        curNode.getSourceBlock?.() ||
        (curNode.getLocation?.() && curNode.getLocation().getSourceBlock?.()) ||
        null;

    if (!nodeBlock) return false;

    // check if root is the detached block
    const root = nodeBlock.getRootBlock?.();
    return !!(root && root.id === det.id);
  }

  /**
   * Keyboard shortcut to layer in to the location when in keyboard navigation
   * mode.
   * @protected
   */
  registerLayerIn() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const inShortcut = {
      name: Constants.SHORTCUT_NAMES.LAYER_IN,
      preconditionFn: (workspace) => {
        return workspace.keyboardAccessibilityMode;
      },
      callback: (workspace, e, shortcut) => {
        const toolbox = workspace.getToolbox();
        let isHandled = false;
        switch (this.navigation.getState(workspace)) {
          case Constants.STATE.WORKSPACE:
            if (this._isSelectionOnDetached(workspace)) {
              this.speech.update('This is the detached block. Attach it to a connection before navigating inside.');
              return true;
            }
            isHandled = this.fieldShortcutHandler(workspace, shortcut);
            if (!isHandled) {
              let node = workspace.getCursor().layerIn();
              if (node?.getType() === Blockly.ASTNode.types.STACK) {
                let stackLabel = getStackLabelFromStackNode(node, workspace);
                this.speech.updateBlockReader(null, stackLabel ? node.getType() + " " +stackLabel : node.getType(), null, Constants.SHORTCUT_NAMES.LAYER_OUT, Constants.STATE.WORKSPACE);
              } else {
                this.speech.process(node, Constants.SHORTCUT_NAMES.LAYER_IN, Constants.STATE.WORKSPACE);
              }
              isHandled = true;
            }
            return isHandled;
          case Constants.STATE.TOOLBOX:
            isHandled = false;
            if (!isHandled) {
              this.navigation.focusFlyout(workspace);
              this.applyToolboxFilter(workspace);
            }
            return true;
          default:
            return false;
        }
      },
    };

    Blockly.ShortcutRegistry.registry.register(inShortcut);
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        Blockly.utils.KeyCodes.F,
        inShortcut.name,
    );
  }

  /**
   * Keyboard shortcut to layer out to the prev location when in keyboard navigation
   * mode.
   * @protected
   */
  registerLayerOut() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const inShortcut = {
      name: Constants.SHORTCUT_NAMES.LAYER_OUT,
      preconditionFn: (workspace) => {
        return workspace.keyboardAccessibilityMode;
      },
      callback: (workspace, e, shortcut) => {
        const toolbox = workspace.getToolbox();
        let isHandled = false;
        switch (this.navigation.getState(workspace)) {
          case Constants.STATE.WORKSPACE:
            isHandled = this.fieldShortcutHandler(workspace, shortcut);
            if (!isHandled) {
              let node = workspace.getCursor().layerOut();
              if (node?.getType() === Blockly.ASTNode.types.STACK) {
                let stackLabel = getStackLabelFromStackNode(node, workspace);
                this.speech.updateBlockReader(null, node.getType() + " " +stackLabel ? node.getType() + " " + stackLabel : node.getType(), null, Constants.SHORTCUT_NAMES.LAYER_OUT, Constants.STATE.WORKSPACE);
              } else {
                this.speech.process(node, Constants.SHORTCUT_NAMES.LAYER_OUT, Constants.STATE.WORKSPACE);
              }
              isHandled = true;
            }
            return isHandled;
          case Constants.STATE.TOOLBOX:
            isHandled = false;
            if (!isHandled) {
              this.navigation.focusFlyout(workspace);
            }
            return true;
          default:
            return false;
        }
      },
    };

    Blockly.ShortcutRegistry.registry.register(inShortcut);
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        Blockly.utils.KeyCodes.Q,
        inShortcut.name,
    );
  }

  /**
   * Keyboard shortcut to connect a block to a marked location when in keyboard
   * navigation mode.
   * @protected
   */
  registerInsert() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const insertShortcut = {
      name: Constants.SHORTCUT_NAMES.INSERT,
      preconditionFn: (workspace) => {
        return (
            workspace.keyboardAccessibilityMode && !workspace.options.readOnly
        );
      },
      callback: (workspace) => {
        switch (this.navigation.getState(workspace)) {
          case Constants.STATE.WORKSPACE:
            return this.navigation.connectMarkerAndCursor(workspace);
          default:
            return false;
        }
      },
    };

    Blockly.ShortcutRegistry.registry.register(insertShortcut);
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        Blockly.utils.KeyCodes.I,
        insertShortcut.name,
    );
  }

  /**
   * Keyboard shortcut to mark a location when in keyboard navigation mode.
   * @protected
   */
  registerMark() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const markShortcut = {
      name: Constants.SHORTCUT_NAMES.MARK,
      preconditionFn: (workspace) => {
        return (
            workspace.keyboardAccessibilityMode && !workspace.options.readOnly
        );
      },
      callback: (workspace) => {
        let flyoutCursor;
        let curNode;
        let nodeType;
        const acCursor = workspace.getCursor();
        const originalBlock = acCursor.editingBlock ? acCursor.editingBlock.getSourceBlock() : null;
        const dirKey = acCursor.editConnection;

        switch (this.navigation.getState(workspace)) {
          case Constants.STATE.WORKSPACE: {
            // Custom block types may handle Enter on themselves (e.g. question details).
            const node = acCursor.getCurNode();
            if (node?.getType() === Blockly.ASTNode.types.BLOCK &&
                blockTypes.activate(node.getSourceBlock(), {workspace, speech: this.speech})) {
              return true;
            }
            this.navigation.handleEnterForWS(workspace);
            this.speech.announceMark(workspace.getCursor().getCurNode(), originalBlock, dirKey)
            return true;
          }
          case Constants.STATE.FLYOUT:
            flyoutCursor = this.navigation.getFlyoutCursor(workspace);
            if (!flyoutCursor) {
              return false;
            }
            curNode = flyoutCursor.getCurNode();
            nodeType = curNode.getType();

            switch (nodeType) {
              case Blockly.ASTNode.types.STACK:
                const markerNode = workspace.getMarker(this.navigation.MARKER_NAME).getCurNode();
                const markerIsWorkspace =
                    !!markerNode && markerNode.getType() === Blockly.ASTNode.types.WORKSPACE;
                const editMode = workspace.getCursor()?.editMode;
                if (!editMode && !markerIsWorkspace) {
                  this.speech.update('Blocks can be inserted when Edit mode activated. Go back to workspace and press E to activate Edit mode');
                  return true;
                }
                let flyoutBlock = this.navigation.getFlyoutCursor(workspace).getCurNode()?.getSourceBlock();
                // Custom block rules (e.g. a question's intended blocks) explain their own rejections.
                const customRejection = () => {
                  if (!markerNode?.isConnection() || !flyoutBlock) return null;
                  const target = blockTypes.resolveTarget(markerNode, Blockly.ASTNode.createBlockNode(flyoutBlock));
                  return target?.isConnection() ?
                    blockTypes.explainRejection(flyoutBlock, target.getLocation()) :
                    null;
                };
                if (flyoutBlock.isEnabled && !flyoutBlock.isEnabled()) {
                  const disabledBlockName = this.speech.friendlyName(flyoutBlock) || 'block';
                  this.speech.update(customRejection() || `${disabledBlockName} is disabled and cannot be inserted.`, {cue: 'rejected'});
                  return true;
                }
                const inserted = this.navigation.insertFromFlyout(workspace);
                if (!inserted) {
                  this.speech.update(customRejection() || 'The selected block is not compatible with the marked connection.', {cue: 'rejected'});
                  return true;
                }
                const newBlock = workspace.getCursor().getCurNode();
                this.speech.announceInsertedBlock(newBlock, originalBlock, dirKey);
                break;
              case Blockly.ASTNode.types.BUTTON:
                this.navigation.triggerButtonCallback(workspace);
                break;
            }

            return true;
          default:
            return false;
        }
      },
    };

    Blockly.ShortcutRegistry.registry.register(markShortcut);
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        Blockly.utils.KeyCodes.ENTER,
        markShortcut.name,
    );
  }


  registerEditModeEvent() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const editModeShortcut = {
      name: Constants.SHORTCUT_NAMES.EDIT_MODE,
      preconditionFn: (workspace) => {
        return (
            workspace.keyboardAccessibilityMode && !workspace.options.readOnly
        );
      },
      callback: (workspace) => {
        if (this.navigation.getState(workspace) === Constants.STATE.TOOLBOX) {
          this.speech.update(
              'Can not change edit mode while the toolbox is open. Press Esc to return.'
          );
          return true;
        }
        const editMode = this.accessibleCursor.toggleEditMode();
        const curNode = this.accessibleCursor.getCurNode();
        this.navigation.removeMark?.(workspace);
        this.speech.announceEditModeToggle(editMode, curNode);
      },
    };

    Blockly.ShortcutRegistry.registry.register(editModeShortcut);
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        Blockly.utils.KeyCodes.E,
        editModeShortcut.name,
    );
  }

  /**
   * Keyboard shortcut to disconnect two blocks when in keyboard navigation
   * mode.
   * @protected
   */
  registerDisconnect() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const disconnectShortcut = {
      name: Constants.SHORTCUT_NAMES.DISCONNECT,
      preconditionFn: (workspace) => {
        return (
            workspace.keyboardAccessibilityMode && !workspace.options.readOnly
        );
      },
      callback: (workspace) => {
        switch (this.navigation.getState(workspace)) {
          case Constants.STATE.WORKSPACE:
            // must be in Edit mode
            const cursor = workspace && workspace.getCursor ? workspace.getCursor() : null;
            if (!cursor || !cursor?.editMode) {
              this.speech.update('Blocks can be disconnected only in Edit mode. Press E to activate Edit mode.');
              return true;
            }

            // must be on a connection
            const node = cursor.getCurNode ? cursor.getCurNode() : null;
            /** @type {!Blockly.RenderedConnection} */ const conn = node?.getLocation();
            if (!conn?.isConnected?.() || !conn.targetConnection) {
              this.speech.update('Move to a connection to disconnect blocks.');
              return true;
            }

            // identify the pair before we disconnect for preparing speech
            const isSuperior = conn.isSuperior && conn.isSuperior();
            const sup = isSuperior ? conn : conn.targetConnection;     // host side
            const inf = isSuperior ? conn.targetConnection : conn;     // plug side
            const parentBlock = sup && sup.getSourceBlock ? sup.getSourceBlock() : null;
            const childBlock = inf && inf.getSourceBlock ? inf.getSourceBlock() : null;
            const say = (b) => this.speech.friendlyName(b) || 'block';
            const getInputForConnection = (c) => {
              if (!c) return null;
              if (typeof c.getParentInput === 'function') return c.getParentInput();
              const blk = c.getSourceBlock && c.getSourceBlock();
              if (!blk || !blk.inputList) return null;
              for (let i = 0; i < blk.inputList.length; i++) {
                if (blk.inputList[i].connection === c) return blk.inputList[i];
              }
              return null;
            };

            // build speech
            let announcement;
            if (sup && sup.type === Blockly.INPUT_VALUE) {
              const input = getInputForConnection(sup);
              const slot = (input && input.name) ? ('value input ' + input.name) : 'a value input';
              announcement = `Disconnected ${say(childBlock)} from ${slot} of ${say(parentBlock)}.`;
            } else if (sup && sup.type === Blockly.NEXT_STATEMENT) {
              announcement = `Disconnected ${say(childBlock)} from the next connection of ${say(parentBlock)}.`;
            } else {
              announcement = `Disconnected ${say(childBlock)} from a connection of ${say(parentBlock)}.`;
            }

            const groupId = 'acc-disconnect-' + Date.now();
            Blockly.Events.setGroup(groupId);
            this.navigation.disconnectBlocks(workspace);
            Blockly.Events.setGroup(false);

            this.speech.update(announcement);
            return true;
          default:
            return false;
        }
      },
    };

    Blockly.ShortcutRegistry.registry.register(disconnectShortcut);
    const shiftX = Blockly.ShortcutRegistry.registry.createSerializedKey(
        Blockly.utils.KeyCodes.X,
        [Blockly.utils.KeyCodes.SHIFT],
    );
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        shiftX,
        disconnectShortcut.name,
        true,
    );
  }

  /**
   * Keyboard shortcut to focus on the toolbox when in keyboard navigation
   * mode.
   * @protected
   */
  registerToolboxFocus() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const focusToolboxShortcut = {
      name: Constants.SHORTCUT_NAMES.TOOLBOX,
      preconditionFn: (workspace) => {
        return (
            workspace.keyboardAccessibilityMode && !workspace.options.readOnly
        );
      },
      callback: (workspace) => {
        switch (this.navigation.getState(workspace)) {
          case Constants.STATE.WORKSPACE:
            if (!workspace.getToolbox()) {
              this.navigation.focusFlyout(workspace);
            } else {
              this.navigation.focusToolbox(workspace);
              this.speech.announceCategory(workspace.getToolbox().getSelectedItem());
            }
            this.applyToolboxFilter(workspace);
            return true;
          default:
            return false;
        }
      },
    };

    Blockly.ShortcutRegistry.registry.register(focusToolboxShortcut);
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        Blockly.utils.KeyCodes.T,
        focusToolboxShortcut.name,
    );
  }

  /**
   * Keyboard shortcut to exit the current location and focus on the workspace
   * when in keyboard navigation mode.
   * @protected
   */
  registerExit() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const exitShortcut = {
      name: Constants.SHORTCUT_NAMES.EXIT,
      preconditionFn: (workspace) => {
        return workspace.keyboardAccessibilityMode;
      },
      callback: (workspace) => {
        const wsCursor     = workspace.getCursor();
        const prevWsNode   = wsCursor.getCurNode();

        // Check if focus is on output panel or other external element
        const activeElement = document.activeElement;
        const outputPanel = document.querySelector('[data-output]');
        const isOutputFocused = outputPanel && (activeElement === outputPanel || outputPanel.contains(activeElement));

        // If output panel or external element has focus, return focus to workspace cursor
        if (isOutputFocused) {
          // Clear any output panel focus styling
          if (outputPanel) {
            const focusedLines = outputPanel.querySelectorAll('.output-line-focused');
            focusedLines.forEach(line => line.classList.remove('output-line-focused'));
            outputPanel.blur();
          }

          // Return focus to workspace cursor at its previous position
          if (prevWsNode) {
            wsCursor.setCurNode(prevWsNode);
            wsCursor.show();
          }

          // Ensure workspace is properly focused at DOM level
          try {
            const workspaceSvg = workspace.getParentSvg();
            if (workspaceSvg && workspaceSvg.parentNode) {
                workspaceSvg.focus();
            }
          } catch (e) {
            console.warn('Failed to focus workspace:', e);
          }

          workspace.markFocused();

          // Update navigation hints
          this.emitKeyHints(workspace);

          this.speech?.announceReturnToWorkspace?.(false);
          return true;
        }

        switch (this.navigation.getState(workspace)) {
          case Constants.STATE.FLYOUT:
            this.navigation.focusWorkspace(workspace);
            this.navigation.removeMark(workspace);
            if (prevWsNode) {
              console.log("working flyout")
              wsCursor.setCurNode(prevWsNode);
            }
            this.speech.announceReturnToWorkspace(wsCursor.getCurNode())
            return true;
          case Constants.STATE.TOOLBOX:
            this.navigation.focusWorkspace(workspace);
            this.navigation.removeMark(workspace);
            if (prevWsNode) {
              console.log("working tool")
              wsCursor.setCurNode(prevWsNode);
            }
            this.speech.announceReturnToWorkspace(wsCursor.getCurNode())
            return true;
          default:
            return false;
        }
      },
    };

    Blockly.ShortcutRegistry.registry.register(exitShortcut, true);
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        Blockly.utils.KeyCodes.ESC,
        exitShortcut.name,
        true,
    );
    // removed E for exit as it conflicts with edit mode shortcut
    // Blockly.ShortcutRegistry.registry.addKeyMapping(
    //     Blockly.utils.KeyCodes.E,
    //     exitShortcut.name,
    //     true,
    // );
  }

  /**
   * Keyboard shortcut to move the cursor on the workspace to the left when in
   * keyboard navigation mode.
   * @protected
   */
  registerWorkspaceMoveLeft() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const wsMoveLeftShortcut = {
      name: Constants.SHORTCUT_NAMES.MOVE_WS_CURSOR_LEFT,
      preconditionFn: (workspace) => {
        return (
            workspace.keyboardAccessibilityMode && !workspace.options.readOnly
        );
      },
      callback: (workspace) => {
        const result = this.navigation.moveWSCursor(workspace, -1, 0);
        if (result && this.speech) {
          this.speech.update('Moving marker left');
        }
        return result;
      },
    };

    Blockly.ShortcutRegistry.registry.register(wsMoveLeftShortcut);
    const shiftA = Blockly.ShortcutRegistry.registry.createSerializedKey(
        Blockly.utils.KeyCodes.A,
        [Blockly.utils.KeyCodes.SHIFT],
    );
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        shiftA,
        wsMoveLeftShortcut.name,
    );
  }

  /**
   * Keyboard shortcut to move the cursor on the workspace to the right when in
   * keyboard navigation mode.
   * @protected
   */
  registerWorkspaceMoveRight() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const wsMoveRightShortcut = {
      name: Constants.SHORTCUT_NAMES.MOVE_WS_CURSOR_RIGHT,
      preconditionFn: (workspace) => {
        return (
            workspace.keyboardAccessibilityMode && !workspace.options.readOnly
        );
      },
      callback: (workspace) => {
        const result = this.navigation.moveWSCursor(workspace, 1, 0);
        if (result && this.speech) {
          this.speech.update('Moving marker right');
        }
        return result;
      },
    };

    Blockly.ShortcutRegistry.registry.register(wsMoveRightShortcut);
    const shiftD = Blockly.ShortcutRegistry.registry.createSerializedKey(
        Blockly.utils.KeyCodes.D,
        [Blockly.utils.KeyCodes.SHIFT],
    );
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        shiftD,
        wsMoveRightShortcut.name,
    );
  }

  /**
   * Keyboard shortcut to move the cursor on the workspace up when in keyboard
   * navigation mode.
   * @protected
   */
  registerWorkspaceMoveUp() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const wsMoveUpShortcut = {
      name: Constants.SHORTCUT_NAMES.MOVE_WS_CURSOR_UP,
      preconditionFn: (workspace) => {
        return (
            workspace.keyboardAccessibilityMode && !workspace.options.readOnly
        );
      },
      callback: (workspace) => {
        const result = this.navigation.moveWSCursor(workspace, 0, -1);
        if (result && this.speech) {
          this.speech.update('Moving marker up');
        }
        return result;
      },
    };

    Blockly.ShortcutRegistry.registry.register(wsMoveUpShortcut);
    const shiftW = Blockly.ShortcutRegistry.registry.createSerializedKey(
        Blockly.utils.KeyCodes.W,
        [Blockly.utils.KeyCodes.SHIFT],
    );
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        shiftW,
        wsMoveUpShortcut.name,
    );
  }

  /**
   * Keyboard shortcut to move the cursor on the workspace down when in
   * keyboard navigation mode.
   * @protected
   */
  registerWorkspaceMoveDown() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const wsMoveDownShortcut = {
      name: Constants.SHORTCUT_NAMES.MOVE_WS_CURSOR_DOWN,
      preconditionFn: (workspace) => {
        return (
            workspace.keyboardAccessibilityMode && !workspace.options.readOnly
        );
      },
      callback: (workspace) => {
        const result = this.navigation.moveWSCursor(workspace, 0, 1);
        if (result && this.speech) {
          this.speech.update('Moving marker down');
        }
        return result;
      },
    };

    Blockly.ShortcutRegistry.registry.register(wsMoveDownShortcut);
    const shiftW = Blockly.ShortcutRegistry.registry.createSerializedKey(
        Blockly.utils.KeyCodes.S,
        [Blockly.utils.KeyCodes.SHIFT],
    );
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        shiftW,
        wsMoveDownShortcut.name,
    );
  }

  /**
   * Keyboard shortcut to focus the output panel with Shift+O
   * @protected
   */
  registerOutputFocus() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const outputFocusShortcut = {
      name: Constants.SHORTCUT_NAMES.OUTPUT_FOCUS,
      preconditionFn: (workspace) => {
        return workspace.keyboardAccessibilityMode && !workspace.options.readOnly;
      },
      callback: (workspace) => {
        const outputPanel = document.querySelector('[data-output]');
        if (outputPanel) {
          this.focusOutputPanel(outputPanel);
          return true;
        }
        return false;
      },
    };

    Blockly.ShortcutRegistry.registry.register(outputFocusShortcut);
    const shiftO = Blockly.ShortcutRegistry.registry.createSerializedKey(
      Blockly.utils.KeyCodes.O,
      [Blockly.utils.KeyCodes.SHIFT],
    );
    Blockly.ShortcutRegistry.registry.addKeyMapping(
      shiftO,
      outputFocusShortcut.name,
    );
  }

  /**
   * Focus the output panel and set up navigation
   * @param {HTMLElement} outputPanel The output panel element
   * @protected
   */
  focusOutputPanel(outputPanel) {
    const layout = outputPanel.getAttribute('data-output');

    if (layout === 'line') {
      const lines = outputPanel.querySelectorAll('[data-output-line]');
      if (lines.length > 0) {
        // Announce to screen reader BEFORE focusing (so it's read first)
        const firstLineContent = lines[0].querySelector('.output-line-content')?.textContent || '';
        this.announceToScreenReader(`The cursor on output panel. Line 1: ${firstLineContent}`);

        // Small delay to let screen reader process the announcement, then focus

        outputPanel.setAttribute('tabindex', '-1');
        outputPanel.focus();
        lines[0].scrollIntoView({ block: 'nearest' });


        this.initializeOutputLineNavigation(outputPanel, lines);
      }
    }
    // grid layout will be implemented later
  }

  /**
   * Initialize line-based navigation for output panel
   * @param {HTMLElement} outputPanel The output panel element
   * @param {NodeList} lines The output line elements
   * @protected
   */
  initializeOutputLineNavigation(outputPanel, lines) {
    let currentIndex = 0;

    // Highlight first line
    lines[0].classList.add('output-line-focused');

    // Remove any existing listener
    if (outputPanel._outputNavListener) {
      outputPanel.removeEventListener('keydown', outputPanel._outputNavListener);
    }

    // Add keydown listener
    const navListener = (e) => {
      const layout = outputPanel.getAttribute('data-output');
      if (layout !== 'line') return;

      const currentLines = outputPanel.querySelectorAll('[data-output-line]');

      // Handle W/S navigation
      if (e.key === 'w' || e.key === 'W') {
        e.preventDefault();
        e.stopPropagation();
        if (currentIndex > 0) {
          currentLines[currentIndex].classList.remove('output-line-focused');
          currentIndex--;
          currentLines[currentIndex].classList.add('output-line-focused');
          currentLines[currentIndex].scrollIntoView({ block: 'nearest' });

          // Announce to screen reader
          const lineContent = currentLines[currentIndex].querySelector('.output-line-content')?.textContent || '';
          this.announceToScreenReader(`Line ${currentIndex + 1}: ${lineContent}`);
        } else {
          // At the first line, cannot go up
          this.announceToScreenReader('No line before line 1');
        }
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        e.stopPropagation();
        if (currentIndex < currentLines.length - 1) {
          currentLines[currentIndex].classList.remove('output-line-focused');
          currentIndex++;
          currentLines[currentIndex].classList.add('output-line-focused');
          currentLines[currentIndex].scrollIntoView({ block: 'nearest' });

          // Announce to screen reader
          const lineContent = currentLines[currentIndex].querySelector('.output-line-content')?.textContent || '';
          this.announceToScreenReader(`Line ${currentIndex + 1}: ${lineContent}`);
        } else {
          // At the last line, cannot go down
          this.announceToScreenReader(`No line after line ${currentLines.length}`);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();

        // Clear focus styling and tabindex
        currentLines[currentIndex].classList.remove('output-line-focused');
        outputPanel.blur();

        // Restore focus to workspace
        const workspace = Blockly.getMainWorkspace();
        if (workspace) {
          // Focus workspace at DOM level
          try {
            const workspaceSvg = workspace.getParentSvg();
            if (workspaceSvg) {
              workspaceSvg.focus();
            }
          } catch (err) {
            console.warn('Failed to focus workspace:', err);
          }

          // Mark workspace as focused in Blockly's state
          workspace.markFocused();

          // Announce to screen reader
          this.announceToScreenReader('Returned to workspace');
        }
      }
    };

    // Attach listener to output panel for keyboard events
    outputPanel._outputNavListener = navListener;
    outputPanel.addEventListener('keydown', navListener);

    // Clean up focus styling when panel loses focus
    outputPanel.addEventListener('blur', () => {
      const currentLines = outputPanel.querySelectorAll('[data-output-line]');
      currentLines.forEach(line => line.classList.remove('output-line-focused'));
    }, { once: true });
  }

  /**
   * Keyboard shortcut to trigger the run button with Shift+R
   * @protected
   */
  registerRunProgram() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const runProgramShortcut = {
      name: Constants.SHORTCUT_NAMES.RUN_PROGRAM,
      preconditionFn: (workspace) => {
        return workspace.keyboardAccessibilityMode && !workspace.options.readOnly;
      },
      callback: (workspace) => {
        const runButton = document.querySelector('[data-run]');
        if (runButton && !runButton.disabled) {
          runButton.click();
          this.announceToScreenReader('Running program');
          return true;
        }
        return false;
      },
    };

    Blockly.ShortcutRegistry.registry.register(runProgramShortcut);
    const shiftR = Blockly.ShortcutRegistry.registry.createSerializedKey(
      Blockly.utils.KeyCodes.R,
      [Blockly.utils.KeyCodes.SHIFT],
    );
    Blockly.ShortcutRegistry.registry.addKeyMapping(
      shiftR,
      runProgramShortcut.name,
    );
  }

  /**
   * Keyboard shortcut to copy the block the cursor is currently on.
   * @protected
   */
  registerCopy() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const copyShortcut = {
      name: Constants.SHORTCUT_NAMES.COPY,
      preconditionFn: (workspace) => {
        if (
            workspace.keyboardAccessibilityMode &&
            !workspace.options.readOnly
        ) {
          const curNode = workspace.getCursor().getCurNode();
          if (curNode && curNode.getSourceBlock()) {
            console.log("copied block")
            const sourceBlock = curNode.getSourceBlock();
            return (
                !Blockly.Gesture.inProgress() &&
                sourceBlock &&
                sourceBlock.isDeletable() &&
                sourceBlock.isMovable()
            );
          }
        }
        return false;
      },
      callback: (workspace) => {
        // if a block is detached already
        if (this.detachedBlock && !this.detachedBlock.isDisposed?.()) {
          const isMac = /mac/i.test(
              `${navigator.platform || ''} ${navigator.userAgent || ''}`
          );
          const modPlusV = `${isMac ? 'Command' : 'Ctrl'}+V`;
          this.speech.update(
              `Copy is not allowed while you already have a detached block. ` +
              `Enter edit mode on a block and press ${modPlusV} to attach it, ` +
              `or press Ctrl+Z to cancel the detached block.`
          );
          return true; // handled
        }

        const sourceBlock = /** @type {Blockly.BlockSvg} */ (
            workspace.getCursor().getCurNode().getSourceBlock()
        );
        workspace.hideChaff();
        this.copyData = sourceBlock.toCopyData();
        this.copyWorkspace = sourceBlock.workspace;
        return !!this.copyData;
      },
    };

    Blockly.ShortcutRegistry.registry.register(copyShortcut);

    const ctrlC = Blockly.ShortcutRegistry.registry.createSerializedKey(
        Blockly.utils.KeyCodes.C,
        [Blockly.utils.KeyCodes.CTRL],
    );
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        ctrlC,
        copyShortcut.name,
        true,
    );

    const metaC = Blockly.ShortcutRegistry.registry.createSerializedKey(
        Blockly.utils.KeyCodes.C,
        [Blockly.utils.KeyCodes.META],
    );
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        metaC,
        copyShortcut.name,
        true,
    );
  }

  /**
   * Register shortcut to paste the copied/detached block to the marked location.
   * @protected
   */
  registerPaste() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const pasteShortcut = {
      name: Constants.SHORTCUT_NAMES.PASTE,
      preconditionFn: (workspace) => {
        if (!workspace?.keyboardAccessibilityMode || workspace.options.readOnly) return false;
        if (Blockly.Gesture.inProgress()) return false;
        const acCursor = workspace.getCursor?.();
        // require edit mode and a stashed detached block or copied block
        const hasDetached = !!(this.detachedBlock && !this.detachedBlock.isDisposed?.());
        const hasCopied   = !!this.copyData;
        return !!(acCursor?.editMode && (hasDetached || hasCopied));
      },
      callback: (workspace) => {
        const cursor   = workspace.getCursor?.();
        const curNode  = cursor?.getCurNode?.();
        const editMode = cursor?.editMode;

        if (!editMode) {
          this.speech.update('Blocks can be attached when Edit mode activated. Press E to activate Edit mode');
          return true;
        }

        /** @type {!Blockly.RenderedConnection} */
        const destConnection = curNode?.getLocation?.();
        if (!destConnection || typeof destConnection.getSourceBlock !== 'function') {
          return true;
        }

        const destType = destConnection.type;
        let stashedChildForStatement = null;   // for NEXT sockets, reattach below after success
        let oldValueForRollback = null;        // for INPUT_VALUE, restore on failure or dispose on success
        const existing = destConnection.targetBlock?.();

        // value connection then replace existing block
        if (destType === Blockly.INPUT_VALUE) {
          if (existing) {
            // detach, later dispose when new insert succeeds.
            this.navigation.ejectConnectedBlock(destConnection, /*disposeChild=*/false);
            oldValueForRollback = existing;
          }
          // statement connection then detach and reattach below after insert
        } else if (destType === Blockly.NEXT_STATEMENT && destConnection.isSuperior?.()) {
          if (existing) {
            this.navigation.ejectConnectedBlock(destConnection, /*disposeChild=*/false);
            stashedChildForStatement = existing;
          }
        }

        // Decide which block to attach.
        let blockToAttach = null;
        let createdFromClipboard = false;

        if (this.detachedBlock && !this.detachedBlock.isDisposed?.()) {
          blockToAttach = this.detachedBlock;
        } else if (this.copyData) {
          try {
            Blockly.Events.setGroup(true);
            const pasted = /** @type {Blockly.BlockSvg} */ (Blockly.clipboard.paste(this.copyData, workspace));
            if (pasted) {
              pasted.render();
              pasted.setConnectionTracking(true);
              blockToAttach = pasted;
              createdFromClipboard = true;
            }
          } finally {
            Blockly.Events.setGroup(false);
          }
        }

        if (!blockToAttach || blockToAttach.isDisposed()) {
          // roll back value child if we detached it
          if (oldValueForRollback && oldValueForRollback?.outputConnection) {
            destConnection.connect(oldValueForRollback.outputConnection);
          }
          this.speech.update('Nothing to paste here.');
          return true;
        }

        const wasDisabled = typeof blockToAttach.isEnabled === 'function' ? (blockToAttach.isEnabled() === false) : false;
        if (wasDisabled) blockToAttach.setEnabled(true);

        const inserted = this.navigation.insertBlock(blockToAttach, destConnection);

        if (!inserted) {
          if (oldValueForRollback && oldValueForRollback?.outputConnection) {
            destConnection.connect(oldValueForRollback.outputConnection);
          }
          // clean up new block
          if (createdFromClipboard) {
            blockToAttach.dispose(false);
          } else if (wasDisabled) {
            blockToAttach.setEnabled(false);
          }
          this.speech.update('The block is not compatible with this connection.', {cue: 'rejected'});
          return true;
        }

        // if replaced a value input, dispose the old value
        if (oldValueForRollback) {
          oldValueForRollback.dispose(true);
        }

        // if inserted into a statement input, reattach the prior first child below the new chain.
        if (stashedChildForStatement && destType === Blockly.NEXT_STATEMENT) {
          let tail = blockToAttach;
          while (tail?.nextConnection && tail.nextConnection.targetBlock?.()) {
            tail = tail.nextConnection.targetBlock();
          }
          const tailNext  = tail?.nextConnection || null;
          const childPrev = stashedChildForStatement.previousConnection || null;

          if (tailNext && childPrev) {
            try {
              tailNext.connect?.(childPrev);
            } catch {
              this.detachedBlock = stashedChildForStatement;
              this.detachedWorkspace = workspace;
              this.speech.update('Inserted block. The previous child could not be reattached and was left detached.');
            }
          } else {
            this.detachedBlock = stashedChildForStatement;
            this.detachedWorkspace = workspace;
            this.speech.update('Inserted block. The previous child could not be reattached and was left detached.');
          }
        }

        // clear the stash for detach block
        if (blockToAttach === this.detachedBlock) {
          this.detachedBlock = null;
          this.detachedWorkspace = null;
        }

        // move cursor to the newly attached block and set edit focus
        const node = Blockly.ASTNode.createBlockNode(blockToAttach);
        cursor?.suppressNextScroll?.();
        cursor?.setCurNode(node);
        cursor?.suppressNextScroll?.();
        cursor?.setEditingBlock?.(node);

        // TODO: make speech more intuitive
        this.speech.update(`Attached ${this.speech.blockToText(blockToAttach) || 'block'}.`);
        return true;
      }

    };

    Blockly.ShortcutRegistry.registry.register(pasteShortcut);

    const ctrlV = Blockly.ShortcutRegistry.registry.createSerializedKey(
        Blockly.utils.KeyCodes.V,
        [Blockly.utils.KeyCodes.CTRL],
    );
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        ctrlV,
        pasteShortcut.name,
        true,
    );

    const altV = Blockly.ShortcutRegistry.registry.createSerializedKey(
        Blockly.utils.KeyCodes.V,
        [Blockly.utils.KeyCodes.ALT],
    );
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        altV,
        pasteShortcut.name,
        true,
    );

    const metaV = Blockly.ShortcutRegistry.registry.createSerializedKey(
        Blockly.utils.KeyCodes.V,
        [Blockly.utils.KeyCodes.META],
    );
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        metaV,
        pasteShortcut.name,
        true,
    );
  }

  /**
   * Keyboard shortcut to copy and delete the block the cursor is on using
   * ctrl+x, cmd+x
   * @protected
   */
  registerCut() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const cutShortcut = {
      name: Constants.SHORTCUT_NAMES.CUT,
      preconditionFn: (workspace) => {
        if (
            workspace.keyboardAccessibilityMode &&
            !workspace.options.readOnly
        ) {
          const curNode = workspace.getCursor().getCurNode();
          if (curNode && curNode.getSourceBlock()) {
            const sourceBlock = curNode.getSourceBlock();
            return (
                !Blockly.Gesture.inProgress() &&
                sourceBlock &&
                sourceBlock.isDeletable() &&
                sourceBlock.isMovable() &&
                !sourceBlock.workspace.isFlyout
            );
          }
        }
        return false;
      },
      callback: (workspace) => {
        if (this.navigation.getState(workspace) !== Constants.STATE.WORKSPACE) {
          return false;
        }
        // already has detached block
        if (this.detachedBlock && !this.detachedBlock.isDisposed?.()) {
          this.speech.update('You already have a detached block. Enter edit mode and press Ctrl+V to attach it, or press Ctrl+Z to cancel.');
          return true;
        }

        const cursor = workspace.getCursor();
        if (cursor?.editMode) {
          this.speech.update('Block can not be cut on edit mode. Press E to leave Edit mode');
          return true;
        }

        const node = cursor?.getCurNode?.();
        const block = node?.getSourceBlock?.();
        if (!block || block.isShadow?.() || block.workspace?.isFlyout) {
          this.speech.update('Nothing to detach here.');
          return false;
        }

        // prefer detaching inferior child when cursor is on a live connection that is currently connected.
        let targetBlock = block;
        if (node.isConnection()) {
          const conn = node.getLocation();
          const inferior = conn.isSuperior ? (conn.isSuperior() ? conn.targetConnection : conn) : null;
          targetBlock = inferior?.getSourceBlock?.() || block;
        }


        // capture the context before we unplug, so we know where to focus after
        const preParent = targetBlock.getParent?.() || null;          // null, target was top of a stack
        const preRoot   = targetBlock.getRootBlock?.() || targetBlock; // top block of the source stack
        const preBelow  = targetBlock.getNextBlock?.() || null;        // block below, if target was top
        const txyBefore = targetBlock.getRelativeToSurfaceXY?.() || {x:0, y:0};

        Blockly.Events.setGroup(true);

        try {
          // if detached block has a parent, unplug aside.
          const hadParent = !!targetBlock.getParent?.();
          if (hadParent) {
            targetBlock.unplug(false);
            try {
              const xy = targetBlock.getRelativeToSurfaceXY?.();
              if (xy) targetBlock.moveTo(new Blockly.utils.Coordinate(xy.x + 300, xy.y));
            } catch {
            }
          }
          // targetBlock.bringToFront();
          // disable detached block to mark it as cut
          targetBlock.setEnabled?.(false);
          // stash detached block
          this.detachedBlock = targetBlock;
          this.detachedWorkspace = targetBlock.workspace;


          // decide new cursor location
          let focusNode = null;
          let announce = '';

          if (preParent) {
            // Case 1: detached from middle of a stack, focus that original stack
            const stackTop = preRoot && preRoot !== targetBlock ?
                preRoot : preParent.getRootBlock?.() || preParent;
            focusNode = Blockly.ASTNode.createStackNode(stackTop);
            announce = `Focus moved to the stack: ${this.speech.friendlyName(stackTop)}.`;
          } else if (preBelow) {
            // Case 2: detached from top of a stack, focus that original stack
            focusNode = Blockly.ASTNode.createStackNode(preBelow);
            announce = `Focus moved to the stack: ${this.speech.friendlyName(preBelow)}.`;
          } else {
            // Case 3: Target was the only block in its stack, focus nearest other stack.
            const tops = (workspace.getTopBlocks && workspace.getTopBlocks(true)) ?
                workspace.getTopBlocks(true) : [];
            const others = tops.filter(b => b !== targetBlock && b.isEnabled?.() !== false && !b.isShadow?.());
            if (others.length) {
              let best = others[0], bestD2 = Infinity;
              for (const b of others) {
                const p = b.getRelativeToSurfaceXY?.() || {x: 0, y: 0};
                const dx = p.x - txyBefore.x, dy = p.y - txyBefore.y;
                const d2 = dx * dx + dy * dy;
                if (d2 < bestD2) {
                  bestD2 = d2;
                  best = b;
                }
              }
              focusNode = Blockly.ASTNode.createStackNode(best);
              announce = `Focus moved to the nearest stack: ${this.speech.friendlyName(best)}.`;
            } else {
              // Case 4: No stacks in workspace
              const wsCoord = new Blockly.utils.Coordinate(txyBefore.x, txyBefore.y);
              focusNode = Blockly.ASTNode.createWorkspaceNode(workspace, wsCoord);
              announce = 'Focus moved to the workspace.';
            }
          }

          if (focusNode) cursor?.setCurNode(focusNode);
          this.speech.update?.(
              `Detached ${this.speech.blockToText(targetBlock) || 'block'}. ${announce} ` +
              `Enter edit mode on the desired block, navigate to a connection, then press Ctrl+V to attach.`
          );
        } catch {
        } finally {
          Blockly.Events.setGroup(false);
        }
        return true;
      },
    };

    Blockly.ShortcutRegistry.registry.register(cutShortcut);

    const ctrlX = Blockly.ShortcutRegistry.registry.createSerializedKey(
        Blockly.utils.KeyCodes.X,
        [Blockly.utils.KeyCodes.CTRL],
    );
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        ctrlX,
        cutShortcut.name,
        true,
    );

    const metaX = Blockly.ShortcutRegistry.registry.createSerializedKey(
        Blockly.utils.KeyCodes.X,
        [Blockly.utils.KeyCodes.META],
    );
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        metaX,
        cutShortcut.name,
        true,
    );
  }

  /**
   * Registers shortcut to delete the block the cursor is on using delete or
   * backspace.
   * @protected
   */
  registerDelete() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const deleteShortcut = {
      name: Constants.SHORTCUT_NAMES.DELETE,
      preconditionFn: function (workspace) {
        if (
            workspace.keyboardAccessibilityMode &&
            !workspace.options.readOnly
        ) {
          const curNode = workspace.getCursor().getCurNode();
          if (curNode && curNode.getSourceBlock()) {
            const sourceBlock = curNode.getSourceBlock();
            return sourceBlock && sourceBlock.isDeletable();
          }
        }
        return false;
      },
      callback: (workspace, e) => {
        const sourceBlock = workspace.getCursor().getCurNode().getSourceBlock();
        // Delete or backspace.
        // Stop the browser from going back to the previous page.
        // Do this first to prevent an error in the delete code from resulting
        // in data loss.
        e.preventDefault();
        // Don't delete while dragging.  Jeez.
        if (Blockly.Gesture.inProgress()) {
          return false;
        }
        this.navigation.moveCursorOnBlockDelete(workspace, sourceBlock);
        sourceBlock.checkAndDelete();
        let blockLabel = this.speech.friendlyName(sourceBlock) || 'block';
        this.speech.update("Deleted " + blockLabel);

        return true;
      },
    };
    Blockly.ShortcutRegistry.registry.register(deleteShortcut);
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        Blockly.utils.KeyCodes.DELETE,
        deleteShortcut.name,
        true,
    );
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        Blockly.utils.KeyCodes.BACKSPACE,
        deleteShortcut.name,
        true,
    );
  }

  registerCursorLocation() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const cursorLocShortcut = {
      name: Constants.SHORTCUT_NAMES.CURSOR_LOC,
      preconditionFn: (ws) => ws.keyboardAccessibilityMode,
      callback: (workspace /*, e, shortcut*/) => {
        const node = workspace.getCursor()?.getCurNode() || null;
        if (node) {
          workspace.getCursor()?.setCurNode(node); // highlight if cursor is out of sync due to mouse movement
        }
        this.speech.announceCursorLoc(node);
        return true;
      },
    };

    Blockly.ShortcutRegistry.registry.register(cursorLocShortcut);
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        Blockly.utils.KeyCodes.C,
        cursorLocShortcut.name,
        true,
    );
  }


  /**
   * Keyboard shortcut to add/open a comment on the current block.
   * Ctrl + /
   * - If the block has no comment: creates an empty comment and opens the editor.
   * - If the block already has a comment: open/close the editor
   * @protected
   */
  registerAddComment() {
    const _commentsEnabled = (workspace) =>
        !!(workspace && workspace.options && workspace.options.comments !== false);

    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const addCommentShortcut = {
      name: Constants.SHORTCUT_NAMES.ADD_COMMENT,
      preconditionFn: function (workspace) {
        if (!workspace || !workspace.keyboardAccessibilityMode || workspace.options.readOnly || !_commentsEnabled(workspace)) return false;
        const node  = workspace.getCursor?.()?.getCurNode?.();
        const block = node?.getSourceBlock?.();
        if (!block) return false;
        if (block.workspace?.isFlyout) return false;
        if (typeof block.isEditable === 'function' && !block.isEditable()) return false;
        if (typeof block.isCollapsed === 'function' && block.isCollapsed()) return false;
        if (Blockly.Gesture?.inProgress?.()) return false;
        return true;
      },
      callback: (workspace, e) => {
        const block = workspace.getCursor?.()?.getCurNode?.()?.getSourceBlock?.();
        if (!block) return false;

        if (e && e.preventDefault) e.preventDefault();

        if (block.getCommentText?.() == null) {
          block.setCommentText?.('');
        }

        const commentIcon = block.getIcon?.(Blockly.icons?.IconType?.COMMENT);
        if (!commentIcon?.setBubbleVisible || !commentIcon?.bubbleIsVisible) {
          return true;
        }

        const openBubble = !commentIcon.bubbleIsVisible();

        const getCommentText = () =>
            commentIcon.getText?.() ?? block.getCommentText?.() ?? '';

        // bound the text we speak to avoid long speech
        const summarize = (raw, maxLen = 160) => {
          const cleaned = String(raw).replace(/\s+/g, ' ').trim();
          if (!cleaned) return '';
          return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}…` : cleaned;
        };

        const announceWithText = (opened) => {
          if (!this.speech) return;
          const label   = this.speech.blockToText(block);
          const content = summarize(getCommentText());
          const tail    = content ? ` Current text: ${content}` : ' Comment is empty.';
          this.speech.update(`${opened ? 'Opened' : 'Closed'} comment on ${label}.${tail}`);
        };

        // function to query bubble layer when present
        const queryTextarea = () => {
          const doc = workspace.getParentSvg?.()?.ownerDocument || document;
          return (
              commentIcon.textarea_ ||
              commentIcon.textarea ||
              doc.querySelector('.blocklyBubbleCanvas .blocklyTextInputBubble textarea.blocklyTextarea')
          );
        };

        // bind e key handler to comment box to move focus to workspace
        const bindTextareaKeys = () => {
          const textarea = queryTextarea();
          if (!textarea || textarea.__accKeysBound) return; // idempotent
          textarea.__accKeysBound = true;
          textarea.addEventListener(
              'keydown',
              (ev) => {
                const isSlash = ev.key === '/' || ev.code === 'Slash';
                const ctrlOrMeta = ev.ctrlKey || ev.metaKey;
                const wasBubbleOpen = commentIcon.bubbleIsVisible();

                if (ctrlOrMeta && isSlash) {
                  ev.preventDefault();
                  ev.stopPropagation();
                  commentIcon.setBubbleVisible(!commentIcon.bubbleIsVisible());
                  if (wasBubbleOpen) {
                    try {
                      workspace.markFocused?.();
                      // workspace.getParentSvg?.()?.focus?.();
                    } catch {}
                    setTimeout(() => announceWithText(false), 500);
                  }
                }
              },
              true // capture
          );
        };

        const focusTextareaNextFrame = () => {
          requestAnimationFrame(() => {
            const ta = queryTextarea();
            if (ta) {
              // make SR prefer your live region (#blockReader) after focus
              ta.setAttribute('aria-describedby', 'blockReader');
              try {
                ta.focus({preventScroll: true});
              } catch {
              }
              bindTextareaKeys();
            }
            announceWithText(true);
          });
        };

        const togglePromise = commentIcon.setBubbleVisible(openBubble);
        if (openBubble) {
          togglePromise?.then ? togglePromise.then(focusTextareaNextFrame) : focusTextareaNextFrame();
        } else {
          announceWithText(openBubble);
        }
        return true;
      },
    };

    Blockly.ShortcutRegistry.registry.register(addCommentShortcut);

    const ctrlSlash = Blockly.ShortcutRegistry.registry.createSerializedKey(
        191, // keyCode for '/'
        [Blockly.utils.KeyCodes.CTRL],
    );
    Blockly.ShortcutRegistry.registry.addKeyMapping(ctrlSlash, addCommentShortcut.name, true);

    const metaSlash = Blockly.ShortcutRegistry.registry.createSerializedKey(
        191,
        [Blockly.utils.KeyCodes.META],
    );
    Blockly.ShortcutRegistry.registry.addKeyMapping(metaSlash, addCommentShortcut.name, true);
  }

  registerReorderStatementShortcuts() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const moveUpShortcut = {
      name: Constants.SHORTCUT_NAMES.MOVE_STATEMENT_UP,
      preconditionFn: (workspace) => {
        if (!workspace?.keyboardAccessibilityMode || workspace.options.readOnly) return false;
        const cursor = workspace.getCursor?.();
        return !(cursor?.editMode); // navigation mode only
      },
      callback: (workspace, e) => {
        if (e && e.preventDefault) e.preventDefault();
        if (this.navigation.getState(workspace) !== Constants.STATE.WORKSPACE) {
          // marker is not in workspace
          return true;
        }
        const acCursor = workspace.getCursor();
        if (acCursor.getCurNode()?.getType() !== Blockly.ASTNode.types.BLOCK) {
          let result = this.navigation.moveWSCursor(workspace, 0, -1);
          if (result && this.speech) {
            this.speech.update('Moving marker up');
          }
          return result;
        }
        const block = this._currentStatementBlock(workspace);
        if (!block) {
          this.speech.update('No movable statement block selected.');
          return true;
        }
        const moved = this._moveStatementSibling(block, 'up');
        if (!moved) {
          this.speech.update('No sibling block above to rearrange with current block');
        }
        return true;
      },
    };

    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const moveDownShortcut = {
      name: Constants.SHORTCUT_NAMES.MOVE_STATEMENT_DOWN,
      preconditionFn: (workspace) => {
        if (!workspace?.keyboardAccessibilityMode || workspace.options.readOnly) return false;
        const cursor = workspace.getCursor?.();
        return !(cursor?.editMode); // navigation mode only
      },
      callback: (workspace, e) => {
        if (e && e.preventDefault) e.preventDefault();
        if (this.navigation.getState(workspace) !== Constants.STATE.WORKSPACE) {
          // marker is not in workspace
          return true;
        }
        const acCursor = workspace.getCursor();
        if (acCursor.getCurNode()?.getType() !== Blockly.ASTNode.types.BLOCK) {
          let result = this.navigation.moveWSCursor(workspace, 0, 1);
          if (result && this.speech) {
            this.speech.update('Moving marker down');
          }
          return result;
        }
        const block = this._currentStatementBlock(workspace);
        if (!block) {
          this.speech.update('No movable statement block selected.');
          return true;
        }
        const moved = this._moveStatementSibling(block, 'down');
        if (!moved) {
          this.speech.update('No sibling block below to rearrange with current block');
        }
        return true;
      },
    };

    Blockly.ShortcutRegistry.registry.register(moveUpShortcut);
    Blockly.ShortcutRegistry.registry.register(moveDownShortcut);

    const ctrlW = Blockly.ShortcutRegistry.registry.createSerializedKey(Blockly.utils.KeyCodes.W, [Blockly.utils.KeyCodes.SHIFT]);
    const ctrlS = Blockly.ShortcutRegistry.registry.createSerializedKey(Blockly.utils.KeyCodes.S, [Blockly.utils.KeyCodes.SHIFT]);

    Blockly.ShortcutRegistry.registry.addKeyMapping(ctrlW, moveUpShortcut.name, true);
    Blockly.ShortcutRegistry.registry.addKeyMapping(ctrlS, moveDownShortcut.name, true);
  }


  // get current statement block
  _currentStatementBlock(workspace) {
    const cursor  = workspace.getCursor?.();
    const curNode = cursor?.getCurNode?.();
    if (!curNode) return null;

    if (curNode.isConnection?.()) {
      return false;
    }

    let block = curNode.getSourceBlock() || null;
    if (!block || block.isDisposed() || block.isShadow?.()) return null;

    const isStatementLikeBlock = !!(block.previousConnection || block.nextConnection);
    if (!isStatementLikeBlock) return null;

    return block;
  }



  /**
   * Move a statement block up/down among its siblings within the same container
   * @param {!Blockly.BlockSvg} block The statement block to move.
   * @param {'up'|'down'} dir
   * @returns {boolean} True if moved, false if at boundary or invalid.
   */
  _moveStatementSibling(block, dir) {
    if (!block?.workspace || block.isDisposed?.() || block.isShadow?.()) return false;
    if (dir !== 'up' && dir !== 'down') return false;

    const prevConn = block.previousConnection;
    const nextConn = block.nextConnection;
    if (!prevConn && !nextConn) return false;

    const nextSibling = nextConn?.targetBlock?.() || null;

    // switch down
    if (dir === 'down') {
      const C = nextSibling;
      if (!C) return false; // no blocks below
      const D = C.nextConnection?.targetBlock?.() || null;

      const groupId = 'ac-move-down-' + Date.now();
      Blockly.Events.setGroup(groupId);
      try {
        // detach current block B
        block.unplug(true);

        // make space after C and connect B
        if (D?.previousConnection?.isConnected?.()) {
          D.previousConnection.disconnect();
        }

        if (!C.nextConnection) return false;
        C.nextConnection.connect(block.previousConnection);

        // reattach D after B
        if (D?.previousConnection && block.nextConnection) {
          block.nextConnection.connect(D.previousConnection);
        }

        // focus on moved block
        const cursor = block.workspace.getCursor?.();
        const node = Blockly.ASTNode.createBlockNode(block);
        cursor?.suppressNextScroll?.();
        cursor.setCurNode(node);
        this.speech.update('Moved current block down.'); // TODO: enhance speech
        return true;
      } finally {
        Blockly.Events.setGroup(false);
      }
    }

    // switch up
    if (dir === 'up') {
      // require a sibling block above current block
      const targetPrevConn = prevConn.targetConnection || null;
      const prevBlock = targetPrevConn?.getSourceBlock?.() || null;
      const hasPrevSibling =
          !!(prevBlock && !prevBlock.isShadow?.() && targetPrevConn === prevBlock.nextConnection);

      if (!hasPrevSibling) return false; // no block above

      const A = prevBlock; // previous sibling
      const D = block.nextConnection?.targetBlock?.() || null;

      const groupId = 'ac-move-up-' + Date.now();
      Blockly.Events.setGroup(groupId);
      try {
        // detach top block
        A.unplug(true);

        // make space after current block B and connect A after B
        if (D?.previousConnection?.isConnected?.()) {
          D.previousConnection.disconnect();
        }
        if (!block.nextConnection) return false; // defensive
        block.nextConnection.connect(A.previousConnection);

        // reattach D after A
        if (D?.previousConnection && A.nextConnection) {
          A.nextConnection.connect(D.previousConnection);
        }

        // ]focus on moved block
        const cursor = block.workspace.getCursor?.();
        const node = Blockly.ASTNode.createBlockNode(block);
        cursor?.suppressNextScroll?.();
        cursor.setCurNode(node);
        this.speech.update('Moved block up.'); // TODO: enhance speech
        return true;
      } finally {
        Blockly.Events.setGroup(false);
      }
    }

    return false;
  }


  /**
   * Alt+K — Show the shortcut assistance modal.
   */
  registerShowShortcuts() {
    this.showShortcuts = () => {
      if (Blockly.Gesture.inProgress()) return false;
      this.shortcutAssistance.toggle();
      return true;
    };

    const shortcut = {
      name: Constants.SHORTCUT_NAMES.SHOW_SHORTCUTS,
      // not available during gesture drags.
      preconditionFn: (workspace) => !Blockly.Gesture.inProgress(),
      callback: (workspace) => {
        this.shortcutAssistance.toggle();
        return true;
      },
    };

    Blockly.ShortcutRegistry.registry.register(shortcut);
    const shiftK = Blockly.ShortcutRegistry.registry.createSerializedKey(
        Blockly.utils.KeyCodes.K,
        [Blockly.utils.KeyCodes.SHIFT],
    );
    Blockly.ShortcutRegistry.registry.addKeyMapping(shiftK, shortcut.name, true);
  }

  /**
   * Alt+H — Show the navigational hint module
   * ESC - close navigational hint module
   */
  registerShowNavigationalHint() {
    const navHintShortcut = {
      name: Constants.SHORTCUT_NAMES.SHOW_NAV_HINT,
      // not available during gesture drags.
      preconditionFn: (workspace) => !Blockly.Gesture.inProgress(),
      callback: (workspace) => {
        this.navHint.toggle();
        return true;
      },
    };

    Blockly.ShortcutRegistry.registry.register(navHintShortcut);
    const shiftH = Blockly.ShortcutRegistry.registry.createSerializedKey(
        Blockly.utils.KeyCodes.H,
        [Blockly.utils.KeyCodes.SHIFT],
    );
    Blockly.ShortcutRegistry.registry.addKeyMapping(shiftH, navHintShortcut.name, true);
  }


  registerUndo() {
    const {ShortcutRegistry, utils: {KeyCodes}, Gesture} = Blockly;

    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const undoShortcut = {
      name: Constants.SHORTCUT_NAMES.UNDO,
      preconditionFn(workspace) {
        // Allow undo whenever workspace is editable and not in a gesture.
        return !workspace.options.readOnly && !Gesture.inProgress();
      },
      callback: (workspace, e) => {
        const wsCursor = workspace.getCursor();
        const wasEditing = !!wsCursor?.editMode;
        // Standard undo (false = undo; true = redo)
        workspace.hideChaff?.();
        workspace.undo(false);

        let nodeToFocus = null;
        // if a detached block was staged, cancel it on Undo.
        if (this.detachedBlock && !this.detachedBlock.isDisposed?.()) {
          try {
            if (typeof this.detachedBlock.setEnabled === 'function') {
              this.detachedBlock.setEnabled(true);
            }
            nodeToFocus = Blockly.ASTNode.createBlockNode(this.detachedBlock);
          } catch {}
        } else if (wsCursor?.pastNodeBlockId) {
          const blk = workspace.getBlockById(wsCursor.pastNodeBlockId);
          if (blk && !blk.isDisposed?.()) {
            nodeToFocus = Blockly.ASTNode.createBlockNode(blk);
          }
        }

        if (nodeToFocus) {
          wsCursor?.suppressNextScroll?.();
          wsCursor?.setCurNode(nodeToFocus);

          // If we were in edit mode before undo, keep edit mode and put the edit focus on this node
          if (wasEditing) {
            wsCursor?.suppressNextScroll?.();
            wsCursor?.setEditingBlock?.(nodeToFocus);
          }
        }

        // clear pointers either way.
        this.detachedBlock = null;
        this.detachedWorkspace = null;

        // update speech
        this.speech?.update?.('Undo performed on previous action');

        // prevent browser event
        e?.preventDefault?.();
        return true;
      }
    };

    ShortcutRegistry.registry.register(undoShortcut, true);
    // Key chords: Ctrl+Z, Alt+Z, Meta+Z (⌘Z on macOS)
    const ctrlZ = ShortcutRegistry.registry.createSerializedKey(KeyCodes.Z, [KeyCodes.CTRL]);
    const metaZ = ShortcutRegistry.registry.createSerializedKey(KeyCodes.Z, [KeyCodes.META]);
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        ctrlZ,
        undoShortcut.name,
        true,
    );
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        metaZ,
        undoShortcut.name,
        true,
    );
  }

  /**
   * Registers all default keyboard shortcut items for keyboard navigation. This
   * should be called once per instance of KeyboardShortcutRegistry.
   * @protected
   */
  registerDefaults() {
    this.registerPrevious();
    this.registerNext();
    this.registerIn();
    this.registerOut();
    this.registerLayerIn();
    this.registerLayerOut();
    this.registerStackLabelEdit();
    this.registerStackSearch();
    this.registerEditModeEvent();
    this.registerCursorLocation();
    this.registerAddComment();

    this.registerDisconnect();
    this.registerExit();
    this.registerInsert();
    this.registerMark();
    this.registerToolboxFocus();
    this.registerToggleKeyboardNav();

    // this.registerWorkspaceMoveDown();
    this.registerWorkspaceMoveLeft();
    // this.registerWorkspaceMoveUp();
    this.registerWorkspaceMoveRight();
    this.registerOutputFocus();
    this.registerRunProgram();

    this.registerCopy();
    this.registerPaste();
    this.registerCut();
    this.registerDelete();
    this.registerUndo();

    this.registerReorderStatementShortcuts();
    this.registerShowShortcuts();
    this.registerShowNavigationalHint();
    this.registerStackJumpShortcuts();
    this.registerOpenDropdown();

    this.registerZoomIn();
    this.registerZoomOut();
    this.registerZoomReset();
  }


  /**
   * Keyboard shortcut to zoom in
   * Shift + '=' and (optionally) Numpad '+'
   * @protected
   */
  registerZoomIn() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const registerZoomInShortcut = {
      name: Constants.SHORTCUT_NAMES.ZOOM_IN,
      preconditionFn: function (ws) {
        return !(ws && ws.options && ws.options.readOnly) &&
            !(Blockly.Gesture && typeof Blockly.Gesture.inProgress === 'function' && Blockly.Gesture.inProgress());
      },
      callback: function () {
        return this.zooming.zoomIn(workspace);
      }.bind(this)
    };

    Blockly.ShortcutRegistry.registry.register(registerZoomInShortcut);
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        Blockly.utils.KeyCodes.NUM_PLUS,
        registerZoomInShortcut.name,
        true
    );
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        Blockly.ShortcutRegistry.registry.createSerializedKey(
            Blockly.utils.KeyCodes.EQUALS, [Blockly.utils.KeyCodes.SHIFT]
        ),
        registerZoomInShortcut.name,
        true
    );
  }

  /**
   * Keyboard shortcut to zoom out
   * '-' and (optionally) Numpad '-'
   * @protected
   */
  registerZoomOut() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const registerZoomOutShortcut = {
      name: Constants.SHORTCUT_NAMES.ZOOM_OUT,
      preconditionFn: function (ws) {
        return !(ws && ws.options && ws.options.readOnly) &&
            !(Blockly.Gesture && typeof Blockly.Gesture.inProgress === 'function' && Blockly.Gesture.inProgress());
      },
      callback: function () {
        return this.zooming.zoomOut(workspace);
      }.bind(this)
    };

    Blockly.ShortcutRegistry.registry.register(registerZoomOutShortcut);
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        Blockly.utils.KeyCodes.DASH,
        registerZoomOutShortcut.name,
        true
    );
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        Blockly.utils.KeyCodes.NUM_MINUS,
        registerZoomOutShortcut.name,
        true
    );
  }

  /**
   * Keyboard shortcut to reset zoom
   * '0' and (optionally) Numpad '0'
   * @protected
   */
  registerZoomReset() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const registerZoomResetShortcut = {
      name: Constants.SHORTCUT_NAMES.ZOOM_RESET,
      preconditionFn: function (ws) {
        return !(ws && ws.options && ws.options.readOnly) &&
            !(Blockly.Gesture && typeof Blockly.Gesture.inProgress === 'function' && Blockly.Gesture.inProgress());
      },
      callback: function () {
        return this.zooming.zoomReset(workspace);
      }.bind(this)
    };

    Blockly.ShortcutRegistry.registry.register(registerZoomResetShortcut);
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        Blockly.utils.KeyCodes.ZERO,
        registerZoomResetShortcut.name,
        true
    );
    Blockly.ShortcutRegistry.registry.addKeyMapping(
        Blockly.utils.KeyCodes.NUM_ZERO,
        registerZoomResetShortcut.name,
        true
    );
  }


  /**
   * Keyboard shortcut to open the first editable dropdown on the current block.
   * Shift + F
   * @protected
   */
  registerOpenDropdown() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const shortcut = {
      name: Constants.SHORTCUT_NAMES.OPEN_DROPDOWN,
      preconditionFn: (workspace) => {
        return workspace.keyboardAccessibilityMode && !workspace.options.readOnly && !Blockly.Gesture.inProgress();
      },
      callback: (workspace /*, e, shortcut*/) => {
        if (this.navigation.getState(workspace) !== Constants.STATE.WORKSPACE) {
          // Optional: allow from toolbox/flyout by first focusing workspace
          // this.navigation.focusWorkspace(workspace);
          return false;
        }
        const cursor = workspace.getCursor?.();
        if (!cursor || typeof cursor.openDropdown !== 'function') return false;

        const node = cursor.openDropdown();
        if (node && node.getType?.() === Blockly.ASTNode.types.FIELD) {
          // announce selection
          try {
            const field = node.getLocation?.();
            const owner = field?.getSourceBlock?.();
            const label = this.speech.blockToText(owner) || 'block';
            this.speech.update(`Cursor on selector of ${label}.`);
          } catch {}
          return true;
        }

        this.speech.update('No dropdown found on this block.');
        return true; // handled (we gave feedback)
      },
    };

    Blockly.ShortcutRegistry.registry.register(shortcut);

    const shiftF = Blockly.ShortcutRegistry.registry.createSerializedKey(
        Blockly.utils.KeyCodes.F,
        [Blockly.utils.KeyCodes.SHIFT],
    );
    Blockly.ShortcutRegistry.registry.addKeyMapping(shiftF, shortcut.name, true);
  }


  /**
   * Keyboard shortcut to search stacks with Alt+Shift+G.
   * @protected
   */
  registerStackSearch() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const stackSearchShortcut = {
        name: Constants.SHORTCUT_NAMES.STACK_SEARCH,
        preconditionFn: (workspace) => {
            return workspace.keyboardAccessibilityMode;
        },
        callback: (workspace) => {
            // Get the stack search manager for this workspace
            const manager = getStackSearchManager(workspace);
            if (!manager) {
                console.log('No stack search manager found for workspace');
                return false;
            }

            // Call the handler on the manager
            return manager.handleStackSearchShortcut_(workspace);
        },
    };

    Blockly.ShortcutRegistry.registry.register(stackSearchShortcut);

    const altShiftG = Blockly.ShortcutRegistry.registry.createSerializedKey(
        Blockly.utils.KeyCodes.G,
        [Blockly.utils.KeyCodes.ALT, Blockly.utils.KeyCodes.SHIFT]
    );

    Blockly.ShortcutRegistry.registry.addKeyMapping(
        altShiftG,
        stackSearchShortcut.name,
    );
  }

  /**
   * Keyboard shortcut to edit stack labels with Alt+I.
   * @protected
   */
  registerStackLabelEdit() {
    /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
    const stackLabelEditShortcut = {
        name: Constants.SHORTCUT_NAMES.EDIT_STACK_LABEL,
        preconditionFn: (workspace) => {
            return workspace.keyboardAccessibilityMode;
        },
        callback: (workspace) => {
            // Get the stack label manager for this workspace
            const manager = getStackLabelManager(workspace);
            if (!manager) {
                console.log('No stack label manager found for workspace');
                return false;
            }

            // Call the handler on the manager
            return manager.handleStackLabelShortcut_(workspace, this.speech);
        },
    };

    Blockly.ShortcutRegistry.registry.register(stackLabelEditShortcut);

    const shiftI = Blockly.ShortcutRegistry.registry.createSerializedKey(
        Blockly.utils.KeyCodes.I,
        [Blockly.utils.KeyCodes.SHIFT]
    );

    Blockly.ShortcutRegistry.registry.addKeyMapping(
        shiftI,
        stackLabelEditShortcut.name,
    );
  }

  /**
   * Keyboard shortcut ALT + [A-Z] to jump to stack by its label
   * @protected
   */
  registerStackJumpShortcuts() {
    const SHORTCUT_NAME_PREFIX = Constants.SHORTCUT_NAMES.STACK_JUMP_PREFIX || 'STACK_JUMP_';
    for (let code = Blockly.utils.KeyCodes.A; code <= Blockly.utils.KeyCodes.Z; code++) {
      const letter = String.fromCharCode(code); // "A".."Z"
      /** @type {!Blockly.ShortcutRegistry.KeyboardShortcut} */
      const stackJumpShortcut = {
        name: `${SHORTCUT_NAME_PREFIX}_${letter}`,
        preconditionFn: (workspace) => {
          return workspace.keyboardAccessibilityMode;
        },
        callback: (workspace) => {
          const manager = getStackSearchManager(workspace);
          if (!manager) {
            console.log('No stack search manager found for workspace');
            return false;
          }

          const record = manager.findStackByLetter(workspace, letter);
          if (!record) {
            this.speech.update(`No stack found with letter ${String(letter).toUpperCase()}`);
            return false;
          }

          const cursor = workspace.getCursor?.();
          if (!cursor) {
            return false;
          }


          try {
            const astNode = Blockly.ASTNode.createStackNode(record.block);
            cursor.setCurNode(astNode);
            this.speech.update(`Navigated to stack ${record.label}`);
            return true;
          } catch (e) {
            this.speech.update(`Error navigating to stack ${String(letter).toUpperCase()}`);
            return false;
          }
        },
      };

      Blockly.ShortcutRegistry.registry.register(stackJumpShortcut);
      // ALT + Letter
      const altLetter = Blockly.ShortcutRegistry.registry.createSerializedKey(
          code, [Blockly.utils.KeyCodes.ALT]);
      Blockly.ShortcutRegistry.registry.addKeyMapping(altLetter, stackJumpShortcut.name, true);
    }
  }

/**
   * Removes all the keyboard navigation shortcuts.
   * @public
   */
  /**
   * Shows blocks in the flyout for inserting at `target` (e.g. a question's
   * choices). With keyboard navigation on, Edit mode starts at `anchor`, the marker
   * goes on `target` and focus moves into the flyout, so W/S, Enter and Esc work
   * as in the toolbox.
   */
  showChoices(workspace, {items, target, anchor, message}) {
    const flyout = workspace.getFlyout?.();
    if (!flyout) return false;
    workspace.getToolbox()?.clearSelection();
    flyout.show(items);
    if (workspace.keyboardAccessibilityMode && this.accessibleCursor) {
      const cursor = workspace.getCursor();
      // Flyout inserts only happen in Edit mode.
      if (!cursor.editMode) {
        cursor.setCurNode(Blockly.ASTNode.createBlockNode(anchor));
        cursor.toggleEditMode();
      }
      this.navigation.getMarker(workspace).setCurNode(Blockly.ASTNode.createConnectionNode(target));
      this.navigation.focusFlyout(workspace);
    }
    if (message) this.speech?.update(message);
    return true;
  }

  /**
   * Back to Navigation mode on the first stack (e.g. after a new program loads):
   * Edit mode and the marker are cleared, since their blocks may be gone.
   */
  resetNavigation(workspace) {
    // Wait until the load's events are delivered: a delete event for an old block
    // with the same id as a new one would otherwise move the cursor off the stack.
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      workspace.removeChangeListener(listener);
      clearTimeout(fallback);
      this.resetNow_(workspace);
    };
    const listener = () => setTimeout(run, 0);
    workspace.addChangeListener(listener);
    const fallback = setTimeout(run, 200);
  }

  resetNow_(workspace) {
    if (!workspace.keyboardAccessibilityMode) return;
    const cursor = workspace.getCursor();
    if (cursor?.editMode) {
      cursor.editMode = false;
      cursor.editingBlock = null;
      cursor.editConnection = null;
    }
    this.navigation.removeMark(workspace);
    this.navigation.focusWorkspace(workspace);
    const node = cursor?.getCurNode();
    const label = node?.getType() === Blockly.ASTNode.types.STACK ? getStackLabelFromStackNode(node, workspace) : null;
    this.speech?.update(label ? `Navigation mode, on stack ${label}.` : 'Navigation mode.');
  }

  dispose() {
    blockTypes.setNavigationHost(null);
    this.editWatchers_?.forEach((stop) => stop());
    const shortcutNames = Object.values(Constants.SHORTCUT_NAMES);
    for (const name of shortcutNames) {
      Blockly.ShortcutRegistry.registry.unregister(name);
    }
    this.removeShortcutHandlers();
    this.navigation.dispose();
    this.shortcutAssistance?.dispose?.();
    this.modeBadge?.dispose();
  }

  applyToolboxFilter(workspace) {
    const cursor = workspace.getCursor?.();

    // Hide marker visual when flyout is open (both edit and navigation mode)
    this.hideMarker(workspace);

    if (cursor?.editMode) {
      // EDIT MODE: filter by connection compatibility
      this.workspaceContainerFilter.clearWorkspaceFilters(workspace);
      this.flyoutCompatibilityMgr.applyFilter(workspace);
      return;
    }

    // NAVIGATION MODE: only filter when the marker is on the WORKSPACE
    this.workspaceContainerFilter.updateFilter(workspace);
  }

  /**
   * Hides the marker visual element (blue rectangle) when flyout is open
   * @param {!Blockly.WorkspaceSvg} workspace The workspace
   * @protected
   */
  hideMarker(workspace) {
    const marker = this.navigation?.getMarker(workspace);
    marker?.hide();
  }

  /**
   * Announce a message through Speech (screen reader or system voice)
   * @param {string} message The message to announce
   * @protected
   */
  announceToScreenReader(message) {
    this.speech.update(message);
  }
}
