// util/navigational_hint.js
import * as Blockly from 'blockly/core';
import {getStackLabelFromStackNode} from '../labels_and_comments/stack_labels';
import {Speech} from '../audio/speech';
import {sayDialog, speakDialogFocus} from './dialog_speech.js';

export class NavigationalHint {
    /**
     * @param {{speech?: {friendlyName?: (b:any)=>string, update?:(m:string)=>void}}=} opts
     */
    constructor(opts = {}) {
        // ---- existing behavior kept ----
        this.speech = opts.speech || /** @type {Speech|undefined} */ (null);

        // ---- new modal state ----
        this.root = null;
        this.listEl = null;
        this._modeLock = null;

        this.items = [];
        this.rowsMaster = [];  // rendered rows (from compute() or setHints())
        this.index = -1;
        this.isOpen = false;
        this.prevFocus = null;

        // binds
        this._onKeydownInDialog = this._onKeydownInDialog.bind(this);
        this._onClickBackdrop = this._onClickBackdrop.bind(this);
        this._onFocusInGuard = this._onFocusInGuard.bind(this);
    }

    /* ========================================================================================
     * EXISTING FUNCTIONALITY (kept intact) + internal helpers it relies on
     * ====================================================================================== */

    /**
     * Compute context-aware hints based on the current cursor & mode.
     * @param {!Blockly.WorkspaceSvg} workspace
     * @return {{key:string, node:any, type:string|null}[]}
     */
    compute(workspace) {
        const cursor = workspace?.getCursor?.();
        const edit   = !!cursor?.editMode;
        const node   = cursor?.getCurNode?.();
        const onConn = !!node?.isConnection?.();
        const conn   = onConn ? node?.getLocation?.() : null;
        const canDisconnect = !!(edit && conn?.isConnected?.() && conn.targetConnection);

        const predict = (k) => (cursor?.predictNavigableBlock ? cursor.predictNavigableBlock(k) : null);

        const pW = predict('W');
        const pA = predict('A');
        const pS = predict('S');
        const pD = predict('D');
        const pF = predict('F');
        const pQ = predict('Q');

        const hints = [
            this._describe('W', pW, node, workspace),
            this._describe('A', pA, node, workspace),
            this._describe('S', pS, node, workspace),
            this._describe('D', pD, node, workspace),
            this._describe('F', pF, node, workspace),
            this._describe('Q', pQ, node, workspace),
            { key: 'E', node: edit, type: 'Edit' },
        ];

        if (canDisconnect) {
            // Insert near the nesting action for consistent UI placement.
            hints.splice(4, 0, {
                key: 'Alt+X',
                node: 'Disconnect block from this connection (Edit mode)',
                type: null,
            });
        }

        return hints;
    }

    _nameOf(block) {
        return this.speech?.friendlyName?.(block) || 'block';
    }

    _getInputForConnection(conn) {
        if (!conn?.getSourceBlock) return null;
        const blk = conn.getSourceBlock();
        if (!blk?.inputList) return null;
        for (let i = 0; i < blk.inputList.length; i++) {
            if (blk.inputList[i].connection === conn) return blk.inputList[i];
        }
        return null;
    }

    _connLabel(conn) {
        if (!conn) return 'connection';
        const t = conn.type;
        if (t === Blockly.ConnectionType.INPUT_VALUE) {
            const input = this._getInputForConnection(conn);
            return input?.name ? `value input ${input.name}` : 'value connection';
        }
        if (t === Blockly.ConnectionType.NEXT_STATEMENT) return 'next connection';
        if (t === Blockly.ConnectionType.PREVIOUS_STATEMENT) return 'previous connection';
        if (t === Blockly.ConnectionType.OUTPUT_VALUE) return 'output connection';
        return 'connection';
    }

    /**
     * Build a short, user-facing description for a predicted node given a key.
     * @param {'W'|'A'|'S'|'D'|'F'|'Q'} key
     * @param {?Blockly.ASTNode} node
     * @param {?Blockly.ASTNode} _from (kept for parity)
     * @param {!Blockly.WorkspaceSvg} workspace
     */
    _describe(key, node, _from, workspace) {
        if (!key) return {};
        if (!node) return { key: key.toUpperCase(), node: null, type: null };

        const type = node.getType?.();
        const isInputLike =
            type === Blockly.ASTNode.types.INPUT ||
            type === Blockly.ASTNode.types.NEXT ||
            type === Blockly.ASTNode.types.PREVIOUS ||
            type === Blockly.ASTNode.types.OUTPUT;

        if (type === Blockly.ASTNode.types.STACK) {
            const top  = node.getLocation?.();
            const name = getStackLabelFromStackNode(node, workspace) || this._nameOf(top) || '';
            return { key, node: `${name}`, type: 'stack' };
        }

        if (type === Blockly.ASTNode.types.BLOCK) {
            const blk  = node.getLocation?.() || node.getSourceBlock?.();
            const name = this._nameOf(blk);
            return { key, node: `${name}`, type: 'block' };
        }

        if (isInputLike) {
            const conn   = node.getLocation?.();
            const target = conn?.targetBlock?.();
            if (target) {
                return { key, node: `${this._nameOf(target)}`, type: 'connection' };
            }
            return { key, node: `Focus ${this._connLabel(conn)}`, type: 'connection' };
        }

        if (type === Blockly.ASTNode.types.WORKSPACE) {
            return { key, node: 'workspace', type: 'workspace' };
        }

        return { key, node: 'unknown', type: null };
    }

    /* ========================================================================================
     * NEW FEATURES: Modal UI (W/S to navigate, ESC to close, with SR-friendly speech)
     * ====================================================================================== */

    /** Call once at app boot (e.g., in controller.addWorkspace). */
    init() {
        this._ensureCSS();
    }

    /** Update list with new hints (e.g., from compute()), and rerender if open. */
    setHints(hints) {
        this.rowsMaster = Array.isArray(hints) ? hints.map(h => ({...h, desc: this._describeRowForUI(h)})) : [];
        if (this.listEl) this._renderList(this.rowsMaster);
    }

    /** Convenience: compute from a workspace then set hints. */
    refreshFrom(workspace) {
        try {
            this.setHints(this.compute(workspace));
        } catch {}
    }

    /** Show/Hide */
    toggle() { this.isOpen ? this.close() : this.open(); }

    _teardownDOM() {
        document.removeEventListener('keydown', this._onKeydownInDialog, true);
        if (this.root) {
            this.root.removeEventListener('click', this._onClickBackdrop, true);
            this.root.removeEventListener('focusin', this._onFocusInGuard, true);
            this.root.parentNode?.removeChild(this.root);
        }
        this.root = null;
        this.listEl = null;
        this.items = [];
        this.index = -1;
        this._modeLock = null;
    }

    open() {
        if (!this.root) this._ensureDOM();
        if (this.isOpen) return;

        this.prevFocus = document.activeElement;
        this.root.classList.add('acc-navhint--open');
        this.index = -1;
        this.isOpen = true;

        // focus sentinel to keep SR in focus mode
        try {
            this.root.querySelector('.acc-navhint__dialog')?.focus();
        } catch {}

        this._say('Navigational assistant opened. Use W or S to move through hints. Press Escape to close.');
        document.addEventListener('keydown', this._onKeydownInDialog, true);
    }

    close() {
        if (!this.isOpen) return;
        this.root.classList.remove('acc-navhint--open');
        document.removeEventListener('keydown', this._onKeydownInDialog, true);
        this.isOpen = false;

        const fallback = document.getElementById('blocklyApp')
            || document.getElementById('blocklyDiv')
            || document.body;
        try { (this.prevFocus || fallback)?.focus?.(); } catch {}
        this.prevFocus = null;

        this._say('Navigational assistant closed.');
        this._teardownDOM();
    }

    dispose() {
        document.removeEventListener('keydown', this._onKeydownInDialog, true);
        this.root?.removeEventListener('focusin', this._onFocusInGuard, true);
        if (this.root?.parentNode) this.root.parentNode.removeChild(this.root);
        this.root = null;
        this.listEl = null;
        this.items = [];
        this.index = -1;
        this._teardownDOM();

    }

    // ------------------------- modal internals -------------------------

    _ensureCSS() {
        if (document.getElementById('acc-navhint-style')) return;
        const css = `
.acc-navhint {
  position: fixed;
  inset: 0;
  display: none;          /* not rendered by default */
  pointer-events: none;   /* not hit-testable by default */
  z-index: 0;             /* sits below app when closed */
}
.acc-navhint.acc-navhint--open {
  display: block;         /* render only when open */
  pointer-events: auto;   /* allow interaction */
  z-index: 9999;          /* on top only when open */
}
.acc-navhint--open { pointer-events: auto; }

.acc-navhint__backdrop {
  position: absolute; inset: 0;
  background: rgba(0,0,0,.35);
  opacity: 0; transition: opacity .14s ease;
  pointer-events: none;
}
.acc-navhint--open .acc-navhint__backdrop { opacity: 1; pointer-events: auto; }

.acc-navhint__dialog {
  position: absolute; top: 50%; left: 50%;
  transform: translate(-50%,-50%) scale(.985);
  inline-size: clamp(340px, 48vw, 720px);
  max-block-size: min(76vh, 620px);
  background: #fff; color: #111;
  border-radius: 12px; box-shadow: 0 12px 36px rgba(0,0,0,.22);
  display: flex; flex-direction: column; overflow: hidden;
  opacity: 0; transition: opacity .14s ease, transform .14s ease;
  pointer-events: auto; outline: none;
  inline-size: clamp(300px, 42vw, 640px);   /* narrower */
  max-block-size: min(76vh, 640px);         /* slightly shorter */
  border-radius: 10px;
}
.acc-navhint--open .acc-navhint__dialog { opacity: 1; transform: translate(-50%,-50%) scale(1); }

.acc-navhint__header { padding: 14px 16px; border-bottom: 1px solid #eee; display:flex; align-items:center; justify-content:space-between; }
.acc-navhint__title { margin: 0; font-weight: 600; font-size: 17px; }
.acc-navhint__close { appearance:none; background:transparent; border:0; font-size:20px; cursor:pointer; line-height:1; padding:4px; border-radius:8px; }
.acc-navhint__close:focus-visible { outline: 2px solid #4c8bf5; outline-offset: 2px; }

.acc-navhint__body { padding: 0; overflow:auto; }
.acc-navhint__intro { margin: 12px 16px; color:#333; font-size: 13.5px; }

.acc-navhint__list { list-style:none; margin: 0; padding: 6px 0; }
.acc-navhint__item {
  display:grid; grid-template-columns: 1fr minmax(120px, 220px);
  column-gap: 12px; row-gap: 6px; align-items:start; justify-items:start;
  padding: 10px 12px; font-size: 14px;
}
.acc-navhint__item + .acc-navhint__item { border-top: 1px solid #f0f2f6; }
.acc-navhint__item--active { background: #f6f7fb; box-shadow: inset 0 0 0 2px #4c8bf5; }

.acc-navhint__descTitle { font-weight: 600; margin: 0 0 2px 0; }
.acc-navhint__descDetail { color:#444; margin: 0; }
.acc-navhint__keys { display:inline-flex; gap:6px; align-items:center; justify-self:end; min-block-size:28px; margin-inline-start:12px; }
.acc-navhint__kbd {
  display:inline-block; min-width:22px; padding:3px 9px; border-radius:7px;
  background:#f8fafc; border:1px solid #cfd7e3; color:#111827;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13.5px; line-height:20px; font-weight:600; letter-spacing:.2px; white-space:nowrap;
}

/* focus-mode sentinel */
.acc-navhint__modeLock{
  position:absolute !important; width:1px !important; height:1px !important;
  margin:-1px !important; padding:0 !important; border:0 !important;
  overflow:hidden !important; clip:rect(0 0 0 0) !important; clip-path: inset(50%) !important;
  white-space: nowrap !important;
}

@media (prefers-color-scheme: dark) {
  .acc-navhint__dialog { background:#1f2023; color:#f0f2f5; }
  .acc-navhint__item + .acc-navhint__item { border-color:#2b2e33; }
  .acc-navhint__item--active { background:#27292d; box-shadow: inset 0 0 0 2px #4c8bf5; }
  .acc-navhint__kbd { background:#2a2c31; border-color:#4a4f59; color:#f6f7fb; }
  .acc-navhint__intro { color:#cfd3da; }
}
@media (prefers-reduced-motion: reduce) {
  .acc-navhint__backdrop, .acc-navhint__dialog { transition:none !important; }
}
`.trim();
        const style = document.createElement('style');
        style.id = 'acc-navhint-style';
        style.textContent = css;
        document.head.appendChild(style);
    }

    _ensureDOM() {
        if (this.root) return;

        const root = document.createElement('div');
        root.className = 'acc-navhint';
        root.innerHTML = `
      <div class="acc-navhint__backdrop" data-close="1"></div>
      <div class="acc-navhint__dialog">
        <div class="acc-navhint__header">
          <h2 class="acc-navhint__title" id="acc-navhint-title">Navigational Assistant</h2>
          <button class="acc-navhint__close" type="button" data-close="1">✕</button>
        </div>
        <div class="acc-navhint__body">
          <p class="acc-navhint__intro">Use W and S keys to move through hints. Press Escape to close.</p>
          <ul class="acc-navhint__list" id="acc-navhint-list"></ul>
        </div>
      </div>
    `;
        document.body.appendChild(root);

        // Stop underlying app from hijacking pointer/focus; allow close button/backdrop.
        const dialog = root.querySelector('.acc-navhint__dialog');
        dialog.tabIndex = -1;
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-labelledby', 'acc-navhint-title');
        root.querySelector('.acc-navhint__close').setAttribute('aria-label', 'Close navigational assistant');
        const swallow = (e) => e.stopPropagation();
        dialog.addEventListener('pointerdown', swallow, true);
        dialog.addEventListener('mousedown', swallow, true);
        dialog.addEventListener('touchstart', swallow, true);
        dialog.addEventListener('click', (e) => {
            const t = e.target;
            if (t && t.getAttribute && t.getAttribute('data-close') === '1') {
                e.stopPropagation(); e.preventDefault();
                this.close();
            } else {
                e.stopPropagation();
            }
        }, true);

        // focus-mode sentinel to keep SR in focus mode
        const lock = document.createElement('div');
        lock.className = 'acc-navhint__modeLock';
        lock.setAttribute('contenteditable', 'true');
        lock.setAttribute('tabindex', '-1');
        lock.addEventListener('beforeinput', (e) => e.preventDefault());
        lock.addEventListener('input', () => { lock.textContent = ''; });
        dialog.appendChild(lock);
        this._modeLock = lock;

        this.root = root;
        this.listEl = root.querySelector('#acc-navhint-list');

        // initial render
        this._renderList(this.rowsMaster);

        // backdrop close + guard focus
        root.addEventListener('click', this._onClickBackdrop, true);
        root.addEventListener('focusin', this._onFocusInGuard, true);
    }

    _renderList(rows) {
        if (!this.listEl) return;
        this.index = -1;

        const frag = document.createDocumentFragment();
        for (const row of rows) {
            const li = document.createElement('li');
            li.className = 'acc-navhint__item';
            li.tabIndex = -1;

            const keysHTML = this._keyHTML(row.key);
            li.innerHTML = `
        <div class="acc-navhint__desc">
          <div class="acc-navhint__descTitle">${row.desc || ''}</div>
        </div>
        <div class="acc-navhint__keys">${keysHTML}</div>
      `;

            li.dataset.sr = this._srForRow(row);
            frag.appendChild(li);
        }

        this.listEl.innerHTML = '';
        this.listEl.appendChild(frag);
        this.items = Array.from(this.listEl.querySelectorAll('.acc-navhint__item'));
    }

    _describeRowForUI(h) {
        const K = String(h.key || '').toUpperCase();
        const T = (h.type || '').toLowerCase();

        if (T === 'edit') {
            if (typeof h.node === 'boolean') return h.node ? 'Exit Edit mode' : 'Enter Edit mode';
            return 'Toggle Edit mode';
        }

        if (T === 'workspace') {
            return (K === 'A' || K === 'Q') ? 'Move out to workspace' : 'Focus workspace';
        }

        if (T === 'stack') {
            const name = h.node || '';
            if (K === 'W') return `Move to stack "${name}" above`;
            if (K === 'S') return `Move to stack "${name}" below`;
            if (K === 'D' || K === 'F') return `Nest into stack "${name}"`;
            if (K === 'A' || K === 'Q') return `Nest out to stack "${name}"`;
            return `Focus stack "${name}"`;
        }

        if (T === 'block') {
            const name = h.node || 'block';
            if (K === 'W') return `Move to above: "${name}"`;
            if (K === 'S') return `Move to below: "${name}"`;
            if (K === 'D') return `Move to right: "${name}"`;
            if (K === 'F') return `Nest into: "${name}"`;
            if (K === 'A') return `Move to left: "${name}"`;
            if (K === 'Q') return `Nest out to: "${name}"`;
            return `Focus "${name}"`;
        }

        if (T === 'connection') {
            const name = h.node || '';
            if (K === 'F') return `Focus nested connection of edit block`;
            if (K === 'D') return `Move right connection of edit block`;
            if (K === 'A') return `Move to left connection of edit block`;
            if (K === 'W') return `Move to top connection of edit block`;
            if (K === 'S') return `Move to bottom connection of edit block`;
            return name ? `Focus connection (has "${name}")` : 'Focus connection';
        }

        return (typeof h.node === 'string' && h.node) ? h.node : 'No action';
    }

    _srForRow(row) {
        const keyTxt = row?.key ? `Shortcut ${String(row.key).replace(/\+/g, ' plus ')}.` : '';
        const d = row?.desc || '';
        return `${keyTxt} ${d}`.trim();
    }

    _keyHTML(key) {
        if (!key) return '';
        const parts = String(key).split('+');
        return parts.map(k => `<kbd class="acc-navhint__kbd">${this._labelFor(k.trim())}</kbd>`).join(' ');
    }

    _labelFor(k) {
        const isMac = /mac|iphone|ipad|ipod/i.test(`${navigator.platform||''} ${navigator.userAgent||''}`);
        const map = { 'CTRL': 'Ctrl', 'MOD': isMac ? '⌘' : 'Ctrl', 'ALT': isMac ? '⌥' : 'Alt', 'SHIFT': 'Shift' };
        const up = String(k).toUpperCase();
        return map[up] || k;
    }

    _focusModeLock() {
        const lock = this._modeLock;
        if (!lock) return;
        lock.textContent = '';
        requestAnimationFrame(() => { try { lock.focus(); } catch {} });
    }

    _onClickBackdrop(e) {
        const t = e.target;
        if (t && t.getAttribute && t.getAttribute('data-close') === '1') {
            e.preventDefault();
            this.close();
        }
    }

    _onFocusInGuard(event) {
        if (this.isOpen) {
            if (event.target.matches('button')) speakDialogFocus(event.target);
            return;
        }
        try { (this.prevFocus || document.body)?.focus?.(); } catch {}
    }

    _scrollItemIntoView(el) {
        if (!el || !this.root) return;
        const scroller = this.root.querySelector('.acc-navhint__body');
        if (!scroller) return;
        const pad = 8;
        const sTop = scroller.scrollTop;
        const sRect = scroller.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        if (r.top < sRect.top + pad) {
            scroller.scrollTop = sTop - (sRect.top - r.top) - pad;
            return;
        }
        if (r.bottom > sRect.bottom - pad) {
            scroller.scrollTop = sTop + (r.bottom - sRect.bottom) + pad;
        }
    }

    _setActive(nextIndex, speak = false) {
        if (!this.items.length) return;
        nextIndex = Math.max(0, Math.min(this.items.length - 1, nextIndex));
        this.items.forEach(el => el.classList.remove('acc-navhint__item--active'));
        const el = this.items[nextIndex];
        el.classList.add('acc-navhint__item--active');
        this._scrollItemIntoView(el);
        this.index = nextIndex;
        if (speak) {
            const label = el.dataset.sr || el.textContent?.trim() || '';
            this._say(label);
        }
    }

    _onKeydownInDialog(e) {
        const key = e.key;
        const code = e.code;

        // Close (Esc)
        if (key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            this.close();
            return;
        }

        // W/S navigation without modifiers
        const noMods = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
        const up   = noMods && (code === 'KeyW' || key === 'w' || key === 'W');
        const down = noMods && (code === 'KeyS' || key === 's' || key === 'S');

        if (up || down) {
            e.preventDefault();
            e.stopPropagation();

            if (!this.items.length) return;

            if (this.index === -1) {
                this._setActive(down ? 0 : this.items.length - 1, /*speak*/ true);
                return;
            }

            const next = Math.max(0, Math.min(this.items.length - 1, this.index + (up ? -1 : 1)));
            this._setActive(next, true);
            return;
        }

        // Prevent unmodified letters/digits from leaking to the page
        const isLetterOrDigit = /^[a-z0-9]$/i.test(key);
        const hasModifier = e.ctrlKey || e.metaKey || e.altKey || e.shiftKey;
        if (isLetterOrDigit && !hasModifier) {
            e.preventDefault();
            e.stopPropagation();
        }
    }

    _say(msg) {
        sayDialog(msg, {fallback: (line) => this.speech?.update?.(line)});
    }
}
