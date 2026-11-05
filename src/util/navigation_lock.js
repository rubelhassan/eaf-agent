// @ts-check
// Navigation lock while the assistant works or waits for an answer. Frozen: no editor shortcut runs except
// Escape (the magnifier's keys run ahead of the lock). Read-only: moving and reading work, editing waits. Keys are stopped before Blockly's own keydown
// handler (a capture listener on the document), so the stable navigation files need no change.

import * as Blockly from 'blockly/core';
import {SHORTCUT_NAMES as N} from '../constants.js';

/** Shortcuts that only move, read or show things; everything else changes the program. */
const READ_ONLY_ALLOWED = new Set([
  N.PREVIOUS, N.NEXT, N.IN, N.OUT, N.LAYER_IN, N.LAYER_OUT, N.EXIT, N.TOGGLE_KEYBOARD_NAV, N.COPY,
  N.MOVE_WS_CURSOR_UP, N.MOVE_WS_CURSOR_DOWN, N.MOVE_WS_CURSOR_LEFT, N.MOVE_WS_CURSOR_RIGHT,
  N.OUTPUT_FOCUS, N.RUN_PROGRAM, N.STACK_SEARCH, N.CURSOR_LOC, N.SHOW_SHORTCUTS, N.SHOW_NAV_HINT,
  N.ZOOM_RESET, N.ZOOM_IN, N.ZOOM_OUT,
  // Blockly's own
  'escape', 'copy',
]);

/** While the assistant works only Escape and leaving still run. The magnifier's keys are its own window listener,
 * ahead of the lock, so they always work. */
const FROZEN_ALLOWED = new Set(['escape', N.EXIT]);

/** Mouse targets that edit: blocks, the toolbox and its flyout. Scrolling and zooming stay free. */
const EDITABLE = '.blocklyDraggable, .blocklyToolboxDiv, .blocklyToolbox, .blocklyFlyout';

/** Whether a shortcut may run under a lock ('free', 'read-only' or 'frozen'). */
export function shortcutAllowed(lock, name) {
  if (lock === 'free') return true;
  if (lock === 'frozen') return FROZEN_ALLOWED.has(name);
  return READ_ONLY_ALLOWED.has(name) || name.startsWith(N.STACK_JUMP_PREFIX);
}

const isTyping = (target) => target instanceof Element && !!target.closest('input, textarea, select, [contenteditable="true"]');
// Keys a widget uses itself and keeps from the editor: a listbox's moves and choice (the panel's step list), and
// pressing a button inside an element marked data-own-keys (the assistant panel). Other keys are checked as usual.
const LISTBOX_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' ', 'w', 's', 'q']);
const ownKey = (e) => {
  const target = e.target;
  if (!(target instanceof Element) || !LISTBOX_KEYS.has(e.key) || e.ctrlKey || e.altKey || e.metaKey) return false;
  if (target.getAttribute('role') === 'listbox') return true;
  return (e.key === 'Enter' || e.key === ' ') && target.tagName === 'BUTTON' && !!target.closest('[data-own-keys]');
};

export class NavigationLock {
  /**
   * @param {!Blockly.WorkspaceSvg} workspace
   * @param {{getLock: function(): string, onBlocked: function(string, boolean): void}} options
   *     getLock: 'free', 'read-only' or 'frozen' now; onBlocked: (lock, first) where first is the first blocked key
   *     since the lock began, so the host can say why once and only cue after that
   */
  constructor(workspace, {getLock, onBlocked}) {
    this.workspace = workspace;
    this.getLock = getLock;
    this.onBlocked = onBlocked;
    this.toldFor = null;
    this.onKeyDown = (e) => this.handleKey(e);
    this.onPointerDown = (e) => this.handlePointer(e);
    document.addEventListener('keydown', this.onKeyDown, true);
    workspace.getInjectionDiv().addEventListener('pointerdown', this.onPointerDown, true);
  }

  /** The shortcuts this key would run now (those whose precondition passes). */
  shortcutsFor(e) {
    const registry = Blockly.ShortcutRegistry.registry;
    const names = registry.getShortcutNamesByKeyCode(registry.serializeKeyEvent(e));
    const all = registry.getRegistry();
    return names.filter((name) => {
      const shortcut = all[name];
      return shortcut && (!shortcut.preconditionFn || shortcut.preconditionFn(this.workspace));
    });
  }

  handleKey(e) {
    const lock = this.getLock();
    if (lock === 'free') this.toldFor = null;
    if (lock === 'free' || isTyping(e.target) || ownKey(e)) return;
    const names = this.shortcutsFor(e);
    if (!names.length || names.every((name) => shortcutAllowed(lock, name))) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.blocked(lock);
  }

  handlePointer(e) {
    const lock = this.getLock();
    if (lock === 'free' || !(e.target instanceof Element) || !e.target.closest(EDITABLE)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.blocked(lock);
  }

  blocked(lock) {
    const first = this.toldFor !== lock;
    this.toldFor = lock;
    this.onBlocked(lock, first);
  }

  /** The host calls this after each reply (the lock may have changed), so the next blocked key says why again. */
  reset() {
    this.toldFor = null;
  }

  dispose() {
    document.removeEventListener('keydown', this.onKeyDown, true);
    this.workspace.getInjectionDiv()?.removeEventListener('pointerdown', this.onPointerDown, true);
  }
}
