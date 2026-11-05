// @ts-check
/**
 * Visible activity and keyboard cues: Quiz beside Navigation mode or Edit mode.
 * Only the keyboard cue hides when navigation is off. Speech handles announcements.
 *
 * It observes `cursor.editMode` and `workspace.keyboardAccessibilityMode` as
 * properties, so every path that changes them (toggle, undo snapshot restore,
 * enable/disable) updates the badge without touching the stable cursor/navigation code.
 */

import {observeProperty} from './observe.js';
import {Activity, getPolicy, onPolicyChange} from '../blocks/policy.js';

const CLS = 'eaf-mode-badge';
const ROW_CLS = 'eaf-mode-badges';
const QUIZ_CLS = 'eaf-quiz-badge';

const MODE_BADGE_CSS = `
  .${ROW_CLS} { position: absolute; top: 10px; right: 16px; z-index: 20; display: flex; align-items: center;
    gap: 8px; pointer-events: none; }
  .${CLS}, .${QUIZ_CLS} { padding: 4px 12px; border-radius: 999px;
    font: 600 13px/1.4 system-ui, sans-serif; pointer-events: none; }
  .${ROW_CLS}[hidden], .${CLS}[hidden], .${QUIZ_CLS}[hidden] { display: none; }
  .${CLS}-navigation { background: var(--eaf-pill-on-bg, #DCE6FB); color: var(--eaf-accent-strong, #1B3A8A); border: 2px solid var(--eaf-accent, #2854C5); }
  .${CLS}-edit { background: var(--eaf-edit-bg, #EAC452); color: var(--eaf-edit-fg, #3d2e07); border: 2px solid var(--eaf-edit-line, #7A5C0E); }
  .${QUIZ_CLS} { background: var(--eaf-quiz-bg, #FDE2E1); color: var(--eaf-quiz-fg, #7F1D1D); border: 2px solid var(--eaf-quiz-line, #B91C1C); }
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
    /** @type {?HTMLElement} */
    this.row_ = null;
    /** @type {?HTMLElement} */
    this.quiz_ = null;
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
    this.quiz_ = doc.createElement('div');
    this.quiz_.className = QUIZ_CLS;
    this.quiz_.textContent = 'Quiz';
    this.quiz_.setAttribute('aria-hidden', 'true');
    this.row_ = doc.createElement('div');
    this.row_.className = ROW_CLS;
    this.row_.append(this.quiz_, this.element_);
    host.appendChild(this.row_);

    this.update_ = () => {
      const el = this.element_;
      if (!el) return;
      const edit = !!cursor.editMode;
      el.hidden = !this.enabled_ || !workspace.keyboardAccessibilityMode;
      const {activity, teacherMode} = getPolicy(workspace);
      this.quiz_.hidden = !this.enabled_ || teacherMode || activity !== Activity.QUIZ;
      this.row_.hidden = el.hidden && this.quiz_.hidden;
      el.textContent = edit ? 'Edit mode' : 'Navigation mode';
      el.className = `${CLS} ${CLS}-${edit ? 'edit' : 'navigation'}`;
    };
    this.unobserve_ = [
      observeProperty(cursor, 'editMode', this.update_),
      observeProperty(workspace, 'keyboardAccessibilityMode', this.update_),
      onPolicyChange(workspace, this.update_),
    ];
    this.update_();
  }

  /** Shows or hides both cues (for hosts that don't want them). */
  setEnabled(enabled) {
    this.enabled_ = enabled;
    this.update_?.();
  }

  dispose() {
    this.unobserve_.forEach((restore) => restore());
    this.unobserve_ = [];
    this.row_?.remove();
    this.element_ = null;
    this.row_ = null;
    this.quiz_ = null;
    this.update_ = null;
  }
}
