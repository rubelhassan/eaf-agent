// @ts-check
/**
 * The assistant panel's DOM: header with status, transcript, the plan slot, the answers group and the draft.
 * No live regions: everything heard goes through the output manager. The controller (assistant_ui.js) owns behavior.
 */

/** Answer keys, shown on their buttons (bound in src/util/assistant_keys.js). */
const ANSWER_KEYS = { yes: 'Alt+Shift+Y', all: 'Alt+Shift+A', no: 'Alt+Shift+N', cancel: 'Alt+Shift+C', undo: 'Alt+Shift+U', repeat: 'Alt+Shift+R' };
const ANSWER_ICONS = { yes: 'fa-check', all: 'fa-forward', no: 'fa-xmark', cancel: 'fa-ban', stop: 'fa-stop', undo: 'fa-rotate-left', go: 'fa-location-arrow', repeat: 'fa-volume-up' };
// The answers row, left to right; anything else after these.
const ANSWER_ORDER = ['yes', 'all', 'how', 'check', 'no', 'cancel', 'stop', 'undo', 'repeat', 'go'];
const answerRank = (name) => (ANSWER_ORDER.includes(name) ? ANSWER_ORDER.indexOf(name) : ANSWER_ORDER.length);
const TYPING_HINT = 'Enter sends. Shift Enter for a new line. Escape stops typing.';
const LANDED_HINT = 'Press Enter to type.';

// The assistant's logo: four puzzle pieces, the last one sliding in, and the assistant's face where they meet.
// At 24 px and below only the face is drawn (the open button, the conversation's avatars).
const PIECE_KNOB = 0.17;
const PIECE_RADIUS = 0.15;
let clipCounter = 0;

/** A rounded square whose sides are flat (0), have a knob out (1) or a hole in (-1). */
function piecePath(x, y, s, { t = 0, r = 0, b = 0, l = 0 }) {
    const c = s * 0.12, w = s * PIECE_KNOB, rad = s * PIECE_RADIUS, m = s / 2;
    const knob = (k, px, py, ux, uy) => (k ? `L${px + ux * (m - w)} ${py + uy * (m - w)}A${rad} ${rad} 0 1 ${k > 0 ? 1 : 0} ${px + ux * (m + w)} ${py + uy * (m + w)}` : '');
    return `M${x + c} ${y}${knob(t, x, y, 1, 0)}L${x + s - c} ${y}Q${x + s} ${y} ${x + s} ${y + c}` +
        `${knob(r, x + s, y, 0, 1)}L${x + s} ${y + s - c}Q${x + s} ${y + s} ${x + s - c} ${y + s}` +
        `${knob(b, x + s, y + s, -1, 0)}L${x + c} ${y + s}Q${x} ${y + s} ${x} ${y + s - c}` +
        `${knob(l, x, y + s, 0, -1)}L${x} ${y + c}Q${x} ${y} ${x + c} ${y}Z`;
}

function shadedPiece(d, colour, band) {
    const clip = `assistant-logo-clip-${++clipCounter}`;
    return `<clipPath id="${clip}"><path d="${d}"/></clipPath><path d="${d}" class="logo-${colour}"/>` +
        `<rect x="${band.x}" y="${band.y}" width="${band.w}" height="${band.h}" class="logo-${colour}-side" clip-path="url(#${clip})"/>`;
}

function logoFace(cx, cy, w, h, smile) {
    const eye = Math.max(1.6, h * 0.15), ey = cy - h * 0.08;
    let out = `<rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="${h * 0.38}" class="logo-screen"/>` +
        `<circle cx="${cx - w * 0.22}" cy="${ey}" r="${eye}" class="logo-eyes"/><circle cx="${cx + w * 0.22}" cy="${ey}" r="${eye}" class="logo-eyes"/>`;
    if (smile) out += `<path d="M${cx - w * 0.14} ${cy + h * 0.2}Q${cx} ${cy + h * 0.36} ${cx + w * 0.14} ${cy + h * 0.2}" class="logo-smile" stroke-width="${h * 0.09}"/>`;
    return out;
}

/** The logo as decorative SVG markup (its meaning is in the text next to it or the button's name). */
export function logoSvg(size) {
    const attrs = `class="assistant-logo" width="${size}" height="${size}" aria-hidden="true" focusable="false"`;
    if (size <= 24) return `<svg ${attrs} viewBox="0 0 24 24">${logoFace(12, 12, 23, 17, size >= 20)}</svg>`;
    return `<svg ${attrs} viewBox="2.08 2.08 65.06 65.06">` +
        shadedPiece(piecePath(4, 4, 28, { r: 1, b: 1 }), 'green', { x: 0, y: 0, w: 9, h: 40 }) +
        shadedPiece(piecePath(32, 4, 28, { l: -1, b: 1 }), 'pink', { x: 32, y: 0, w: 7, h: 40 }) +
        shadedPiece(piecePath(4, 32, 28, { t: -1, r: 1 }), 'yellow', { x: 0, y: 32, w: 9, h: 40 }) +
        `<g transform="translate(3 3) rotate(10 46 46)">${shadedPiece(piecePath(32, 32, 28, { t: -1, l: -1 }), 'blue', { x: 32, y: 32, w: 7, h: 40 })}</g>` +
        logoFace(32, 32, 24, 17, true) + '</svg>';
}

/** The welcome, shown in the conversation and said when the panel first opens. */
export const welcomeText = (name) => `Hi, I'm ${name}. How can I help you? Type a message, or press Control Shift V to talk.`;
const MIC_WORDS = { starting: 'Starting', listening: 'Listening', paused: 'Listening paused' };

let counter = 0;
// The text box grows to about five lines, then scrolls.
const DRAFT_MAX_HEIGHT_PX = 120;
// Within this of the bottom counts as reading the newest turn, so new turns scroll into view.
const AT_END_PX = 8;

/**
 * @param {{document: !Document, mount: !Element, name: string, before?: ?Node}} options
 *     mount: where the panel goes (the right column); before: the node it goes before, else at the end
 */
export function createAssistantPanel({ document: doc, mount, name, before = null }) {
    const id = (part) => `assistant-${part}-${++counter}`;
    const el = (tag, attrs = {}, text = '') => {
        const node = doc.createElement(tag);
        for (const [key, value] of Object.entries(attrs)) {
            if (key === 'className') node.className = value;
            else node.setAttribute(key, value);
        }
        if (text) node.textContent = text;
        return node;
    };
    const icon = (cls) => el('i', { className: cls, 'aria-hidden': 'true' });

    const handlers = { send: null, interrupt: null, voice: null, clear: null, close: null, open: null, answer: null, draftInput: null,
        draftCleared: null, spokenRemoved: null };
    let restrictionText = '';
    const call = (key, ...args) => {
        if (restrictionText && key !== 'open' && key !== 'close') return;
        return handlers[key]?.(...args);
    };

    // Open button, shown while the panel is closed
    const openButton = el('button', { type: 'button', className: 'assistant-open', 'aria-keyshortcuts': 'Shift+P' });
    openButton.innerHTML = logoSvg(24);
    openButton.setAttribute('aria-label', `Open ${name} (Shift P)`);
    openButton.title = `Open ${name} (Shift P)`;
    openButton.addEventListener('click', () => call('open'));

    const headingId = id('heading');
    const panel = el('aside', { className: 'assistant-panel', 'aria-labelledby': headingId, 'data-own-keys': '' });
    panel.hidden = true;
    // Enter and Space press the panel's buttons; Blockly listens on the whole document and would act on them too.
    panel.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && /** @type {Element} */ (e.target).tagName === 'BUTTON') e.stopPropagation();
    });

    // Header: name, Clear, Minimize
    const header = el('header', { className: 'assistant-header' });
    const headerLogo = el('span', { className: 'assistant-header-logo', 'aria-hidden': 'true' });
    headerLogo.innerHTML = logoSvg(30);
    // The name, with "Blockly AI Companion" small under it; read as "Neon (Blockly AI Companion)".
    const heading = el('h2', { id: headingId, className: 'assistant-title' });
    heading.append(el('span', { className: 'assistant-title-name' }, name), el('span', { className: 'visually-hidden' }, ' ('),
        el('span', { className: 'assistant-title-sub' }, 'Blockly AI Tutor'), el('span', { className: 'visually-hidden' }, ')'));
    const status = el('p', { className: 'assistant-status visually-hidden' });
    const statusState = el('span', { className: 'assistant-status-state' });
    const statusNote = el('span', { className: 'assistant-status-note' });
    status.append(el('span', { className: 'visually-hidden' }, 'Status: '), statusState, statusNote);
    const clearButton = el('button', { type: 'button', className: 'assistant-btn', 'aria-label': 'Clear conversation', title: 'Clear conversation' });
    clearButton.append(icon('fas fa-trash-alt'));
    const closeButton = el('button', { type: 'button', className: 'assistant-btn', 'aria-keyshortcuts': 'Shift+P Escape' });
    closeButton.append(icon('fas fa-window-minimize'));
    closeButton.setAttribute('aria-label', `Minimize ${name} (Escape or Shift P)`);
    closeButton.title = `Minimize ${name} (Escape or Shift P)`;
    clearButton.addEventListener('click', () => call('clear'));
    closeButton.addEventListener('click', () => call('close'));
    const headerButtons = el('div', { className: 'assistant-header-buttons' });
    headerButtons.append(clearButton, closeButton);
    header.append(headerLogo, heading, headerButtons);
    const restriction = el('p', { className: 'assistant-restriction', tabindex: '-1' });
    restriction.hidden = true;

    // Transcript: not live (replies are heard through the output manager); focusable so it scrolls by keyboard
    const transcript = el('div', { className: 'assistant-transcript', role: 'log', 'aria-live': 'off', 'aria-label': 'Conversation', tabindex: '0' });
    const turns = el('ol', { className: 'assistant-turns' });
    transcript.append(turns);

    // Plan: the step list (step_list.js) goes in its body
    const planHeadingId = id('plan');
    const plan = el('section', { className: 'assistant-plan', 'aria-labelledby': planHeadingId });
    plan.hidden = true;
    const planHeading = el('h3', { id: planHeadingId, className: 'assistant-plan-title' }, 'Plan');
    const planBody = el('div', { className: 'assistant-plan-body' });
    plan.append(planHeading, planBody);

    // Answers: one group, for the latest reply
    const answers = el('div', { className: 'assistant-answers', role: 'group', 'aria-label': 'Answers' });
    answers.hidden = true;

    // Draft
    const draftArea = el('div', { className: 'assistant-draft' });
    const draftId = id('draft');
    const hintId = id('hint');
    const label = el('label', { for: draftId, className: 'assistant-draft-label visually-hidden' }, `Message to ${name}`);
    // The mode toggle: named for the mode it switches to (a microphone in text mode, a keyboard in voice mode).
    const voiceButton = el('button', { type: 'button', className: 'assistant-btn assistant-voice', 'aria-keyshortcuts': 'Control+Shift+V',
        'data-microphone-state': 'off' });
    const voiceIcon = icon('fas fa-microphone');
    const voiceLabel = el('span', { className: 'visually-hidden' }, 'Voice mode');
    voiceButton.append(voiceIcon, voiceLabel);
    voiceButton.title = 'Voice mode (Control Shift V)';
    // Voice mode's read-only area in the text box's place: the microphone's state and the dictated pieces.
    const voiceArea = el('div', { className: 'assistant-voice-area', role: 'textbox', 'aria-readonly': 'true', 'aria-multiline': 'true',
        tabindex: '0', 'aria-label': `Message to ${name}, voice`, 'data-microphone-state': 'off' });
    voiceArea.hidden = true;
    const voiceWords = el('p', { className: 'assistant-voice-words' });
    const voiceHeard = el('span', { className: 'assistant-voice-hearing', 'aria-hidden': 'true' });
    const textarea = el('textarea', { id: draftId, className: 'assistant-input', rows: '1', 'aria-describedby': hintId,
        placeholder: 'Ask me anything about your blocks...' });
    const sendButton = el('button', { type: 'button', className: 'assistant-btn assistant-send', 'aria-busy': 'false',
        'data-action': 'send', title: 'Send', disabled: '' });
    const sendIcon = icon('fa-solid fa-arrow-up');
    const sendLabel = el('span', { className: 'visually-hidden' }, 'Send');
    sendButton.append(sendIcon, sendLabel);
    const hint = el('p', { id: hintId, className: 'assistant-draft-hint visually-hidden' }, LANDED_HINT);
    const engineHint = el('p', { id: id('engine'), className: 'visually-hidden' });
    // Words still being recognized; screen readers skip them (the draft gets the finished words)
    const partial = el('p', { className: 'assistant-partial', 'aria-hidden': 'true' });
    const row = el('div', { className: 'assistant-draft-row' });
    // Voice mode, listening paused or stopped: a button above the mode toggle listens again.
    const resumeButton = el('button', { type: 'button', className: 'assistant-btn assistant-resume', title: 'Resume listening' });
    resumeButton.append(icon('fas fa-microphone'), el('span', { className: 'visually-hidden' }, 'Resume listening'));
    resumeButton.hidden = true;
    const modeButtons = el('div', { className: 'assistant-mode-buttons' });
    modeButtons.append(resumeButton, voiceButton);
    row.append(modeButtons, textarea, voiceArea, sendButton);
    // The microphone's state in words, in the voice area, so its colour is never the only sign.
    const micState = el('p', { className: 'assistant-mic-state', 'aria-hidden': 'true' });
    micState.hidden = true;
    voiceArea.append(micState, voiceWords);
    draftArea.append(status, label, row, partial, hint, engineHint);

    voiceButton.addEventListener('click', () => call('voice'));
    resumeButton.addEventListener('click', () => call('resume'));
    let engine = '';
    const renderMicState = () => {
        const state = voiceArea.dataset.microphoneState;
        const words = state === 'wake' ? `Listening for Hey ${name}` : state === 'off' ? 'Not listening' : MIC_WORDS[state] || '';
        micState.textContent = state === 'listening' && engine ? `${words}, ${engine}` : words;
        micState.hidden = !micState.textContent;
    };
    const syncResume = () => {
        resumeButton.hidden = panel.dataset.mode !== 'voice' || !['paused', 'off', 'wake'].includes(voiceArea.dataset.microphoneState);
    };
    sendButton.addEventListener('click', () => call(sendButton.dataset.action === 'pause' ? 'interrupt' : 'send'));
    // The dictated pieces (voice mode): Backspace in the voice area removes the newest one.
    /** @type {!Array<string>} */
    let pieces = [];
    let hearing = '';
    const setDraft = (text) => {
        textarea.value = text;
        resize();
        textarea.scrollTop = textarea.scrollHeight;
        updateSendAvailability();
        renderVoice();
    };
    function renderVoice() {
        voiceWords.textContent = '';
        for (const piece of pieces) voiceWords.append(el('span', { className: 'assistant-voice-piece' }, piece), ' ');
        voiceHeard.textContent = hearing;
        if (hearing) voiceWords.append(voiceHeard);
        // Long dictation: the newest words stay in sight.
        voiceArea.scrollTop = voiceArea.scrollHeight;
    }
    textarea.addEventListener('keydown', (e) => {
        const plain = !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
        if (e.key === 'Enter' && plain) {
            e.preventDefault();
            call('send');
            return;
        }
        // Ctrl+L clears the text box (here only; elsewhere the browser keeps it).
        if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyL') {
            e.preventDefault();
            pieces = [];
            setDraft('');
            call('draftCleared');
        }
    });
    textarea.addEventListener('input', () => {
        resize();
        updateSendAvailability();
        call('draftInput');
    });

    panel.append(header, restriction, transcript, plan, answers, draftArea);
    mount.insertBefore(panel, before);
    mount.insertBefore(openButton, panel);

    function resize() {
        textarea.style.height = 'auto';
        if (!textarea.value) textarea.style.height = '';
        else if (textarea.scrollHeight) textarea.style.height = `${Math.min(textarea.scrollHeight, DRAFT_MAX_HEIGHT_PX)}px`;
    }

    function updateSendAvailability() {
        sendButton.disabled = !!restrictionText || (sendButton.dataset.action !== 'pause' && !textarea.value.trim());
    }

    const atEnd = () => transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < AT_END_PX;
    // Reading the newest turn: it stays in view when the conversation gets smaller (the plan or the answers appear).
    // Only scrolling up, above where the panel last put it, stops that.
    let following = true;
    let pinnedTop = 0;
    const toEnd = () => {
        transcript.scrollTop = transcript.scrollHeight;
        pinnedTop = transcript.scrollTop;
    };
    transcript.addEventListener('scroll', () => {
        following = atEnd() || (following && transcript.scrollTop >= pinnedTop);
    });
    const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
        if (following) toEnd();
    }) : null;
    resized?.observe(transcript);

    // While a message is processed: the face blinking and three dots where the reply will be. Decorative only; the
    // status line says Working, as before.
    let thinking = null;
    function showThinking() {
        if (thinking) return;
        const stick = following || atEnd();
        thinking = el('li', { className: 'assistant-thinking', 'aria-hidden': 'true' });
        const avatar = el('span', { className: 'assistant-avatar' });
        avatar.innerHTML = logoSvg(24);
        const dots = el('span', { className: 'assistant-thinking-dots' });
        dots.append(el('span'), el('span'), el('span'));
        thinking.append(avatar, dots);
        turns.append(thinking);
        if (stick) toEnd();
    }
    function hideThinking() {
        thinking?.remove();
        thinking = null;
    }

    /** @param {'user'|'assistant'} role */
    function addTurn(role, text, { spoken = false } = {}) {
        // A reply takes the placeholder's place.
        if (role === 'assistant') hideThinking();
        const stick = following || atEnd();
        const item = el('li', { className: `assistant-turn assistant-turn--${role}`, tabindex: '-1', id: id('turn') });
        const avatar = el('span', { className: 'assistant-avatar', 'aria-hidden': 'true' });
        if (role === 'user') avatar.append(icon('fas fa-user'));
        else avatar.innerHTML = logoSvg(24);
        const who = el('span', { className: 'assistant-speaker visually-hidden' }, role === 'user' ? 'You' : name);
        item.append(avatar, who);
        if (spoken) item.append(' ', el('span', { className: 'assistant-spoken' }, '(spoken)'));
        // Model text is never HTML.
        item.append(el('span', { className: 'visually-hidden' }, ': '), el('p', { className: 'assistant-text' }, text));
        turns.append(item);
        if (stick) toEnd();
        // At the outer level the conversation is read with its latest reply.
        if (role === 'assistant') transcript.setAttribute('aria-describedby', item.id);
        return item;
    }

    /**
     * A short note about the conversation, such as a plan that ended; not a turn of either side. With details (the
     * ended plan's steps) the note is a button that shows and hides them, closed at first.
     * @param {string} text  @param {{details?: ?HTMLElement}=} options
     */
    function addNote(text, { details = null } = {}) {
        const stick = following || atEnd();
        let item;
        if (!details) {
            item = el('li', { className: 'assistant-note', id: id('note') });
            item.append(icon('fas fa-flag-checkered'), el('span', {}, text));
        } else {
            item = el('li', { className: 'assistant-note-wrap', id: id('note') });
            const toggle = el('button', { type: 'button', className: 'assistant-note-toggle', 'aria-expanded': 'false', 'aria-controls': details.id });
            const chevron = icon('fas fa-chevron-down');
            toggle.append(icon('fas fa-flag-checkered'), el('span', {}, text), chevron, el('span', { className: 'visually-hidden' }, ' Show steps'));
            details.hidden = true;
            toggle.addEventListener('click', () => {
                const open = details.hidden;
                details.hidden = !open;
                toggle.setAttribute('aria-expanded', String(open));
                chevron.className = `fas ${open ? 'fa-chevron-up' : 'fa-chevron-down'}`;
            });
            item.append(toggle, details);
        }
        turns.append(item);
        if (stick) toEnd();
        return item;
    }

    function welcome() {
        addTurn('assistant', welcomeText(name))
            .classList.add('assistant-turn--welcome');
    }
    welcome();

    /** The latest reply's turn, or null. */
    function latestReply() {
        const replies = turns.querySelectorAll('.assistant-turn--assistant');
        return replies.length ? /** @type {HTMLElement} */ (replies[replies.length - 1]) : null;
    }

    return {
        element: panel,
        openButton,
        textarea,
        voiceButton,
        voiceArea,
        resumeButton,
        sendButton,
        closeButton,
        restriction,
        /** The plan section and its body, for the step list. */
        plan: { section: plan, heading: planHeading, body: planBody },
        transcript,
        answers,
        /** Whether the text box is for typing now (its hint says how to start or stop). */
        setTyping(typing) {
            hint.textContent = typing ? TYPING_HINT : LANDED_HINT;
        },
        /** @param {Object<string, function(...*)>} map send, interrupt, voice, clear, close, open, answer(name), draftInput */
        on(map) {
            Object.assign(handlers, map);
        },
        isOpen: () => !panel.hidden,
        setOpen(open) {
            panel.hidden = !open;
            openButton.hidden = open;
        },
        contains: (node) => !!node && (panel.contains(node) || node === openButton),
        /** An empty message restores input; the close and open controls remain available. */
        setRestriction(message) {
            restrictionText = message;
            restriction.textContent = message;
            restriction.hidden = !message;
            panel.toggleAttribute('data-restricted', !!message);
            openButton.toggleAttribute('data-restricted', !!message);
            textarea.disabled = !!message;
            voiceButton.disabled = !!message;
            resumeButton.disabled = !!message;
            clearButton.disabled = !!message;
            voiceArea.setAttribute('aria-disabled', String(!!message));
            voiceArea.tabIndex = message ? -1 : 0;
            for (const section of [transcript, plan, answers]) section.inert = !!message;
            updateSendAvailability();
        },
        addTurn,
        /**
         * Changes a turn's text without moving focus, scrolling or announcing it.
         * @param {!HTMLElement} turn
         * @param {string} text
         */
        updateTurn(turn, text) {
            const line = turns.contains(turn) && turn.querySelector('.assistant-text');
            if (!line) return false;
            line.textContent = String(text);
            return true;
        },
        addNote,
        /** Empties the transcript, keeping the welcome turn. */
        clear() {
            hideThinking();
            turns.textContent = '';
            welcome();
        },
        latestReply,
        /**
         * Shows the answers available now; a focused button that goes away hands focus to the text box.
         * @param {!Array<{name: string, label: string}>} actions
         */
        setAnswers(actions) {
            const hadFocus = answers.contains(doc.activeElement) ? /** @type {HTMLElement} */ (doc.activeElement).dataset.answer : null;
            answers.textContent = '';
            for (const action of [...actions].sort((a, b) => answerRank(a.name) - answerRank(b.name))) {
                const button = el('button', { type: 'button', className: 'assistant-btn assistant-answer', 'data-answer': action.name });
                if (ANSWER_ICONS[action.name]) button.append(icon(`fas ${ANSWER_ICONS[action.name]}`));
                button.append(el('span', {}, action.label));
                const key = ANSWER_KEYS[action.name];
                if (key) {
                    button.setAttribute('aria-keyshortcuts', key);
                    button.title = `${action.label} (${key})`;
                    button.append(el('span', { className: 'assistant-key visually-hidden', 'aria-hidden': 'true' }, key.replace(/\+/g, ' ')));
                }
                button.addEventListener('click', () => call('answer', action.name));
                answers.append(button);
            }
            answers.hidden = !actions.length;
            // The answers belong to the latest reply, so a screen reader can read it with them.
            const reply = latestReply();
            if (actions.length && reply) answers.setAttribute('aria-describedby', reply.id);
            else answers.removeAttribute('aria-describedby');
            if (hadFocus) {
                const same = answers.querySelector(`[data-answer="${hadFocus}"]`);
                (same || textarea).focus();
            }
        },
        /** @param {string} state  @param {string=} note */
        setStatus(state, note = '') {
            statusState.textContent = state;
            statusNote.textContent = note ? (state ? `. ${note}` : note) : '';
        },
        statusText: () => status.textContent.replace(/^Status: /, ''),
        setBusy(busy) {
            sendButton.setAttribute('aria-busy', String(busy));
            updateSendAvailability();
        },
        /** @param {'send'|'pause'} action */
        setSendAction(action) {
            if (sendButton.dataset.action === action) {
                updateSendAvailability();
                return;
            }
            sendButton.dataset.action = action;
            // Pause shows while a message is processed (Send comes back when it is done, stopped or failed).
            if (action === 'pause') showThinking();
            else hideThinking();
            sendIcon.className = action === 'pause' ? 'fa-solid fa-pause' : 'fa-solid fa-arrow-up';
            sendLabel.textContent = action === 'pause' ? 'Pause response' : 'Send';
            sendButton.title = sendLabel.textContent;
            updateSendAvailability();
        },
        /** @param {string} state  off, starting, listening, wake; 'paused' while keyboard use pauses listening */
        setMicrophoneState(state) {
            voiceButton.dataset.microphoneState = state;
            voiceArea.dataset.microphoneState = state;
            renderMicState();
            syncResume();
        },
        /** @param {string} next  server, basic or browser: off the server engine the state says so, in orange */
        setEngine(next) {
            engine = next === 'server' ? '' : next;
            if (engine) voiceArea.dataset.engine = engine;
            else delete voiceArea.dataset.engine;
            // The name stays the same (a screen reader may repeat a changed name); the engine is a description.
            engineHint.textContent = engine ? `${engine} speech engine` : '';
            if (engine) voiceArea.setAttribute('aria-describedby', engineHint.id);
            else voiceArea.removeAttribute('aria-describedby');
            renderMicState();
        },
        /** Text mode: the text box. Voice mode: the voice area, and the toggle switches back to text. */
        setMode(mode) {
            const voice = mode === 'voice';
            if (voice) pieces = textarea.value.trim() ? [textarea.value.trim()] : [];
            else hearing = '';
            renderVoice();
            textarea.hidden = voice;
            voiceArea.hidden = !voice;
            panel.dataset.mode = voice ? 'voice' : 'text';
            voiceLabel.textContent = voice ? 'Text mode' : 'Voice mode';
            voiceButton.title = `${voiceLabel.textContent} (Control Shift V)`;
            voiceIcon.className = voice ? 'fas fa-keyboard' : 'fas fa-microphone';
            syncResume();
        },
        /** The dictated pieces, oldest first. */
        pieces: () => [...pieces],
        /** Backspace in voice mode: the newest piece goes. @returns {?string} what was removed */
        removePiece() {
            const removed = pieces.pop();
            if (removed === undefined) return null;
            setDraft(pieces.join(' '));
            return removed;
        },
        /** @param {string} text */
        setVoiceAnnouncement(text) {
            if (text) partial.dataset.announcement = text;
            else delete partial.dataset.announcement;
        },
        draft: {
            value: () => textarea.value,
            set(text) {
                pieces = text.trim() ? [text.trim()] : [];
                setDraft(text);
            },
            /** Adds a spoken piece: the new text, and the text before it. */
            setSpoken(text, before) {
                const piece = text.slice(before.length).trim();
                if (piece) pieces.push(piece);
                setDraft(text);
            },
            setPartial(text) {
                if (text) delete partial.dataset.announcement;
                partial.textContent = text;
                hearing = text;
                renderVoice();
            },
        },
        dispose() {
            resized?.disconnect();
            panel.remove();
            openButton.remove();
        },
    };
}
