// @ts-check
/**
 * Visible keyboard-mode cue in the workspace's top-right corner: "Navigation mode"
 * (blue) or "Edit mode" (gold, E toggles). Hidden while keyboard navigation is off
 * (Ctrl+Shift+K). Mode changes are already spoken by Speech, so the badge is
 * aria-hidden and purely visual.
 *
 * It observes `cursor.editMode` and `workspace.keyboardAccessibilityMode` as
 * properties, so every path that changes them (toggle, undo snapshot restore,
 * enable/disable) updates the badge without touching the stable cursor/navigation code.
 */

import {observeProperty} from './observe.js';

const CLS = 'eaf-mode-badge';

const MODE_BADGE_CSS = `
  .${CLS} { position: absolute; top: 10px; right: 16px; z-index: 20; padding: 4px 12px; border-radius: 999px;
    font: 600 13px/1.4 system-ui, sans-serif; pointer-events: none; }
  .${CLS}[hidden] { display: none; }
  .${CLS}-navigation { background: #DCE6FB; color: #1B3A8A; border: 2px solid #2854C5; }
  .${CLS}-edit { background: #EAC452; color: #3d2e07; border: 2px solid #7A5C0E; }
`;

/** @param {!Document} doc */
function ensureStyle(doc) {
  if (doc.getElementById(`${CLS}-style`)) return;
  const style = doc.createElement('style');
  style.id = `${CLS}-style`;
  style.textContent = MODE_BADGE_CSS;
  doc.head.appendChild(style);
}

export class ModeBadge {
  constructor() {
    /** @type {?HTMLElement} */
    this.element_ = null;
    this.enabled_ = true;
    /** @type {!Array<function(): void>} */
    this.unobserve_ = [];
    /** @type {?function(): void} */
    this.update_ = null;
  }

  /**
   * @param {!Blockly.WorkspaceSvg} workspace
   * @param {!Object} cursor  The AccessibleCursor (has `editMode`).
   */
  attach(workspace, cursor) {
    this.dispose();
    const host = workspace.getInjectionDiv?.();
    if (!host) return;
    const doc = host.ownerDocument;
    ensureStyle(doc);
    this.element_ = doc.createElement('div');
    this.element_.className = CLS;
    this.element_.setAttribute('aria-hidden', 'true');
    host.appendChild(this.element_);

    this.update_ = () => {
      const el = this.element_;
      if (!el) return;
      const edit = !!cursor.editMode;
      el.hidden = !this.enabled_ || !workspace.keyboardAccessibilityMode;
      el.textContent = edit ? 'Edit mode' : 'Navigation mode';
      el.className = `${CLS} ${CLS}-${edit ? 'edit' : 'navigation'}`;
    };
    this.unobserve_ = [
      observeProperty(cursor, 'editMode', this.update_),
      observeProperty(workspace, 'keyboardAccessibilityMode', this.update_),
    ];
    this.update_();
  }

  /** Shows or hides the badge (for hosts that don't want it). */
  setEnabled(enabled) {
    this.enabled_ = enabled;
    this.update_?.();
  }

  dispose() {
    this.unobserve_.forEach((restore) => restore());
    this.unobserve_ = [];
    this.element_?.remove();
    this.element_ = null;
    this.update_ = null;
  }
}
