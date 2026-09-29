/**
 * Keyboard navigation model for the question popover, kept free of
 * the DOM so it can be tested headless. Mirrors the workspace keys:
 *   W/S  previous/next row          A/D  previous/next control within the row
 *   F    into the row's detail list  Q    out of the detail list, or close at top level
 *   Esc  close
 */

export const PopoverAction = Object.freeze({
  FOCUS: 'focus',
  CLOSE: 'close',
  NONE: 'none',
});

/**
 * @typedef {Object} PopoverRow
 * @property {string} id
 * @property {number} controls  Number of controls in the row (0 for text-only rows).
 * @property {number=} details  Number of items in the row's detail list (0 or absent = none).
 */

/**
 * Where focus is: a row (control -1 = the row itself), a control in it, or an
 * item of its detail list.
 * @typedef {{row: number, control: number, detail: number}} PopoverFocus
 */

export class PopoverModel {
  /** @param {!Array<!PopoverRow>} rows */
  constructor(rows) {
    this.rows = rows;
    /** @type {!PopoverFocus} */
    this.focus = {row: 0, control: -1, detail: -1};
  }

  /** Replaces the rows (e.g. after a hint is revealed), keeping focus in range. */
  setRows(rows) {
    this.rows = rows;
    const row = Math.min(this.focus.row, rows.length - 1);
    const current = rows[row];
    this.focus = {
      row,
      control: Math.min(this.focus.control, (current.controls || 0) - 1),
      detail: this.focus.detail >= 0 ? Math.min(this.focus.detail, (current.details || 0) - 1) : -1,
    };
  }

  /** Focus on a specific row (control and detail cleared). */
  focusRow(row) {
    this.focus = {row: Math.max(0, Math.min(row, this.rows.length - 1)), control: -1, detail: -1};
  }

  /**
   * @param {string} key  KeyboardEvent.key (case-insensitive for letters).
   * @returns {{action: string, focus?: !PopoverFocus, message?: string}}
   */
  handleKey(key) {
    const k = key.length === 1 ? key.toLowerCase() : key;
    const {row, control, detail} = this.focus;
    const current = this.rows[row];

    if (k === 'Escape') return {action: PopoverAction.CLOSE};

    if (detail >= 0) {
      // Inside a row's detail list.
      if (k === 'w') return this.moveTo({row, control: -1, detail: Math.max(0, detail - 1)});
      if (k === 's') return this.moveTo({row, control: -1, detail: Math.min(current.details - 1, detail + 1)});
      if (k === 'q') return this.moveTo({row, control: -1, detail: -1});
      return {action: PopoverAction.NONE};
    }

    switch (k) {
      case 'w':
        return this.moveTo({row: Math.max(0, row - 1), control: -1, detail: -1});
      case 's':
        return this.moveTo({row: Math.min(this.rows.length - 1, row + 1), control: -1, detail: -1});
      case 'a':
        if (!current.controls) return {action: PopoverAction.NONE};
        return this.moveTo({row, control: Math.max(0, control - 1), detail: -1});
      case 'd':
        if (!current.controls) return {action: PopoverAction.NONE};
        return this.moveTo({row, control: Math.min(current.controls - 1, control + 1), detail: -1});
      case 'f':
        if (!current.details) return {action: PopoverAction.NONE, message: 'Nothing to open here.'};
        return this.moveTo({row, control: -1, detail: 0});
      case 'q':
        return {action: PopoverAction.CLOSE};
      default:
        return {action: PopoverAction.NONE};
    }
  }

  moveTo(focus) {
    this.focus = focus;
    return {action: PopoverAction.FOCUS, focus};
  }
}
