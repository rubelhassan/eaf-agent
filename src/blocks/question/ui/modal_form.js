/**
 * Shared shell for accessible modal forms (Edit question, Task tests): a labelled
 * dialog over a backdrop, focus trapped inside, Esc cancels, and keys typed in the
 * form never reach workspace or page shortcuts. Subclasses build the body.
 */

export const CLS = 'eaf-qd';

export const MODAL_FORM_CSS = `
  .${CLS}-backdrop { position: fixed; inset: 0; z-index: 1000; background: rgba(15, 23, 42, 0.45);
    display: flex; align-items: center; justify-content: center; }
  .${CLS} { width: min(640px, 94vw); max-height: 88vh; display: flex; flex-direction: column;
    background: #fff; color: #1f2328; border-radius: 12px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.3);
    font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .${CLS}-title { margin: 0; padding: 16px 20px 8px; font-size: 18px; }
  .${CLS}-body { padding: 4px 20px 12px; overflow: auto; }
  .${CLS}-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid #e5e7eb; }
  .${CLS} fieldset { border: 1px solid #e5e7eb; border-radius: 8px; margin: 10px 0; padding: 8px 12px 12px; }
  .${CLS} legend { font-weight: 600; padding: 0 4px; }
  .${CLS} .${CLS}-field { display: block; margin-top: 8px; font-weight: 600; font-size: 13px; }
  .${CLS} input[type="text"], .${CLS} input[type="number"], .${CLS} textarea {
    display: block; width: 100%; box-sizing: border-box; margin-top: 4px; padding: 6px 8px;
    border: 1px solid #c9d1d9; border-radius: 6px; font: inherit; font-weight: 400; }
  .${CLS} textarea { min-height: 56px; resize: vertical; }
  .${CLS} .${CLS}-help { font-size: 12px; color: #57606a; font-weight: 400; margin: 2px 0 0; }
  .${CLS} .${CLS}-choice { display: inline-flex; align-items: center; gap: 6px; margin: 4px 16px 0 0; font-weight: 400; }
  .${CLS}-hint { display: flex; gap: 6px; align-items: flex-start; margin-top: 8px; }
  .${CLS}-hint textarea { margin-top: 0; min-height: 40px; }
  .${CLS}-pickrow { display: flex; align-items: flex-end; gap: 10px; }
  .${CLS}-pickrow > .${CLS}-field { flex: 1; }
  .${CLS}-pickrow select { height: 44px; }
  .${CLS} select { display: block; width: 100%; margin-top: 4px; padding: 6px 8px; border: 1px solid #c9d1d9;
    border-radius: 6px; background: #fff; font: inherit; font-weight: 400; }
  .${CLS}-pickrow > .${CLS}-btn { margin-bottom: 1px; height: 44px; }
  .${CLS}-chosen { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
  .${CLS}-chip { display: flex; align-items: center; gap: 8px; padding: 4px 6px 4px 8px;
    border: 1px solid #e5e7eb; border-radius: 8px; background: #f8fafc; }
  .${CLS}-chip svg { flex: none; }
  .${CLS}-btn { font: inherit; font-size: 13px; padding: 5px 12px; border: 1px solid #c9d1d9;
    border-radius: 6px; background: #fff; color: #1f2328; cursor: pointer; }
  .${CLS}-btn:hover { background: #f6f8fa; }
  .${CLS}-btn[aria-disabled="true"] { color: #8c959f; cursor: default; }
  .${CLS}-btn[aria-pressed="true"] { background: #eef3fc; border-color: #2854C5; color: #1B3A8A; }
  .${CLS}-primary { background: #2854C5; border-color: #2854C5; color: #fff; }
  .${CLS}-primary:hover { background: #1f44a3; }
  .${CLS} :focus-visible { outline: 3px solid #2854C5; outline-offset: 1px; }
`;

let idCounter = 0;
export const uid = (name) => `${CLS}-${name}-${++idCounter}`;

export class ModalForm {
  constructor() {
    /** @type {?HTMLElement} */
    this.backdrop_ = null;
    /** @type {?HTMLElement} */
    this.dialog_ = null;
    this.returnFocus_ = null;
  }

  /** @returns {boolean} */
  isOpen() {
    return !!this.backdrop_;
  }

  /**
   * Builds and shows the dialog, then focuses its first control.
   * @param {string} titleText
   * @param {!Array<!Node>} sections  Body content.
   * @param {!Array<!HTMLElement>} footerButtons
   */
  openShell_(titleText, sections, footerButtons) {
    this.close_();
    this.returnFocus_ = document.activeElement;
    this.backdrop_ = document.createElement('div');
    this.backdrop_.className = `${CLS}-backdrop`;
    const dialog = document.createElement('div');
    dialog.className = CLS;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const titleId = uid('title');
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.addEventListener('keydown', (e) => this.onKeyDown_(e));
    this.backdrop_.appendChild(dialog);
    this.dialog_ = dialog;

    const title = document.createElement('h2');
    title.className = `${CLS}-title`;
    title.id = titleId;
    title.textContent = titleText;
    const body = document.createElement('div');
    body.className = `${CLS}-body`;
    body.append(...sections);
    const footer = document.createElement('div');
    footer.className = `${CLS}-footer`;
    footer.append(...footerButtons);
    dialog.append(title, body, footer);
    document.body.appendChild(this.backdrop_);
  }

  /** Focuses the dialog's first control. */
  focusFirst_() {
    this.dialog_?.querySelector('input, textarea, select, button')?.focus();
  }

  close_() {
    if (!this.backdrop_) return;
    this.backdrop_.remove();
    this.backdrop_ = null;
    const target = this.returnFocus_;
    this.returnFocus_ = null;
    if (target?.isConnected && typeof target.focus === 'function') target.focus();
  }

  onKeyDown_(event) {
    // Form keys never reach workspace or page shortcuts.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close_();
    } else if (event.key === 'Tab') {
      this.trapFocus_(event);
    }
  }

  trapFocus_(event) {
    const focusable = [...this.dialog_.querySelectorAll('input:not([disabled]), select, textarea, button')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // ---- Small DOM helpers ---------------------------------------------------

  fieldset_(legendText) {
    const set = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = legendText;
    set.appendChild(legend);
    return set;
  }

  labelled_(text, control, helpText) {
    const label = document.createElement('label');
    label.className = `${CLS}-field`;
    label.append(text, control);
    if (helpText) label.appendChild(this.help_(helpText));
    return label;
  }

  help_(text) {
    const p = document.createElement('p');
    p.className = `${CLS}-help`;
    p.textContent = text;
    return p;
  }

  input_(type, value) {
    const input = document.createElement('input');
    input.type = type;
    input.value = value ?? '';
    return input;
  }

  textarea_(value) {
    const area = document.createElement('textarea');
    area.value = value ?? '';
    return area;
  }

  button_(text, onClick, primary = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${CLS}-btn${primary ? ` ${CLS}-primary` : ''}`;
    button.textContent = text;
    button.addEventListener('click', onClick);
    return button;
  }
}
