// shortcut_assistance.js
import * as Constants from '../constants';
import { Speech } from '../audio/speech';
import {sayDialog, speakDialogFocus} from './dialog_speech.js';

export class ShortcutAssistance {
    /**
     * @param {Speech=} speech
     */
    constructor(speech) {
        this.speech = speech || new Speech();

        this.root = null;
        this.listEl = null;
        this.items = [];
        this.index = -1; // start with NO SELECTION
        this.isOpen = false;
        this.prevFocus = null;

        // search state
        this.searchInput = null;

        // data sources
        this.rowsMaster = []; // immutable reference data
        this.rowsView = [];   // currently rendered rows (filtered)

        // bound
        this._onKeydownInDialog = this._onKeydownInDialog.bind(this);
        this._onClickBackdrop = this._onClickBackdrop.bind(this);
        this._onFocusInGuard = this._onFocusInGuard.bind(this);
        this._onSearchInput = this._onSearchInput.bind(this);
    }

    init() {
        this._ensureCSS();
    }

    dispose() {
        document.removeEventListener('keydown', this._onKeydownInDialog, true);
        this.root?.removeEventListener('focusin', this._onFocusInGuard, true);
        if (this.root?.parentNode) this.root.parentNode.removeChild(this.root);
        this.root = null;
        this.listEl = null;
        this.items = [];
        this.index = -1;
        this.searchInput = null;
    }

    toggle() {
        this.isOpen ? this.close() : this.open();
    }

    open() {
        // build DOM only when needed
        if (!this.root) this._ensureDOM();
        if (this.isOpen) return;

        this.prevFocus = document.activeElement;

        // VISUALLY OPEN
        this.root.classList.add('acc-shortcuts--open');

        // Keep all items unfocused; selection is visual only.
        this.items.forEach(el => (el.tabIndex = -1));
        this.index = -1;

        // reset search UI
        if (this.searchInput) {
            this.searchInput.value = '';
            this._applySearchFilterNow(); // show all rows
        }

        // Focus dialog shell (never a list item)
        try {
            this.root.querySelector('.acc-shortcuts__dialog')?.focus();
        } catch {}

        this._say(
            'Shortcut help opened. Use W or S to navigate shortcuts. ' +
            'Press Slash to search. Press Escape key to close.'
        );

        // Capture keystrokes while open (but allow modified combos through)
        document.addEventListener('keydown', this._onKeydownInDialog, true);
        this.isOpen = true;
    }

    close() {
        if (!this.isOpen) return;

        // return focus to Blockly wrapper first
        const fallback =
            document.getElementById('blocklyApp') ||
            document.getElementById('blocklyDiv') ||
            document.body;
        try {
            (this.prevFocus || fallback)?.focus?.();
        } catch {}

        this.prevFocus = null;
        this.isOpen = false;

        this._say('Shortcut help closed.');

        // remove from DOM so nothing can intercept clicks
        this._teardownDOM();
    }

    _teardownDOM() {
        document.removeEventListener('keydown', this._onKeydownInDialog, true);
        if (this.root?.parentNode) this.root.parentNode.removeChild(this.root);

        this.root = null;
        this.listEl = null;
        this.items = [];
        this.index = -1;
        this.searchInput = null;
        this._modeLock = null;
    }

    // helpers
    _os() {
        const ua = `${navigator.platform || ''} ${navigator.userAgent || ''}`.toLowerCase();
        const isMac = /mac|iphone|ipad|ipod/.test(ua);
        const isWin = /win/.test(ua);
        return { isMac, isWin, isLinux: !isMac && !isWin };
    }

    _labelFor(key) {
        const isMac = this._os().isMac;
        const map = {
            MOD: isMac ? '⌘' : 'Ctrl',
            ALT: isMac ? '⌥' : 'Alt',
            Shift: 'Shift',
            Esc: 'Esc',
            Del: isMac ? 'Delete' : 'Del',
            '/': '/',
            'A–Z': 'A–Z'
        };
        return map[key] || key;
    }

    _speakKey(key) {
        const isMac = this._os().isMac;
        const map = {
            MOD: isMac ? 'Command' : 'Control',
            ALT: isMac ? 'Option' : 'Alt',
            Shift: 'Shift',
            Esc: 'Escape',
            Del: 'Delete',
            '/': 'Slash',
            'A–Z': 'letters A through Z'
        };
        return map[key] || key.toUpperCase?.() || String(key);
    }

    _comboHTML(parts) {
        return parts.map(k => `<kbd class="acc-shortcuts__kbd">${this._labelFor(k)}</kbd>`).join(' ');
    }

    _comboSpeech(parts) {
        return parts.map(k => this._speakKey(k)).join(' plus ');
    }

    _rowKeysToHTML(keys) {
        if (Array.isArray(keys)) return this._comboHTML(keys);
        return `<kbd class="acc-shortcuts__kbd">${this._labelFor(keys)}</kbd>`;
    }

    _rowKeysToSpeech(keys) {
        if (Array.isArray(keys)) return this._comboSpeech(keys);
        return this._speakKey(keys);
    }

    // html, css
    _ensureCSS() {
        if (document.getElementById('acc-shortcuts-style')) return;
        const css = `
/* Shortcut Assistance (auto-injected) */
/* ===========================
   Shortcut Assistance (modal)
   =========================== */

.acc-shortcuts {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: none;          /* closed by default */
  pointer-events: none;   /* not hit-testable when closed */
}

/* Only interactive/visible when open */
.acc-shortcuts.acc-shortcuts--open {
  display: block;
  pointer-events: auto;
}

/* Backdrop */
.acc-shortcuts__backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,.35);
  opacity: 0;
  transition: opacity .14s ease;
  pointer-events: none;
}
.acc-shortcuts--open .acc-shortcuts__backdrop {
  opacity: 1;
  pointer-events: auto;
}

/* Dialog */
.acc-shortcuts__dialog {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%,-50%) scale(.985);
  inline-size: clamp(360px, 56vw, 860px);
  max-block-size: min(82vh, 720px);
  background: #fff;
  color: #111;
  border-radius: 12px;
  box-shadow: 0 12px 36px rgba(0,0,0,.22);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  opacity: 0;
  transition: opacity .14s ease, transform .14s ease;
  pointer-events: auto;   /* dialog itself is interactive */
  outline: none;
  inline-size: clamp(300px, 42vw, 640px);   /* narrower */
  max-block-size: min(76vh, 640px);         /* slightly shorter */
  border-radius: 10px;
}
.acc-shortcuts--open .acc-shortcuts__dialog {
  opacity: 1;
  transform: translate(-50%,-50%) scale(1);
}

/* Header */
.acc-shortcuts__header {
  padding: 14px 16px;
  border-bottom: 1px solid #eee;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.acc-shortcuts__title {
  margin: 0;
  font-weight: 600;
  font-size: 17px;
}
.acc-shortcuts__close {
  appearance: none;
  background: transparent;
  border: 0;
  font-size: 20px;
  cursor: pointer;
  line-height: 1;
  padding: 4px;
  border-radius: 8px;
}
.acc-shortcuts__close:focus-visible {
  outline: 2px solid #4c8bf5;
  outline-offset: 2px;
}

/* Body */
.acc-shortcuts__body {
  padding: 0;
  overflow: auto;
}
.acc-shortcuts__intro {
  margin: 12px 16px;
  color: #333;
  font-size: 13.5px;
}

/* Footer */
.acc-shortcuts__footer {
  padding: 10px 14px;
  font-size: 12.5px;
  color: #444;
  border-top: 1px solid #eee;
}

/* Search */
.acc-shortcuts__search {
  margin: 8px 12px 4px 12px;
}
.acc-shortcuts__searchLabel {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.acc-shortcuts__searchInput {
  display: block;
  inline-size: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid #cfd7e3;
  font-size: 14px;
  background: #fff;
}
.acc-shortcuts__searchInput:focus-visible {
  outline: 2px solid #4c8bf5;
  outline-offset: 2px;
}

/* List */
.acc-shortcuts__list {
  list-style: none;
  margin: 0;
  padding: 6px 0;
}

/* =================================
   ROW LAYOUT — FLEX for easy centering
   ================================= */
.acc-shortcuts__item {
  /* Use flex so vertical centering is bulletproof */
  display: flex;
  align-items: center;            /* vertical centering of both sides */
  justify-content: space-between; /* text left, keys right */
  gap: 12px;
  padding: 10px 12px;
  font-size: 14px;
  min-block-size: 44px;           /* comfortable row height */
}

.acc-shortcuts__item + .acc-shortcuts__item {
  border-top: 1px solid #f0f2f6;
}

/* Active (keyboard-nav) style */
.acc-shortcuts__item--active {
  background: #f6f7fb;
  box-shadow: inset 0 0 0 2px #4c8bf5;
}

/* Left column (title + detail) */
.acc-shortcuts__desc {
  flex: 1 1 auto;                 /* takes leftover width */
  min-width: 0;                   /* allows text wrapping */
  display: flex;
  flex-direction: column;
  justify-content: center;        /* keep its own content vertically centered */
  align-items: flex-start;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.acc-shortcuts__descTitle {
  font-weight: 600;
  margin: 0 0 2px 0;
}

.acc-shortcuts__descDetail {
  color: #444;
  margin: 0;
  text-align: left;
}

/* Right column (key chips) */
.acc-shortcuts__keys {
  flex: 0 0 auto;                 /* do not stretch */
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;            /* center single line vertically */
  align-content: center;          /* center multi-line wraps vertically */
  justify-content: flex-end;      /* push chips to the right edge */
  min-block-size: 28px;
  margin-inline-start: 12px;
}

.acc-shortcuts__kbd {
  display: inline-block;
  min-width: 22px;
  padding: 3px 9px;
  border-radius: 7px;
  background: #f8fafc;
  border: 1px solid #cfd7e3;
  color: #111827;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13.5px;
  line-height: 20px;
  font-weight: 600;
  letter-spacing: .2px;
  white-space: nowrap;
}

/* Focus style when rows are focusable (if you ever set tabindex="0") */
.acc-shortcuts__item[tabindex="0"]:focus {
  background: #f6f7fb;
  box-shadow: inset 0 0 0 2px #4c8bf5;
  outline: none;
}

/* Screen-reader focus-mode sentinel */
.acc-shortcuts__modeLock{
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  margin: -1px !important;
  padding: 0 !important;
  border: 0 !important;
  overflow: hidden !important;
  clip: rect(0 0 0 0) !important;
  clip-path: inset(50%) !important;
  white-space: nowrap !important;
}

/* Ensure dialog/backdrop only interactive when open */
.acc-shortcuts__dialog,
.acc-shortcuts__backdrop { pointer-events: none; }
.acc-shortcuts--open .acc-shortcuts__dialog { pointer-events: auto; }
.acc-shortcuts--open .acc-shortcuts__backdrop { pointer-events: auto; }

/* =================
   Responsive tweaks
   ================= */
@media (max-width: 640px) {
  /* Stack row vertically; still keep nice spacing */
  .acc-shortcuts__item {
    flex-direction: column;
    align-items: flex-start;    /* left-align when stacked */
    gap: 6px;
  }
  .acc-shortcuts__keys {
    justify-content: flex-start; /* put chips under the text, left-aligned */
    margin-inline-start: 0;
  }
}

/* ==========================
   Dark / Forced colors / R-M
   ========================== */
@media (prefers-color-scheme: dark) {
  .acc-shortcuts__dialog { background: #1f2023; color: #f0f2f5; }
  .acc-shortcuts__item + .acc-shortcuts__item { border-color: #2b2e33; }
  .acc-shortcuts__item--active { background: #27292d; box-shadow: inset 0 0 0 2px #4c8bf5; }
  .acc-shortcuts__kbd { background: #2a2c31; border-color: #4a4f59; color: #f6f7fb; }
  .acc-shortcuts__header, .acc-shortcuts__footer { border-color: #2b2e33; }
  .acc-shortcuts__intro, .acc-shortcuts__descDetail { color: #cfd3da; }
  .acc-shortcuts__searchInput { background: #1f2023; color: #f0f2f5; border-color: #4a4f59; }
}

@media (forced-colors: active) {
  .acc-shortcuts__item[tabindex="0"]:focus { outline: 2px solid Highlight; outline-offset: 0; box-shadow: none; }
  .acc-shortcuts__kbd { border: 1px solid CanvasText; background: Canvas; color: CanvasText; }
  .acc-shortcuts__searchInput { border: 1px solid CanvasText; }
}

@media (prefers-reduced-motion: reduce) {
  .acc-shortcuts__backdrop, .acc-shortcuts__dialog { transition: none !important; }
}
/* dialog/backdrop only interactive when open */
.acc-shortcuts__dialog,
.acc-shortcuts__backdrop { pointer-events: none; opacity: 0; }
.acc-shortcuts--open .acc-shortcuts__dialog { pointer-events: auto; opacity: 1; }
.acc-shortcuts--open .acc-shortcuts__backdrop { pointer-events: auto; opacity: 1; }
`.trim();
        const style = document.createElement('style');
        style.id = 'acc-shortcuts-style';
        style.textContent = css;
        document.head.appendChild(style);
    }

    _ensureDOM() {
        if (this.root) return;

        const root = document.createElement('div');
        root.className = 'acc-shortcuts';
        root.innerHTML = `
      <div class="acc-shortcuts__backdrop" data-close="1"></div>
      <div class="acc-shortcuts__dialog">
        <div class="acc-shortcuts__header">
          <h2 class="acc-shortcuts__title" id="acc-shortcuts-title">Keyboard Shortcuts</h2>
          <button class="acc-shortcuts__close" type="button" data-close="1">✕</button>
        </div>
        <div class="acc-shortcuts__body">
          <p class="acc-shortcuts__intro">
            Press W and S keys to move through shortcuts list. Press / to search. Press Escape (ESC) to close the shortcut help.
          </p>
          <div class="acc-shortcuts__search">
            <label class="acc-shortcuts__searchLabel" for="acc-shortcuts-search">Search shortcuts</label>
            <input id="acc-shortcuts-search"
                   class="acc-shortcuts__searchInput"
                   type="text"
                   placeholder="Search shortcuts…"
                   autocomplete="off" />
          </div>
          <ul class="acc-shortcuts__list" id="acc-shortcuts-list"></ul>
        </div>
        <div class="acc-shortcuts__footer">
          Tip: On macOS, “Ctrl” is shown as “⌘” (Command) and “Alt” is shown as “⌥” (Option).
        </div>
      </div>
    `;

        document.body.appendChild(root);

        // Dialog semantics
        const dialog = root.querySelector('.acc-shortcuts__dialog');
        dialog.tabIndex = -1;
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-labelledby', 'acc-shortcuts-title');
        root.querySelector('.acc-shortcuts__close').setAttribute('aria-label', 'Close shortcut help');
        // Stop underlying app from hijacking pointer/focus; allow close button to work.
        const swallow = (e) => e.stopPropagation();
        dialog.addEventListener('pointerdown', swallow, true);
        dialog.addEventListener('mousedown',   swallow, true);
        dialog.addEventListener('touchstart',  swallow, true);
        dialog.addEventListener('click', (e) => {
            const t = e.target;
            if (t && t.getAttribute && t.getAttribute('data-close') === '1') {
                e.stopPropagation();
                e.preventDefault();
                this.close();
            } else {
                e.stopPropagation();
            }
        }, true);

        const list = root.querySelector('.acc-shortcuts__list');

        const body = root.querySelector('.acc-shortcuts__body');
        const searchWrap = root.querySelector('.acc-shortcuts__search');

// Create a hidden contenteditable "mode lock" to force SR focus mode
        const lock = document.createElement('div');
        lock.className = 'acc-shortcuts__modeLock';
        lock.setAttribute('contenteditable', 'true');
        lock.setAttribute('tabindex', '-1'); // programmatic focus only
        lock.setAttribute(
            'aria-label',
            'Results focused. Use W or S to navigate. Press Slash to edit search.'
        );
// Keep it empty and prevent any text from sticking
        lock.addEventListener('beforeinput', (e) => e.preventDefault());
        lock.addEventListener('input', () => { lock.textContent = ''; });

        searchWrap.insertAdjacentElement('afterend', lock);
        this._modeLock = lock;

        // cache
        this.root = root;
        this.listEl = list;

        // data: immutable reference + initial view
        this.rowsMaster = Array.isArray(Constants.SHORTCUT_HELP_ROWS)
            ? Constants.SHORTCUT_HELP_ROWS.slice()
            : [];
        this.rowsView = this.rowsMaster.slice();

        // initial render
        this._renderList(this.rowsView);

        // search
        this.searchInput = root.querySelector('#acc-shortcuts-search');
        this.searchInput?.addEventListener('input', this._onSearchInput);
        // this.searchInput?.setAttribute('role', 'none');
        // this.searchInput?.setAttribute('tabIndex', '-1');


        // click-to-close on backdrop
        root.addEventListener('click', this._onClickBackdrop, true);

        // Guard: if the hidden modal ever receives focus, bounce it back out
        root.addEventListener('focusin', this._onFocusInGuard, true);
    }

    _renderList(rows) {
        if (!this.listEl) return;

        // Reset selection whenever the view changes
        this.index = -1;

        const frag = document.createDocumentFragment();
        for (const row of rows) {
            const li = document.createElement('li');
            li.className = 'acc-shortcuts__item';
            li.tabIndex = -1; // not focusable

            const keysHTML = this._rowKeysToHTML(row.keys);
            li.innerHTML = `
              <div class="acc-shortcuts__desc">
                <div class="acc-shortcuts__descTitle">${row.title}</div>
                ${row.detail ? `<div class="acc-shortcuts__descDetail">${row.detail}</div>` : ''}
              </div>
              <div class="acc-shortcuts__keys">${keysHTML}</div>
            `;

            const srLabel = (row.sr && row.sr.trim()) || '';
            li.dataset.sr = srLabel;
            frag.appendChild(li);
        }

        this.listEl.innerHTML = '';
        this.listEl.appendChild(frag);
        this.items = Array.from(this.listEl.querySelectorAll('.acc-shortcuts__item'));
        this.rowsView = rows.slice();
    }

    _normalize(str) {
        return (str || '')
            .toLowerCase()
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    _tokens(str) {
        const stop = new Set(['the','to','a','an','of','and','or','in','on','with','for','press','key','keys','mode','move']);
        return this._normalize(str).split(' ').filter(t => t && !stop.has(t));
    }

    _scoreTitle(title, query) {
        if (!query) return 1;
        const t = this._normalize(title);
        const qTokens = this._tokens(query);
        if (!qTokens.length) return 0;
        let score = 0;
        for (const tok of qTokens) {
            if (t.includes(tok)) score += 2;
            else if (tok.length >= 3) {
                const stem = tok.slice(0, -1);
                if (stem && t.includes(stem)) score += 1;
            }
        }
        return score;
    }

    _applySearchFilter(query) {
        const q = (query || '').trim();

        // Build filtered view from the immutable master list
        const filtered = q
            ? this.rowsMaster
                .map((row, i) => ({ row, score: this._scoreTitle(row.title, q), i }))
                .filter(x => x.score > 0)
                .sort((a, b) => b.score - a.score || a.i - b.i)
                .map(x => x.row)
            : this.rowsMaster.slice();

        this._renderList(filtered);

        // Speech feedback
        if (q.length) {
            const total = filtered.length;
            const msg = total === 1
                ? '1 shortcut found. Press Escape to focus it, then use W or S to navigate.'
                : `${total} shortcuts found. Press Escape to focus result, then W or S to navigate.`;
            this._say(msg);
        } else {
            this._say(`${this.items.length} shortcuts available.`);
        }
    }

    _applySearchFilterNow() {
        const q = this.searchInput?.value ?? '';
        this._applySearchFilter(q);
    }

    // Guard against focus inside hidden modal
    _onFocusInGuard(e) {
        if (!this.root || !this.isOpen) return;
        const isHidden = this.root.getAttribute('aria-hidden') === 'true';
        if (!isHidden) {
            const target = e.target;
            if (target.matches('input, button')) speakDialogFocus(target);
            return;
        }
        const fallback = document.querySelector('#blocklyDiv') || document.body;
        try {
            (this.prevFocus || fallback)?.focus?.();
        } catch {}
    }

    // speech + visual selection
    _setActive(nextIndex, speak = false) {
        nextIndex = Math.max(0, Math.min(this.items.length - 1, nextIndex));

        // clear previous visual state
        this.items.forEach(el => el.classList.remove('acc-shortcuts__item--active'));

        // set new visual state (no focus!)
        const el = this.items[nextIndex];
        el.classList.add('acc-shortcuts__item--active');
        this._scrollItemIntoView(el);

        this.index = nextIndex;

        if (speak) {
            // build a spoken label from DOM content
            const row = this.rowsView[nextIndex] || {};
            let label = (row.sr && row.sr.trim()) || el.dataset.sr || el.getAttribute('aria-label') || '';
            const pos = `${this.index + 1} of ${this.items.length}`;
            this._say(`${label}`);
        }
    }

    _focusModeLock() {
        const lock = this._modeLock;
        if (!lock) return;
        lock.textContent = ''; // ensure empty
        // Focusing a contenteditable reliably switches SR to focus mode
        requestAnimationFrame(() => {
            try { lock.focus(); } catch {}
        });
    }


    // key events while dialog is open
    _onKeydownInDialog(e) {
        const key = e.key;
        const code = e.code;
        const target = e.target;

        // If typing in the search field: Esc jumps to first result (list already filtered)
        if (target === this.searchInput) {
            if (key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                this._applySearchFilterNow();
                if (this.items.length > 0) {
                    this._setActive(0, /*speak*/ true);
                    this._focusModeLock();
                } else {
                    this.close();
                }
            }
            return; // allow normal typing, including '/'
        }

        // Close (Esc or Alt+H)
        const altH = (key === 'h' || key === 'H') && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
        if (key === 'Escape' || altH) {
            e.preventDefault();
            e.stopPropagation();
            this.close();
            return;
        }

        // Slash launches search (no modifiers). If focused on results, also reset text.
        const noMods = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
        const isSlash = key === '/' || code === 'Slash';
        if (noMods && isSlash) {
            e.preventDefault();
            this._focusSearchBar(/*reset*/ true); // clears and focuses
            return;
        }

        // navigate using W/S (no modifiers)
        const up = noMods && (code === 'KeyW' || key === 'w' || key === 'W');
        const down = noMods && (code === 'KeyS' || key === 's' || key === 'S');

        if (up || down) {
            e.preventDefault();
            e.stopPropagation();

            if (this.items.length === 0) return;

            // First navigation selects first/last item in the CURRENT (filtered) view
            if (this.index === -1) {
                this._setActive(down ? 0 : this.items.length - 1, /*speak*/ true);
                return;
            }

            const next = Math.max(0, Math.min(this.items.length - 1, this.index + (up ? -1 : 1)));
            this._setActive(next, true);
            return;
        }

        // page up/down
        if (key === 'PageUp') {
            e.preventDefault();
            e.stopPropagation();
            this._setActive(Math.max(0, this.index === -1 ? 0 : this.index - 5), true);
            return;
        }
        if (key === 'PageDown') {
            e.preventDefault();
            e.stopPropagation();
            this._setActive(Math.min(this.items.length - 1, this.index === -1 ? 0 : this.index + 5), true);
            return;
        }

        // Swallow only unmodified letters/digits so they don't leak to workspace
        const isLetterOrDigit = /^[a-z0-9]$/i.test(key);
        const hasModifier = e.ctrlKey || e.metaKey || e.altKey || e.shiftKey;
        if (isLetterOrDigit && !hasModifier) {
            e.preventDefault();
            e.stopPropagation();
        }
    }

    // ensure active item is visible inside the modal's scroll area
    _scrollItemIntoView(el) {
        if (!el || !this.root) return;
        const scroller = this.root.querySelector('.acc-shortcuts__body');
        if (!scroller) return;

        const pad = 8; // small cushion
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

    _onClickBackdrop(e) {
        const t = e.target;
        if (t && t.getAttribute && t.getAttribute('data-close') === '1') {
            e.preventDefault();
            this.close();
        }
    }

    /* --------------------------
     * Search implementation
     * -------------------------- */
    _focusSearchBar(reset = false) {
        const input = this.searchInput;
        if (!input) return;

        if (reset) {
            input.value = '';
            this._applySearchFilterNow(); // show all rows again immediately
        }

        // Focus after the keydown cycle to avoid conflicts with capture listeners / browser defaults
        requestAnimationFrame(() => {
            try {
                input.focus();
                if (reset) input.select();
            } catch {}
        });

    }

    _say(text) {
        sayDialog(text, {fallback: (line) => this.speech.update(line)});
    }

    _onSearchInput(e) {
        const q = e.currentTarget?.value ?? '';
        this._applySearchFilter(q); // immediate re-render on each keystroke
    }
}
