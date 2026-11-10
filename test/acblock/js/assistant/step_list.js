// @ts-check
/**
 * The step list in the panel's Plan section: one listbox option per step of the presented plan or fix, with its
 * status. Only the selected step shows its words; every option's name has them all. The controller decides what
 * Enter does (enterLine) and hears the selection (onSelect).
 */

/** @typedef {{words: string, status: string}} Step */
/** @typedef {{proposalId: string, kind: string, guided?: boolean, ended: boolean, canAll: boolean, steps: !Array<Step>}} PlanView */

const STATUS = {
    applied: { icon: 'fa-check', word: 'applied' },
    next: { icon: 'fa-arrow-right', word: 'next' },
    yours: { icon: 'fa-hand-point-right', word: 'yours to do' },
    waiting: { icon: 'fa-hourglass-half', word: 'waiting' },
    doneByYou: { icon: 'fa-user-check', word: 'done by you' },
    undone: { icon: 'fa-rotate-left', word: 'undone' },
    notDone: { icon: 'fa-minus', word: 'not done' },
};

/** The status as shown: in Guided mode the next step is the learner's. */
const shownStatus = (view, step) => (view.guided && step.status === 'next' ? 'yours' : step.status);

/** "Step 2 of 3, next: Change ...", the option's name and what the built-in voice says; the last is "last step". */
export function stepText(view, index) {
    const step = view.steps[index];
    const n = view.steps.length;
    const last = n > 1 && index === n - 1 ? ', last step' : '';
    return `Step ${index + 1} of ${n}${last}, ${STATUS[shownStatus(view, step)]?.word || step.status}: ${step.words}`;
}

/** The transcript note when a plan ends. */
export function planEndedText(view) {
    const done = view.steps.filter((s) => s.status === 'applied' || s.status === 'doneByYou').length;
    const n = view.steps.length;
    return `Plan ended: ${done} of ${n} ${n === 1 ? 'step' : 'steps'} done.`;
}

/** The coordinator's step line (the plugin's stepLine), so the list asks in the same words as the brief. */
function askLine(view, index) {
    const shared = /** @type {any} */ (globalThis).stepLine;
    if (typeof shared === 'function') return shared(view, index);
    return `Step ${index + 1} of ${view.steps.length}. ${view.steps[index].words} Should I do it? Say yes or no.`;
}

/**
 * What Enter on a step says. On the next step in Step-confirm it asks first (ask: focus goes to Yes); nothing is
 * applied from the list.
 * @returns {{ask: boolean, line: string}}
 */
export function enterLine(view, index) {
    const step = view.steps[index];
    const n = index + 1;
    if (view.ended) return { ask: false, line: 'This plan has ended.' };
    if (step.status === 'next') {
        return view.guided ? { ask: false, line: "Do this step in your program; I'll tell you when it's done." } :
            { ask: true, line: askLine(view, index) };
    }
    if (step.status === 'applied') return { ask: false, line: `Step ${n} is done. Say undo, or press Alt+Shift+U, to take it back.` };
    if (step.status === 'doneByYou') return { ask: false, line: `Step ${n} is done.` };
    const next = view.steps.findIndex((s) => s.status === 'next');
    return { ask: false, line: next >= 0 ? `Step ${next + 1} comes first.` : 'This plan has ended.' };
}

/** One step's row: its icon, "Step 2 of 3" with the status in a pill, and its words. */
function stepRow(doc, view, i) {
    const status = shownStatus(view, view.steps[i]);
    const { icon, word } = STATUS[status] || STATUS.waiting;
    const row = doc.createElement('li');
    row.className = `assistant-step assistant-step--${status}`;
    const badge = doc.createElement('span');
    badge.className = 'assistant-step-icon';
    badge.setAttribute('aria-hidden', 'true');
    const glyph = doc.createElement('i');
    glyph.className = `fas ${icon}`;
    badge.append(glyph);
    const head = doc.createElement('span');
    head.className = 'assistant-step-head';
    const state = doc.createElement('span');
    state.className = 'assistant-step-state';
    state.textContent = word;
    head.append(`Step ${i + 1} of ${view.steps.length} `, state);
    const words = doc.createElement('span');
    words.className = 'assistant-step-words';
    words.textContent = view.steps[i].words;
    row.append(badge, head, words);
    return row;
}

/**
 * An ended plan's steps with their final statuses, for the "Plan ended" note; every row shows its words.
 * @param {!Document} doc  @param {!PlanView} view  @param {string} id
 */
export function endedStepsList(doc, view, id) {
    const list = doc.createElement('ul');
    list.id = id;
    list.className = 'assistant-ended-steps';
    list.setAttribute('aria-label', 'Steps of the ended plan');
    view.steps.forEach((_, i) => list.append(stepRow(doc, view, i)));
    return list;
}

/**
 * @param {{document: !Document, section: !HTMLElement, heading: !HTMLElement, body: !HTMLElement,
 *     onEnter: function(!PlanView, number): void, onSelect?: function(string): void, onEdge?: function(string): void}} options
 *     onEnter: Enter or Space on a step (view, index); onSelect: the text of a step the keys moved to;
 *     onEdge: W or Up on the first step ('up'), S or Down on the last ('down'): the panel moves to the next row
 */
export function createStepList({ document: doc, section, heading, body, onEnter, onSelect = () => {}, onEdge = () => {} }) {
    /** @type {?PlanView} */
    let view = null;
    let selected = 0;
    const list = doc.createElement('ul');
    list.className = 'assistant-steps';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-labelledby', heading.id);
    list.tabIndex = 0;
    const hint = doc.createElement('p');
    hint.className = 'assistant-plan-hint';
    hint.id = `${heading.id}-hint`;
    hint.textContent = 'Alt Shift L goes here. Up and Down move, Enter does the next step.';
    list.setAttribute('aria-describedby', hint.id);
    body.replaceChildren(list, hint);

    function select(index) {
        if (!view) return;
        selected = Math.max(0, Math.min(view.steps.length - 1, index));
        list.querySelectorAll('[role="option"]').forEach((option, i) => option.setAttribute('aria-selected', String(i === selected)));
        const option = list.children[selected];
        if (option) {
            list.setAttribute('aria-activedescendant', option.id);
            // At the panel's outer level the Plan is read with the step that comes now.
            section.setAttribute('aria-describedby', option.id);
            option.scrollIntoView?.({ block: 'nearest' });
        }
    }

    function draw() {
        list.textContent = '';
        view.steps.forEach((step, i) => {
            const option = stepRow(doc, view, i);
            option.id = `${heading.id}-step-${i}`;
            option.setAttribute('role', 'option');
            // The whole text is the name: the words of unselected steps are hidden on screen.
            option.setAttribute('aria-label', stepText(view, i));
            option.querySelectorAll('.assistant-step-head, .assistant-step-words').forEach((part) => part.setAttribute('aria-hidden', 'true'));
            // A click selects; doing a step stays with Enter and the Yes button.
            option.addEventListener('click', () => {
                select(i);
                list.focus();
                onSelect(stepText(view, i));
            });
            list.append(option);
        });
    }

    list.addEventListener('keydown', (e) => {
        if (!view || e.ctrlKey || e.altKey || e.metaKey) return;
        // W and S move like Up and Down (the app's keys everywhere); past the first or last step, to the next row.
        const moves = { ArrowUp: selected - 1, ArrowDown: selected + 1, w: selected - 1, s: selected + 1, Home: 0, End: view.steps.length - 1 };
        // Letters without Shift (also with Caps Lock); Shift+W and Shift+S are the editor's.
        const key = e.key.length === 1 && !e.shiftKey ? e.key.toLowerCase() : e.key;
        // The list's own keys: Blockly listens on the whole document and would move the cursor or edit too.
        if (key in moves || e.key === 'Enter' || e.key === ' ') e.stopPropagation();
        if (key in moves) {
            e.preventDefault();
            const to = moves[key];
            if (to < 0 || to >= view.steps.length) {
                onEdge(to < 0 ? 'up' : 'down');
                return;
            }
            const before = selected;
            select(to);
            if (selected !== before) onSelect(stepText(view, selected));
            return;
        }
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onEnter(view, selected);
        }
    });

    return {
        element: list,
        /**
         * Shows the plan, or hides the section when there is none or it ended. The next step is selected after each
         * change, so yes, undo and Enter leave the list on the step that comes now.
         * @param {?PlanView} next
         */
        update(next) {
            const live = !!next && !next.ended && next.steps.length > 0;
            if (!live) {
                const hadFocus = section.contains(doc.activeElement);
                view = null;
                list.textContent = '';
                list.removeAttribute('aria-activedescendant');
                section.hidden = true;
                return { hadFocus };
            }
            const sameStep = view && view.proposalId === next.proposalId ? selected : 0;
            view = next;
            draw();
            section.hidden = false;
            const now = next.steps.findIndex((s) => s.status === 'next');
            select(now >= 0 ? now : sameStep);
            return { hadFocus: false };
        },
        isShown: () => !!view && !section.hidden,
        focus() {
            if (view) list.focus();
            return !!view;
        },
        /** Selects a step (the panel's rows: Alt+Shift+L, coming from above or below). */
        selectStep(index) {
            select(index);
        },
        count: () => view?.steps.length || 0,
        view: () => view,
        selected: () => selected,
    };
}
