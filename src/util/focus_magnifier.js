// @ts-check
/**
 * Focus magnifier: an enlarged copy of the focused part of the program in a lens below (or above) it, at two
 * levels. The lens is aria-hidden, takes no focus and no pointer input; the workspace doesn't move or zoom. While a
 * text field is edited, the real input is enlarged instead, so its caret, selection and screen reader echo stay native.
 * Ctrl+Shift+Plus raises the level and Ctrl+Shift+Minus lowers it (also inside a field editor); Escape turns it off.
 */

import * as Blockly from 'blockly/core';

const CLS = 'eaf-magnifier';

/** Magnification of each level, relative to the size on screen now. */
export const LEVEL_SCALE = Object.freeze({1: 2, 2: 4});
export const MAX_LEVEL = 2;
const LINES = {0: 'Magnifier off.', 1: 'Magnifier level 1.', 2: 'Magnifier level 2.'};

// The lens takes at most this share of the workspace; the copy is cropped, never shrunk.
const LENS_MAX_WIDTH = 0.9;
const LENS_MAX_HEIGHT = 0.4;
const GAP_PX = 12;
const EDGE_PX = 8;
// Room around the shown part, in screen pixels before magnifying.
const CONTEXT_PX = 6;
// Around a connection: enough to show the blocks on both sides of it.
const CONNECTION_BOX_PX = {width: 64, height: 28};
// A dropdown menu was placed by Blockly at its normal size; past this it would run off the screen.
const DROPDOWN_MAX_SCALE = 2;
// The cursor's outline around a field being edited, at workspace scale 1, if it can't be measured.
const EDIT_OUTLINE = {color: '#cc0a0a', width: 3, radius: 10};

const CSS = `
  .${CLS} { position: absolute; z-index: 25; box-sizing: border-box; overflow: hidden; pointer-events: none;
    background: var(--eaf-surface, #fff); border: 3px solid var(--eaf-accent-strong, #1B3A8A); border-radius: 6px; box-shadow: 0 4px 14px rgba(0,0,0,.25);
    transition: left 120ms ease, top 120ms ease; }
  .${CLS}[hidden] { display: none; }
  .${CLS} > svg { position: static; display: block; overflow: hidden; background: transparent; }
  .${CLS}-outline { fill: none; stroke: var(--eaf-accent-strong, #1B3A8A); stroke-width: 4; }
  .${CLS}-editor { transform-origin: 0 0; }
  .${CLS}-editor .blocklyHtmlInput { outline: var(--eaf-edit-outline-width) solid var(--eaf-edit-outline-color);
    outline-offset: calc(var(--eaf-edit-outline-width) / -2);
    border-radius: var(--eaf-edit-outline-radius) !important; /* Blockly sets the input's own radius inline */ }
  @media (prefers-reduced-motion: reduce) { .${CLS} { transition: none; } }
  @media (forced-colors: active) {
    .${CLS} { border-color: CanvasText; background: Canvas; }
    .${CLS}-outline { stroke: Highlight; }
  }
`;

/** @param {!Document} doc */
function ensureStyle(doc) {
  if (doc.getElementById(`${CLS}-style`)) return;
  const style = doc.createElement('style');
  style.id = `${CLS}-style`;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

/** @typedef {{left: number, top: number, width: number, height: number}} Box */

const boxOf = (r) => ({left: r.left, top: r.top, width: r.width, height: r.height});
const grow = (b, by) => ({left: b.left - by, top: b.top - by, width: b.width + 2 * by, height: b.height + 2 * by});
const union = (a, b) => {
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  return {left, top, width: Math.max(a.left + a.width, b.left + b.width) - left,
    height: Math.max(a.top + a.height, b.top + b.height) - top};
};

/**
 * Where the lens goes and what part of the screen it shows. All boxes in screen pixels; the result's lens is
 * relative to the host. The crop keeps the shown part's start (where reading starts) and is cut to fit the lens.
 * @param {{shown: !Box, avoid: !Box, host: !Box, scale: number}} options
 *     shown: what to enlarge; avoid: what the lens must not cover (the focused block); host: the workspace
 * @returns {{crop: !Box, lens: !Box}}
 */
export function lensLayout({shown, avoid, host, scale}) {
  const maxWidth = host.width * LENS_MAX_WIDTH;
  const maxHeight = host.height * LENS_MAX_HEIGHT;
  const wanted = grow(shown, CONTEXT_PX);
  const crop = {...wanted, width: Math.min(wanted.width, maxWidth / scale), height: Math.min(wanted.height, maxHeight / scale)};

  const room = {
    below: host.top + host.height - EDGE_PX - (avoid.top + avoid.height + GAP_PX),
    above: avoid.top - GAP_PX - (host.top + EDGE_PX),
  };
  const side = crop.height * scale <= room.below || room.below >= room.above ? 'below' : 'above';
  // Never over the focused block: a lens with too little room shows less.
  crop.height = Math.max(0, Math.min(crop.height, room[side] / scale));
  const width = crop.width * scale;
  const height = crop.height * scale;
  const top = side === 'below' ? avoid.top + avoid.height + GAP_PX : avoid.top - GAP_PX - height;
  const left = Math.min(Math.max(avoid.left, host.left + EDGE_PX), host.left + host.width - EDGE_PX - width);
  return {crop, lens: {left: left - host.left, top: top - host.top, width, height}};
}

/** The DOM's measurements; tests pass a fake. */
const domGeometry = {
  rect: (el) => boxOf(el.getBoundingClientRect()),
  /** Local to screen matrix of an SVG element, or null. */
  matrix: (el) => el.getScreenCTM?.() || null,
  /** A workspace point on the screen. */
  point: (ws, x, y) => Blockly.utils.svgMath.wsToScreenCoordinates(ws, new Blockly.utils.Coordinate(x, y)),
  /**
   * The cursor's outline around the focused field (colour, stroke and corner radius in screen pixels), or null.
   * @returns {?{color: string, width: number, radius: number}}
   */
  cursorOutline(ws) {
    const marker = [...ws.getParentSvg().querySelectorAll('.blocklyCursor .blocklyVerticalMarker')]
        .find((el) => el.style.display !== 'none' && el.getBoundingClientRect().width > 0);
    if (!marker) return null;
    const scale = marker.getBoundingClientRect().width / (Number(marker.getAttribute('width')) || 1);
    const style = getComputedStyle(marker);
    return {color: style.stroke, width: parseFloat(style.strokeWidth) * scale,
      radius: Number(marker.getAttribute('rx') || 0) * scale};
  },
  /** The workspace's own area on the screen: its svg without the toolbox, which sits over its left side. */
  area(ws) {
    const box = boxOf(ws.getParentSvg().getBoundingClientRect());
    const {left = 0, top = 0} = ws.getMetricsManager?.()?.getAbsoluteMetrics?.() || {};
    return {left: box.left + left, top: box.top + top, width: box.width - left, height: box.height - top};
  },
};

const ctrlShiftOnly = (e) => !!e.ctrlKey && !!e.shiftKey && !e.altKey && !e.metaKey;

/** Ctrl+Shift+Plus by physical key: e.key differs with the layout, and Shift turns "=" into "+". */
export const isRaiseKey = (e) => (e.code === 'Equal' || e.code === 'NumpadAdd') && ctrlShiftOnly(e);

/** Ctrl+Shift+Minus by physical key (Shift turns "-" into "_"). */
export const isLowerKey = (e) => (e.code === 'Minus' || e.code === 'NumpadSubtract') && ctrlShiftOnly(e);

const isConnection = (type) => [Blockly.ASTNode.types.INPUT, Blockly.ASTNode.types.NEXT,
  Blockly.ASTNode.types.PREVIOUS, Blockly.ASTNode.types.OUTPUT].includes(type);

export class FocusMagnifier {
  /**
   * @param {{geometry?: typeof domGeometry, schedule?: function(function()): void, say?: function(string): void}=}
   *     options schedule: when a redraw runs (once a frame by default); say: speaks the on-demand key's lines
   */
  constructor({geometry = domGeometry, schedule = null, say = () => {}} = {}) {
    this.geometry_ = geometry;
    this.schedule_ = schedule;
    this.say_ = say;
    this.level_ = 0;
    /** @type {?Blockly.WorkspaceSvg} */
    this.workspace_ = null;
    /** The workspace whose cursor moved last (the main one or its flyout's). */
    this.focusWs_ = null;
    /** @type {?HTMLElement} */
    this.lens_ = null;
    this.pending_ = false;
    /** @type {?HTMLElement} the enlarged editor or menu, and its transform before */
    this.enlarged_ = null;
    this.listeners_ = new Set();
    this.cleanup_ = [];
  }

  /** @param {!Blockly.WorkspaceSvg} workspace */
  attach(workspace) {
    this.detach_();
    const host = workspace.getInjectionDiv?.();
    if (!host) return;
    const doc = host.ownerDocument;
    ensureStyle(doc);
    this.workspace_ = workspace;
    this.focusWs_ = workspace;
    this.lens_ = doc.createElement('div');
    this.lens_.className = CLS;
    this.lens_.setAttribute('aria-hidden', 'true');
    this.lens_.hidden = true;
    host.appendChild(this.lens_);

    const listen = (ws) => {
      const fn = (e) => this.onEvent_(ws, e);
      ws.addChangeListener(fn);
      this.cleanup_.push(() => ws.removeChangeListener(fn));
    };
    listen(workspace);
    const flyoutWs = workspace.getFlyout?.()?.getWorkspace?.();
    if (flyoutWs) listen(flyoutWs);

    // On the window in the capture phase: ahead of the field editor, the assistant's and the runner's Escape.
    const win = doc.defaultView;
    const onKeyDown = (e) => this.onKeyDown_(e);
    win?.addEventListener('keydown', onKeyDown, true);
    this.cleanup_.push(() => win?.removeEventListener('keydown', onKeyDown, true));

    const onFocusIn = (e) => this.onFocusIn_(e.target);
    const onFocusOut = (e) => this.onFocusOut_(e.target, e.relatedTarget);
    doc.addEventListener('focusin', onFocusIn);
    doc.addEventListener('focusout', onFocusOut);
    this.cleanup_.push(() => {
      doc.removeEventListener('focusin', onFocusIn);
      doc.removeEventListener('focusout', onFocusOut);
    });
  }

  level() {
    return this.level_;
  }

  /** Sets the level (0 off, 1, 2) without saying anything; the Settings select uses it. */
  setLevel(level) {
    const next = Math.max(0, Math.min(MAX_LEVEL, Math.round(Number(level) || 0)));
    if (next === this.level_) return;
    this.level_ = next;
    this.listeners_.forEach((fn) => fn(next));
    if (this.enlarged_) this.scaleEditor_(this.enlarged_, next);
    this.redraw();
  }

  /** Ctrl+Shift+Plus: one level up (2 stays 2). @returns {string} what to say */
  raise() {
    this.setLevel(this.level_ + 1);
    return LINES[this.level_];
  }

  /** Ctrl+Shift+Minus: one level down; from level 1 the lens is off. @returns {string} what to say */
  lower() {
    this.setLevel(this.level_ - 1);
    return LINES[this.level_];
  }

  /** Escape: off, if its lens or enlarged editor shows now. @returns {?string} what to say, or null to leave Escape */
  exit() {
    if (!this.level_ || !(this.enlarged_ || (this.visible_() && this.target_()))) return null;
    this.setLevel(0);
    return LINES[0];
  }

  /**
   * Called with the new level on every change.
   * @returns {function(number): void} unsubscribe
   */
  onChange(fn) {
    this.listeners_.add(fn);
    return () => this.listeners_.delete(fn);
  }

  onKeyDown_(e) {
    const raise = isRaiseKey(e);
    if (raise || isLowerKey(e)) {
      // Elsewhere the browser keeps them (page zoom). Nothing else uses them, so others may still see them.
      if (!this.workspace_?.keyboardAccessibilityMode || !this.inProgram_(e.target)) return;
      e.preventDefault();
      this.say_(raise ? this.raise() : this.lower());
      return;
    }
    this.takeEscape(e);
  }

  /**
   * Escape turns a showing magnifier off, and nothing else gets that press. Other window listeners that also act
   * on Escape (the runner) call this first, so the order they were added in doesn't matter.
   * @returns {boolean} whether it took the press
   */
  takeEscape(e) {
    if (e.key !== 'Escape' || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return false;
    const line = this.exit();
    if (!line) return false;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.say_(line);
    return true;
  }

  /** The workspace, its flyout, or a field editor. */
  inProgram_(target) {
    if (!target?.closest) return false;
    const ws = /** @type {!Blockly.WorkspaceSvg} */ (this.workspace_);
    return ws.getInjectionDiv().contains(target) || ws.getParentSvg?.() === target ||
      !!target.closest('.blocklyWidgetDiv, .blocklyDropDownDiv');
  }

  onEvent_(ws, e) {
    if (e.type === Blockly.Events.MARKER_MOVE && e.isCursor) this.focusWs_ = ws;
    if (this.level_) this.redraw();
  }

  /** Redraws at most once a frame. */
  redraw() {
    if (this.pending_ || !this.lens_) return;
    this.pending_ = true;
    const run = () => {
      this.pending_ = false;
      this.draw_();
    };
    const schedule = this.schedule_ || ((fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 0)));
    schedule(run);
  }

  /** What the lens shows for the cursor now, or null. */
  target_() {
    const node = this.focusWs_?.getCursor?.()?.getCurNode?.();
    if (!node) return null;
    const type = node.getType();
    const block = node.getSourceBlock?.();
    if (!block?.getSvgRoot) return null;
    const blockBox = this.geometry_.rect(block.getSvgRoot());
    if (type === Blockly.ASTNode.types.FIELD) {
      const fieldRoot = node.getLocation().getSvgRoot?.();
      const fieldBox = fieldRoot ? this.geometry_.rect(fieldRoot) : blockBox;
      return {block, blockBox, shown: this.level_ === 1 ? blockBox : fieldBox, outline: fieldBox};
    }
    if (isConnection(type)) {
      const connection = node.getLocation();
      const at = this.geometry_.point(this.focusWs_, connection.x, connection.y);
      const {width, height} = CONNECTION_BOX_PX;
      const point = {left: at.x - width / 2, top: at.y - height / 2, width, height};
      return {block, blockBox, shown: this.level_ === 1 ? union(blockBox, point) : point, outline: point};
    }
    return {block, blockBox, shown: blockBox, outline: blockBox};
  }

  hide_() {
    if (this.lens_) this.lens_.hidden = true;
  }

  /** Whether the lens should show at all now. */
  visible_() {
    const ws = this.workspace_;
    if (!this.level_ || !ws?.keyboardAccessibilityMode || this.enlarged_) return false;
    const doc = this.lens_.ownerDocument;
    // Only while the program has focus, and never over a dialog.
    const active = doc.activeElement;
    const inWorkspace = !!active && (ws.getInjectionDiv().contains(active) || ws.getParentSvg?.() === active);
    const dialog = [...doc.querySelectorAll('[role="dialog"], [aria-modal="true"]')].some((d) => d.getClientRects().length > 0);
    return inWorkspace && !dialog;
  }

  draw_() {
    if (!this.lens_) return;
    const target = this.visible_() ? this.target_() : null;
    const root = target?.block.getSvgRoot();
    const matrix = root ? this.geometry_.matrix(root) : null;
    if (!target || !matrix) {
      this.hide_();
      return;
    }
    const scale = LEVEL_SCALE[this.level_];
    const host = this.area_();
    const {crop, lens} = lensLayout({shown: target.shown, avoid: target.blockBox, host, scale});
    if (lens.height < 1 || lens.width < 1) {
      this.hide_();
      return;
    }
    // The lens lives in the injection div, which also holds the toolbox.
    const origin = this.geometry_.rect(this.workspace_.getInjectionDiv());
    this.lens_.replaceChildren(this.copy_(root, matrix, {crop, scale, outline: target.outline, size: lens}));
    Object.assign(this.lens_.style, {left: `${host.left - origin.left + lens.left}px`, top: `${host.top - origin.top + lens.top}px`,
      width: `${lens.width}px`, height: `${lens.height}px`});
    this.lens_.hidden = false;
  }

  /** The workspace's own area on the screen (without the toolbox). */
  area_() {
    return this.geometry_.area(this.workspace_);
  }

  /** The block's SVG copied without ids, mapped so the crop fills the lens, and the focused part outlined. */
  copy_(root, m, {crop, scale, outline, size}) {
    const SVG = 'http://www.w3.org/2000/svg';
    const doc = this.lens_.ownerDocument;
    const svg = doc.createElementNS(SVG, 'svg');
    // The workspace's renderer and theme classes, so the copy is styled like the original.
    svg.setAttribute('class', this.workspace_.getParentSvg?.()?.getAttribute('class') || '');
    svg.setAttribute('width', String(size.width));
    svg.setAttribute('height', String(size.height));
    const group = doc.createElementNS(SVG, 'g');
    group.setAttribute('transform', `translate(${-crop.left * scale} ${-crop.top * scale}) scale(${scale}) ` +
      `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`);
    const copy = /** @type {!Element} */ (root.cloneNode(true));
    copy.removeAttribute('transform');
    copy.removeAttribute('id');
    copy.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    group.appendChild(copy);
    const frame = doc.createElementNS(SVG, 'rect');
    frame.setAttribute('class', `${CLS}-outline`);
    frame.setAttribute('x', String((outline.left - crop.left) * scale));
    frame.setAttribute('y', String((outline.top - crop.top) * scale));
    frame.setAttribute('width', String(outline.width * scale));
    frame.setAttribute('height', String(outline.height * scale));
    svg.append(group, frame);
    return svg;
  }

  // ---- Field editors: the real input or menu, enlarged ----------------------------

  onFocusIn_(target) {
    if (!target?.closest) return;
    const editor = target.closest('.blocklyWidgetDiv') || target.closest('.blocklyDropDownDiv');
    if (editor && this.workspace_) {
      if (this.enlarged_ !== editor) this.enlarge_(/** @type {!HTMLElement} */ (editor));
      this.hide_();
      return;
    }
    if (this.level_) this.redraw();
  }

  onFocusOut_(target, next) {
    const editor = this.enlarged_;
    if (!editor || !target || !editor.contains(target)) return;
    if (next && editor.contains(next)) return;
    this.restoreEnlarged_();
    if (this.level_) this.redraw();
  }

  enlarge_(editor) {
    this.restoreEnlarged_();
    this.enlarged_ = editor;
    editor.dataset.eafTransform = editor.style.transform || '';
    this.scaleEditor_(editor, this.level_);
  }

  /** Applies a level to an open editor; level 0 takes it back to its normal size. */
  scaleEditor_(editor, level) {
    if (!level) {
      editor.classList.remove(`${CLS}-editor`);
      ['color', 'width', 'radius'].forEach((part) => editor.style.removeProperty(`--eaf-edit-outline-${part}`));
      editor.style.transform = editor.dataset.eafTransform || '';
      editor.querySelector('.blocklyDropDownContent')?.style.removeProperty('zoom');
      return;
    }
    if (editor.classList.contains('blocklyDropDownDiv')) {
      const content = /** @type {?HTMLElement} */ (editor.querySelector('.blocklyDropDownContent'));
      content?.style.setProperty('zoom', String(Math.min(LEVEL_SCALE[level], DROPDOWN_MAX_SCALE)));
      return;
    }
    editor.classList.add(`${CLS}-editor`);
    // The field's outline from edit mode goes with the input, so the focus stays easy to see.
    const scale = this.workspace_?.scale || 1;
    const outline = this.geometry_.cursorOutline?.(this.workspace_) ||
      {...EDIT_OUTLINE, width: EDIT_OUTLINE.width * scale, radius: EDIT_OUTLINE.radius * scale};
    editor.style.setProperty('--eaf-edit-outline-color', outline.color);
    editor.style.setProperty('--eaf-edit-outline-width', `${outline.width}px`);
    editor.style.setProperty('--eaf-edit-outline-radius', `${outline.radius}px`);
    editor.style.transform = this.editorTransform_(editor, LEVEL_SCALE[level]);
  }

  /**
   * Moves the input below its block (like the lens) and scales it, as far as the workspace has room. Measured from
   * the field, which Blockly places the input over: the input itself may not be in place yet when it gets focus.
   */
  editorTransform_(editor, levelScale) {
    const node = this.focusWs_?.getCursor?.()?.getCurNode?.();
    const fieldRoot = node?.getType() === Blockly.ASTNode.types.FIELD ? node.getLocation().getSvgRoot?.() : null;
    const box = this.geometry_.rect(fieldRoot || editor);
    const host = this.area_();
    const block = node?.getSourceBlock?.();
    const avoid = block?.getSvgRoot ? this.geometry_.rect(block.getSvgRoot()) : box;
    const scale = box.width ? Math.min(levelScale, (host.width * LENS_MAX_WIDTH) / box.width) : levelScale;
    const {lens} = lensLayout({shown: box, avoid, host, scale});
    const dx = host.left + lens.left - box.left;
    const dy = host.top + lens.top - box.top;
    return `translate(${dx}px, ${dy}px) scale(${scale})`;
  }

  restoreEnlarged_() {
    const editor = this.enlarged_;
    if (!editor) return;
    this.scaleEditor_(editor, 0);
    delete editor.dataset.eafTransform;
    this.enlarged_ = null;
  }

  dispose() {
    this.detach_();
    this.listeners_.clear();
  }

  detach_() {
    this.restoreEnlarged_();
    this.cleanup_.forEach((fn) => fn());
    this.cleanup_ = [];
    this.lens_?.remove();
    this.lens_ = null;
    this.workspace_ = null;
    this.focusWs_ = null;
  }
}
