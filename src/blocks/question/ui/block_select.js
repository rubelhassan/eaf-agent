/**
 * A dropdown of blocks shown as their toolbox pictures (a native <select> cannot
 * show images). Accessible as a button + listbox (ARIA "select-only combobox"
 * pattern): the button names the chosen block; Up/Down/Home/End move, Enter or
 * Space chooses, Esc closes. Screen readers hear block names; sighted users see
 * the blocks.
 */

import {blockTypeName} from '../../block_names.js';
import {speakDialogFocus} from '../../../util/dialog_speech.js';

const CLS = 'eaf-bs';

export const BLOCK_SELECT_CSS = `
  .${CLS} { position: relative; }
  .${CLS}-button { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%;
    height: 44px; margin-top: 4px; padding: 4px 8px; border: 1px solid var(--eaf-line, #c9d1d9); border-radius: 6px; background: var(--eaf-surface, #fff); cursor: pointer; }
  .${CLS}-button::after { content: ""; border: 5px solid transparent; border-top-color: var(--eaf-fg-muted, #57606a); margin-top: 5px; }
  .${CLS}-button:focus-visible { outline: 3px solid var(--eaf-focus, #2854C5); outline-offset: 1px; }
  .${CLS}-list { position: absolute; z-index: 5; left: 0; right: 0; top: calc(100% + 4px); max-height: 280px;
    overflow: auto; margin: 0; padding: 4px; list-style: none; background: var(--eaf-surface, #fff); border: 1px solid var(--eaf-line, #c9d1d9);
    border-radius: 8px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18); }
  .${CLS}-option { display: flex; align-items: center; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
  .${CLS}-option[aria-selected="true"] { background: var(--eaf-selected-bg, #eef3fc); }
  .${CLS}-option.${CLS}-active { outline: 2px solid var(--eaf-focus, #2854C5); outline-offset: -2px; }
`;

let idCounter = 0;

export class BlockSelect {
  /**
   * @param {{snapshot: function(!Object, number=): ?SVGElement}} snapshots  A SnapshotRenderer.
   * @param {string} label  Accessible label, e.g. "Block".
   */
  constructor(snapshots, label) {
    this.snapshots_ = snapshots;
    this.items_ = [];
    this.value_ = null;
    this.active_ = 0;
    const id = `${CLS}-${++idCounter}`;

    this.element = document.createElement('div');
    this.element.className = CLS;
    this.button_ = document.createElement('button');
    this.button_.type = 'button';
    this.button_.className = `${CLS}-button`;
    this.button_.setAttribute('aria-haspopup', 'listbox');
    this.button_.setAttribute('aria-expanded', 'false');
    this.button_.dataset.label = label;
    this.list_ = document.createElement('ul');
    this.list_.className = `${CLS}-list`;
    this.list_.id = `${id}-list`;
    this.list_.setAttribute('role', 'listbox');
    this.list_.setAttribute('aria-label', label);
    this.list_.tabIndex = -1;
    this.list_.hidden = true;
    this.button_.setAttribute('aria-controls', this.list_.id);
    this.element.append(this.button_, this.list_);

    this.button_.addEventListener('click', () => (this.isOpen() ? this.close_() : this.open_()));
    this.button_.addEventListener('keydown', (e) => this.onButtonKey_(e));
    this.list_.addEventListener('keydown', (e) => this.onListKey_(e));
    this.list_.addEventListener('focus', () => speakDialogFocus(this.list_));
    this.list_.addEventListener('focusout', (e) => {
      if (!this.element.contains(e.relatedTarget)) this.close_(false);
    });
  }

  /** @returns {?string} The chosen block type. */
  get value() {
    return this.value_;
  }

  /**
   * @param {!Array<!Object>} items  Toolbox block JSON items (at least {type}).
   */
  setItems(items) {
    this.items_ = items;
    this.value_ = items[0]?.type ?? null;
    this.active_ = 0;
    this.renderButton_();
  }

  isOpen() {
    return !this.list_.hidden;
  }

  focus() {
    this.button_.focus();
  }

  // ---- Rendering -----------------------------------------------------------

  picture_(item, height) {
    return this.snapshots_.snapshot(item, height) || document.createTextNode(blockTypeName(item.type));
  }

  renderButton_() {
    const item = this.items_.find((i) => i.type === this.value_);
    this.button_.textContent = '';
    if (item) this.button_.appendChild(this.picture_(item, 34));
    const name = item ? blockTypeName(item.type) : 'none';
    this.button_.setAttribute('aria-label', `${this.button_.dataset.label}: ${name}`);
  }

  renderList_() {
    this.list_.textContent = '';
    this.items_.forEach((item, index) => {
      const option = document.createElement('li');
      option.id = `${this.list_.id}-${index}`;
      option.className = `${CLS}-option`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-label', blockTypeName(item.type));
      option.setAttribute('aria-selected', String(item.type === this.value_));
      option.appendChild(this.picture_(item, 64)); // toolbox size unless very tall
      option.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the list
      option.addEventListener('click', () => this.choose_(index));
      this.list_.appendChild(option);
    });
  }

  // ---- Open / close / choose -----------------------------------------------

  open_() {
    this.renderList_();
    this.list_.hidden = false;
    this.button_.setAttribute('aria-expanded', 'true');
    this.setActive_(Math.max(0, this.items_.findIndex((i) => i.type === this.value_)));
    this.list_.focus();
  }

  close_(refocus = true) {
    if (!this.isOpen()) return;
    this.list_.hidden = true;
    this.button_.setAttribute('aria-expanded', 'false');
    this.list_.removeAttribute('aria-activedescendant');
    if (refocus) this.button_.focus();
  }

  choose_(index) {
    const item = this.items_[index];
    if (!item) return;
    this.value_ = item.type;
    this.renderButton_();
    this.close_();
  }

  setActive_(index) {
    const options = [...this.list_.children];
    if (!options.length) return;
    this.active_ = Math.max(0, Math.min(index, options.length - 1));
    options.forEach((o, i) => o.classList.toggle(`${CLS}-active`, i === this.active_));
    const active = options[this.active_];
    this.list_.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({block: 'nearest'});
    if (document.activeElement === this.list_) speakDialogFocus(this.list_);
  }

  // ---- Keys ------------------------------------------------------------------

  onButtonKey_(event) {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      this.open_();
    }
  }

  onListKey_(event) {
    const moves = {ArrowDown: this.active_ + 1, ArrowUp: this.active_ - 1, Home: 0, End: this.items_.length - 1};
    if (event.key in moves) {
      event.preventDefault();
      this.setActive_(moves[event.key]);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.choose_(this.active_);
    } else if (event.key === 'Escape') {
      // Close only the list, not the surrounding dialog.
      event.preventDefault();
      event.stopPropagation();
      this.close_();
    } else if (event.key === 'Tab') {
      this.close_(false);
    }
  }
}
