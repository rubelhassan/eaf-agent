// @ts-check
/**
 * The assistant in the app: the panel, the voice conversation and the coordinator. Replies are heard through the
 * output manager and written to the transcript; the panel never moves focus on a reply, except the voice
 * conversation's own rule (spoken words bring focus to the text box, where it stays; Ctrl+Q or Escape goes to the editor).
 */

import { createAssistantPanel, welcomeText } from './panel.js';
import { createStepList, endedStepsList, enterLine, planEndedText, stepText } from './step_list.js';

export const DEFAULT_NAME = 'Neon';

// The agent server's rule, so the panel and the server use the same name.
const NAME_RULE = /^[A-Za-z]{1,32}$/;

/** The assistant's name from config.local.js (`assistantName`): one word of letters, 1 to 32 long, or Neon. */
export function assistantName(config) {
    const name = typeof config?.assistantName === 'string' ? config.assistantName.trim() : '';
    if (!name) return DEFAULT_NAME;
    if (NAME_RULE.test(name)) return name;
    console.warn(`[assistant] assistantName "${name}" must be one word of letters (A to Z), 1 to 32 long; using ${DEFAULT_NAME}.`);
    return DEFAULT_NAME;
}

// SessionState values of src/voice/conversation_controller.js
const ACTIVE = 'active';
const STARTING = 'starting';

const WORKING_UPDATE_MS = 10000;
const SENT_MESSAGES = 10;
const FAILED = 'Sorry, something went wrong. Please try again.';
const LISTENING_ANNOUNCEMENT = "I'm listening.";
const STEPS_INTRO = 'The steps are in the panel. Press Alt Shift L to go through them.';
const NO_PLAN = 'There is no plan now.';

// The panel's moving keys (rows and items) besides Enter; Q comes back out of the turns.
const ROW_KEYS = new Set(['w', 's', 'a', 'd', 'f', 'q', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
// After keyboard navigation in the panel, listening resumes once the keys have been quiet this long.
const NAV_QUIET_MS = 5000;
const plainKey = (e) => !e.ctrlKey && !e.altKey && !e.metaKey;
// The draft row's mode (voice or text), remembered per browser; voice the first time.
const MODE_KEY = 'eaf.assistantMode';
function savedMode(storage) {
    try {
        return storage?.getItem(MODE_KEY) === 'text' ? 'text' : 'voice';
    } catch (e) {
        return 'voice';
    }
}
/** The plugin's answer words (yes, no...), when the bundle is on the page. */
const answerCommand = (text) => {
    const match = /** @type {any} */ (globalThis).matchCommand;
    return typeof match === 'function' ? match(text) : null;
};

const isTyping = (target) => !!target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])');

/**
 * @param {{workspace: !Object, coordinator: !Object, output: !Object, createConversation: function(!Object): !Object,
 *     conversation?: !Object, name?: string, offline?: boolean, document?: !Document, mount?: ?Element,
 *     before?: ?Node, focusWorkspace?: function(): void, onEvent?: function(string, !Object): void,
 *     isQuiz?: function(): boolean, onPolicyChange?: function(function(): void): function(): void}} options
 *     coordinator: from createCoordinator; output: from createOutputManager; createConversation: the voice
 *     conversation controller's factory (createConversationController), given the draft, submit and state callbacks;
 *     conversation: more options for it (recognizer, vad, spotter, settings, isBusy, isWaiting, ...);
 *     offline: the assistant gives practice replies (no agent server); onEvent: task and voice events
 */
export function createAssistantUi(options) {
    const { workspace, coordinator, output } = options;
    const doc = options.document || document;
    const name = options.name || DEFAULT_NAME;
    const onEvent = options.onEvent || options.conversation?.onEvent || (() => {});
    const focusWorkspace = options.focusWorkspace || (() => workspace.getParentSvg?.()?.focus());
    const mount = options.mount || doc.querySelector('.execution-panel') || doc.body;
    const panel = createAssistantPanel({ document: doc, mount, name, before: options.before ?? null });
    let quizRestricted = options.isQuiz?.() === true;
    let restrictionInitialized = false;
    const quizMessage = `${name} can not help you during Quiz.`;
    // Preparing now reduces the pause on the first open.
    if (!quizRestricted) output.prepareAssistant?.(welcomeText(name));

    let busy = false;
    let requestInterrupted = false;
    let listenedBefore = false;
    let micState = 'off';
    let sessionState = 'inactive';
    let returnFocusTo = null;
    let toldOffline = false;
    let saidWelcome = false;
    let storage = options.storage;
    if (storage === undefined) {
        try {
            storage = globalThis.localStorage;
        } catch (e) {
            storage = null;
        }
    }
    let mode = savedMode(storage);
    // A voice start that never reached listening (not set up, microphone blocked) falls back to text mode.
    let startingVoice = false;
    let workingTimer = null;
    let requestCount = 0;
    const sentMessages = [];
    let disposed = false;
    // The step list: the plan shown last, a "Plan ended" note and the Alt Shift L line waiting for the reply.
    let shownPlanId = null;
    let pendingNote = null;
    let introPending = false;
    let toldSteps = false;
    // Where focus was in the panel last (the text box, the step list, a button); Shift+P comes back to it.
    let lastPanelFocus = null;
    /** The coordinator's latest plan view (live or just ended), for when Undo a step is offered. */
    let lastPlan = null;
    // In the text box: typing (Enter or F) or only landed on it.
    let typing = false;
    let navigating = false;
    let navTimer = null;
    // The quiet time ran out on the keyboard or resume button: listening stays paused until focus moves on.
    let holding = false;

    const api = {
        name,
        panel,
        conversation: null,
        /** Called after each reply is shown (the host resets the navigation lock's message). */
        onReply: null,
        open,
        close,
        toggle: () => (panel.isOpen() ? close() : open()),
        hide,
        isOpen: () => panel.isOpen(),
        talk,
        runCommand,
        displayReply,
        sayProgress,
        handleUserInput,
        focusLatestReply,
        refreshStatus,
        showPlan,
        focusSteps,
        dispose,
    };

    // The panel's own lines go on the assistant route (the Assistant replies setting). Lines that come with a focus move
    // only when Navigation speech is the built-in voice: a screen reader reads the focus move itself.
    const route = () => (output.settings?.().aiOutput === 'screenReader' ? 'screenReader' : 'voice');
    const panelSay = (text) => output.say({ source: 'assistant', kind: 'status', text });
    const panelLine = (text) => {
        if (output.settings?.().systemOutput === 'systemVoice') panelSay(text);
    };

    let speechEngine = 'server';
    let idleStop = false;
    const hostSettings = options.conversation?.settings;
    api.conversation = options.createConversation({
        ...(options.conversation || {}),
        // "Listen for Hey Neon" only in voice mode; in text mode nothing listens.
        ...(hostSettings ? { settings: () => ({ ...hostSettings(), wakePhrase: !!hostSettings().wakePhrase && mode === 'voice' && !quizRestricted }) } : {}),
        output,
        onEvent: (kind, data) => {
            if (kind === 'session.idle') idleStop = true;
            options.conversation?.onEvent?.(kind, data);
        },
        // Off the server engine the voice area's state says so ("Listening, basic") in orange; reconnecting stays quiet.
        onEngineState: (state) => {
            speechEngine = state.engine || 'server';
            panel.setEngine(speechEngine);
            options.conversation?.onEngineState?.(state);
            refreshStatus();
        },
        draft: {
            value: () => panel.draft.value(),
            set: (text, metadata = {}) => {
                if (quizRestricted) return;
                if (metadata.replay) { panel.draft.set(text); return; }
                // Spoken words come in at the end of the draft, one piece each.
                const before = panel.draft.value();
                const spoken = !!text && text.startsWith(before.replace(/\s+$/, ''));
                // A spoken answer (yes, no...) to the answers shown now is an answer, not part of a message.
                const command = spoken && !before.trim() ? answerCommand(text.trim()) : null;
                if (command && shownAnswers().includes(command)) {
                    runCommand(command, 'voice');
                    return;
                }
                if (spoken) panel.draft.setSpoken(text, before);
                else panel.draft.set(text);
                if (text) focusDraft();
            },
            setPartial: (text) => {
                if (quizRestricted) return;
                panel.draft.setPartial(text);
                if (text) focusDraft();
            },
        },
        submit: (text, medium, metadata) => handleUserInput(text, medium, metadata),
        onReplay: (updates) => updateSentMessage(updates),
        onReplayDrop: (ids) => {
            for (const sent of sentMessages) for (const piece of sent.segments) {
                if (ids.includes(piece.utterance)) piece.provisional = false;
            }
        },
        onState: (state) => showSession(state),
        onWakePaused: () => resumeListening(),
        onMicrophoneState: (state) => {
            micState = state;
            panel.setMicrophoneState(state);
            refreshStatus();
        },
    });
    const conversation = api.conversation;
    panel.setMode(mode);

    panel.on({
        open: () => open(),
        close: () => close(),
        send: () => { if (!blockQuizInput()) conversation.send(); },
        interrupt: () => {
            if (!busy || requestInterrupted) return;
            requestInterrupted = true;
            conversation.cancelPending?.();
            output.interrupt();
            onEvent('speech.interrupted', {by: 'button'});
            refreshStatus();
            panel.textarea.focus();
        },
        voice: () => setMode(mode === 'voice' ? 'text' : 'voice'),
        resume: () => resumeListening(),
        clear: () => {
            panel.clear();
            panel.textarea.focus();
        },
        answer: (command) => {
            if (!busy) runCommand(command, 'button');
        },
        draftInput: () => { conversation.draftEdited?.(); conversation.noteActivity?.(); },
        draftCleared: () => {
            conversation.draftEdited?.();
            conversation.noteActivity?.();
            panelSay('Text box cleared.');
        },
    });
    panel.element.addEventListener('focusin', (e) => {
        lastPanelFocus = e.target;
    });
    // A click in the text box is for typing; leaving it, the next visit lands without typing.
    panel.textarea.addEventListener('pointerdown', () => setTyping(true));
    panel.textarea.addEventListener('blur', () => setTyping(false));

    const steps = createStepList({
        document: doc,
        ...panel.plan,
        onEnter: (view, index) => enterStep(view, index),
        onEdge: (direction) => moveRow(direction === 'up' ? -1 : 1),
        // A screen reader reads the selected option; with the built-in voice the panel says it.
        onSelect: (text) => panelLine(text),
    });

    const offState = output.onState?.((state) => {
        if (state !== 'speaking') panel.setVoiceAnnouncement('');
        refreshStatus();
    });
    const offSpeak = output.onSpeak?.((text) => {
        panel.setVoiceAnnouncement('');
        if (sessionState === STARTING && route() === 'voice' && text === LISTENING_ANNOUNCEMENT) {
            panel.setVoiceAnnouncement(text);
        }
    });

    const onKeyDown = (e) => {
        if (disposed) return;
        // Ctrl+Enter (Cmd+Enter on a Mac) sends the draft from anywhere
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && panel.isOpen()) {
            e.preventDefault();
            if (blockQuizInput()) return;
            conversation.send();
            return;
        }
        if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'p' || e.key === 'P')) {
            // A capital P while typing is just a letter.
            if (isTyping(e.target)) return;
            e.preventDefault();
            // From outside an open panel, back into it; from inside, it closes.
            if (panel.isOpen() && !panel.contains(e.target)) focusPanel();
            else api.toggle();
            return;
        }
        if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyV') {
            e.preventDefault();
            if (blockQuizInput()) return;
            // Closed: the panel opens in voice mode. Open: voice and text mode switch; in voice mode that stopped
            // listening (idle, "stop listening"), it listens again.
            if (!panel.isOpen()) {
                applyMode('voice');
                open();
            } else if (mode === 'voice' && sessionState === 'inactive') {
                startVoice();
            } else {
                setMode(mode === 'voice' ? 'text' : 'voice');
            }
            return;
        }
        if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyM') {
            e.preventDefault();
            focusLatestReply();
            return;
        }
        if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyL') {
            e.preventDefault();
            focusSteps();
            return;
        }
    };
    /**
     * The panel's keys, before the editor's shortcuts and the navigation lock see them. The panel is rows, top to
     * bottom: the conversation, each step of the plan, the answers, and the draft (Mic, text box, Send). W and S (or Up
     * and Down) move between rows, A and D (or Left and Right) within one. F on the conversation goes into its turns
     * (W and S between them, Q or Escape back out). The text box is landed on without typing; Enter or F starts typing
     * and Escape stops it. Escape anywhere else hides the panel; Ctrl+Q goes to the editor and leaves it open. Escape
     * is not stopped: the runner and the assistant's task stop still get it.
     */
    const onPanelKey = (e) => {
        if (!panel.isOpen() || !panel.element.contains(e.target)) return;
        const target = /** @type {HTMLElement} */ (e.target);
        // Moving around the panel: the built-in voice reads the items, so the microphone waits (typing doesn't count).
        if (!quizRestricted && !(target === panel.textarea && typing) && !['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) noteNavigation();
        const take = () => {
            e.preventDefault();
            e.stopImmediatePropagation();
        };
        if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyQ') {
            take();
            toEditor();
            return;
        }
        const inTurns = target.classList.contains('assistant-turn') || target.classList.contains('assistant-note-toggle');
        if (e.key === 'Escape' && plainKey(e) && !e.shiftKey) {
            conversation.cancelPending?.();
            e.preventDefault();
            if (target === panel.textarea && typing) setTyping(false, { say: true });
            else if (inTurns) focusItem(panel.transcript);
            else hide();
            return;
        }
        if (quizRestricted) return;
        if (target === panel.textarea && typing) return;
        if (!plainKey(e)) return;
        // The voice area: Enter reads the message back, Backspace removes the newest piece; the moving keys move.
        if (target === panel.voiceArea && !e.shiftKey) {
            if (e.key === 'Enter') {
                take();
                readBack();
                return;
            }
            if (e.key === 'Backspace' || e.key === 'Delete') {
                take();
                const removed = panel.removePiece();
                conversation.noteActivity?.();
                panelSay(removed ? `Removed: ${removed}` : 'Nothing to remove.');
                return;
            }
            const letter = e.key.length === 1 ? e.key.toLowerCase() : e.key;
            if (!ROW_KEYS.has(letter) && e.key.length === 1) {
                take();
                panelSay('Voice mode. Press Control Shift V to type.');
                return;
            }
        }
        const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        // Landed on the text box: the keys move, they don't type.
        if (target === panel.textarea) {
            if (e.shiftKey && key === 'p') {
                take();
                close();
                return;
            }
            if (key === 'f' || key === 'Enter') {
                take();
                setTyping(true, { say: true });
                return;
            }
            const printable = e.key.length === 1 || key === 'Backspace' || key === 'Delete';
            if (!ROW_KEYS.has(key) && printable) {
                take();
                panelSay('Press Enter to type.');
                return;
            }
        }
        if (e.shiftKey || !ROW_KEYS.has(key)) return;
        if (inTurns) {
            if (key === 'w' || key === 's') {
                take();
                const turns = [...panel.element.querySelectorAll('.assistant-turn, .assistant-note-toggle')];
                const at = turns.indexOf(target);
                focusItem(turns[Math.max(0, Math.min(turns.length - 1, at + (key === 'w' ? -1 : 1)))]);
            } else if (key === 'q') {
                take();
                focusItem(panel.transcript);
            }
            return;
        }
        if (target === panel.transcript && (key === 'f' || key === 'Enter')) {
            take();
            const reply = panel.latestReply();
            if (reply) focusItem(reply);
            return;
        }
        // The step list moves its own selection and hands over at its ends (onEdge).
        if (target === steps.element || key === 'f' || key === 'q' || key === 'Enter') return;
        const vertical = { w: -1, ArrowUp: -1, s: 1, ArrowDown: 1 }[key];
        const horizontal = { a: -1, ArrowLeft: -1, d: 1, ArrowRight: 1 }[key];
        if (vertical) {
            take();
            moveRow(vertical);
        } else if (horizontal) {
            take();
            const row = rows()[rowIndex(target)];
            const items = row?.items.filter((item) => !item.disabled) || [];
            const at = items.indexOf(target);
            if (at >= 0) focusItem(items[Math.max(0, Math.min(items.length - 1, at + horizontal))]);
        }
    };
    doc.addEventListener('keydown', onPanelKey, true);
    doc.addEventListener('keydown', onKeyDown);
    const onFocusOut = (e) => {
        // Focus going nowhere (to the page itself) is only known after the event.
        if (!e.relatedTarget) setTimeout(updateAway, 0);
    };
    doc.addEventListener('focusin', updateAway);
    doc.addEventListener('focusout', onFocusOut);

    const offPolicy = options.onPolicyChange?.(syncQuizRestriction);
    syncQuizRestriction();
    updateAway();
    refreshStatus();

    function announceQuiz() {
        // Screen-reader focus reads the notice; a voice reply focuses the separate Close control to avoid a repeat.
        if (route() === 'screenReader') panel.restriction.focus();
        else {
            panel.closeButton.focus();
            panelSay(quizMessage);
        }
    }

    function blockQuizInput() {
        if (!quizRestricted) return false;
        if (!panel.isOpen()) open();
        else announceQuiz();
        return true;
    }

    function syncQuizRestriction() {
        const restricted = options.isQuiz?.() === true;
        if (restrictionInitialized && restricted === quizRestricted) return;
        const entering = restricted && !quizRestricted;
        const leaving = restrictionInitialized && !restricted;
        restrictionInitialized = true;
        const noticeFocused = doc.activeElement === panel.restriction;
        quizRestricted = restricted;
        panel.setRestriction(restricted ? quizMessage : '');
        if (restricted) {
            requestCount++;
            startingVoice = false;
            stopWorkingUpdates();
            clearTimeout(navTimer);
            navigating = false;
            conversation.cancelPending?.();
            if (conversation.micOff) conversation.micOff();
            else conversation.end();
            coordinator.cancel?.();
            output.interrupt();
            busy = false;
            panel.setBusy(false);
            panel.setAnswers([]);
            steps.update(null);
            lastPlan = null;
            pendingNote = null;
            introPending = false;
            if (entering && panel.isOpen()) panelSay(quizMessage);
        } else if (noticeFocused && panel.isOpen()) focusPanel();
        if (restricted || leaving) conversation.refreshWake?.();
        refreshStatus();
    }

    function inConversation() {
        return sessionState === ACTIVE;
    }

    function open() {
        if (panel.isOpen()) return;
        const active = doc.activeElement;
        returnFocusTo = active && active !== doc.body && !panel.contains(active) ? active : null;
        panel.setOpen(true);
        if (quizRestricted) {
            announceQuiz();
            return;
        }
        // The first open says the welcome that is on screen, before where focus landed.
        if (!saidWelcome) {
            saidWelcome = true;
            const welcome = welcomeText(name);
            output.prepareAssistant?.(welcome);
            panelSay(welcome);
        }
        // Says where focus landed: "Neon, text box".
        focusPanel();
        if (mode === 'voice' && sessionState === 'inactive') startVoice();
        if (options.offline && !toldOffline) {
            toldOffline = true;
            panelSay(`${name} is offline and gives practice replies.`);
        }
    }

    /** Focus back where it was in the panel, if that is still there (the step list only with a plan); else the text box. */
    function focusPanel() {
        if (quizRestricted) { announceQuiz(); return; }
        const last = lastPanelFocus;
        const draftItem = mode === 'voice' ? panel.voiceArea : panel.textarea;
        if (last === steps.element) {
            if (!steps.focus()) draftItem.focus();
        } else if (last?.isConnected && panel.element.contains(last) && last !== panel.element && !last.closest?.('[hidden]')) {
            last.focus();
        } else {
            draftItem.focus();
        }
        if (doc.activeElement === panel.textarea) setTyping(false);
        panelLine(`${name}, ${focusLine(doc.activeElement)}`);
    }

    /**
     * The panel's rows, top to bottom: the conversation, each step of the plan, the answers, the draft. Each row's
     * items are what A and D move between.
     * @returns {!Array<{name: string, step?: number, items: !Array<!HTMLElement>}>}
     */
    function rows() {
        const list = [{ name: 'conversation', items: [panel.transcript] }];
        for (let i = 0; i < steps.count(); i++) list.push({ name: 'step', step: i, items: [steps.element] });
        const answers = [...panel.answers.querySelectorAll('button')];
        if (!panel.answers.hidden && answers.length) list.push({ name: 'answers', items: answers });
        if (!panel.resumeButton.hidden) list.push({ name: 'resume', items: [panel.resumeButton] });
        list.push({ name: 'draft', items: [panel.voiceButton, mode === 'voice' ? panel.voiceArea : panel.textarea, panel.sendButton] });
        return list;
    }

    /** The row an element is in (the step list: the selected step's row), or -1. */
    function rowIndex(element) {
        const list = rows();
        if (element === steps.element) return list.findIndex((r) => r.name === 'step' && r.step === steps.selected());
        if (element?.closest?.('.assistant-transcript')) return 0;
        return list.findIndex((r) => r.items.includes(element));
    }

    /** W or S: the row above or below; a row is entered at its first item (a step row at its step). */
    function moveRow(direction) {
        const list = rows();
        const from = rowIndex(doc.activeElement);
        const row = list[from + direction];
        if (!row) return;
        if (row.name === 'step') {
            steps.selectStep(row.step);
            focusItem(steps.element);
            return;
        }
        focusItem(row.items.find((item) => !item.disabled) || row.items[0]);
    }

    /** Focus to an item, said on the assistant route (with a screen reader the focus move speaks for itself). */
    function focusItem(element) {
        if (!element) return;
        if (element === panel.textarea) setTyping(false);
        element.focus();
        element.scrollIntoView?.({ block: 'nearest' });
        panelLine(focusLine(element));
    }

    /** What reaching an item says. */
    function focusLine(element) {
        if (element === panel.textarea) {
            const text = panel.draft.value();
            return text ? `Text box: ${text}. Press Enter to type.` : 'Text box, empty. Press Enter to type.';
        }
        if (element === steps.element && steps.view()) return stepText(steps.view(), steps.selected());
        if (element === panel.transcript) return `Conversation. ${panel.latestReply()?.querySelector('.assistant-text')?.textContent || ''}`.trim();
        // The label only: the built-in voice clips a trailing "button" (a screen reader says the role itself).
        if (element === panel.voiceButton) return mode === 'voice' ? 'Text mode' : 'Voice mode';
        if (element === panel.voiceArea) {
            const text = panel.draft.value().trim();
            return text ? `Voice: ${text}` : 'Voice, nothing said yet.';
        }
        if (element === panel.resumeButton) return 'Resume listening';
        if (element === panel.sendButton) return element.textContent.trim() || 'Send';
        if (element?.classList?.contains('assistant-note-toggle')) return `${element.textContent.trim()}, ${element.getAttribute('aria-expanded') === 'true' ? 'expanded' : 'collapsed'}`;
        if (element?.classList?.contains('assistant-answer')) {
            const key = element.getAttribute('aria-keyshortcuts');
            const label = element.querySelector('span')?.textContent || element.textContent;
            return key ? `${label}, ${key.replace(/\+/g, ' ')}` : label;
        }
        if (element?.tagName === 'BUTTON') return element.querySelector('span')?.textContent || element.textContent;
        if (element?.classList?.contains('assistant-turn')) return element.textContent;
        return '';
    }

    /** The text box is for typing (Enter or F) or only landed on (moving keys work there). */
    function setTyping(on, { say = false } = {}) {
        typing = on;
        panel.setTyping(on);
        if (say) panelLine(on ? 'Typing.' : focusLine(panel.textarea));
    }

    /** Where the editor's cursor is, said like any cursor announcement: "Editor, print block, block 1 of stack A". */
    function editorLine() {
        if (options.describeCursor) return options.describeCursor();
        const node = workspace.getCursor?.()?.getCurNode?.();
        const type = node?.getType?.();
        if (type === 'workspace') return 'Editor, workspace';
        const block = node?.getSourceBlock?.() || (type === 'stack' ? node.getLocation() : null);
        const g = /** @type {any} */ (globalThis);
        if (!block || typeof g.describeBlockLocation !== 'function') return 'Editor';
        const at = g.describeBlockLocation(block);
        if (type === 'stack') return `Editor, ${at.replace(/, block \d+$/, '')}`;
        const kind = typeof g.blockTypeName === 'function' ? `${g.blockTypeName(block.type)} block` : 'block';
        const where = at.replace(/^stack (\w+), block (\d+)$/, 'block $2 of stack $1');
        return where ? `Editor, ${kind}, ${where}` : `Editor, ${kind}`;
    }

    /** Ctrl+Q: to the editor's cursor, the panel left open; the position goes on the application route. */
    function toEditor() {
        focusWorkspace();
        output.say({ source: 'system', kind: 'navigation', text: editorLine() });
    }

    /**
     * @param {{toWorkspace?: boolean}=} options toWorkspace: focus goes to the editor's cursor, not where it came from
     */
    function close({ toWorkspace = false } = {}) {
        if (!panel.isOpen()) return;
        conversation.end();
        output.interrupt();
        panel.setOpen(false);
        const back = !toWorkspace && returnFocusTo && returnFocusTo.isConnected && returnFocusTo !== panel.openButton ? returnFocusTo : null;
        returnFocusTo = null;
        if (back) back.focus();
        else focusWorkspace();
        // Back in the editor: its position, like any cursor announcement; elsewhere the focus speaks for itself.
        const inEditor = !back || back === workspace.getParentSvg?.() || !!workspace.getInjectionDiv?.()?.contains(back);
        if (inEditor) output.say({ source: 'system', kind: 'navigation', text: editorLine() });
        else panelLine(`${name} is closed.`);
    }

    /** Escape at the outer level: hidden like closing, the draft kept, focus on the editor's cursor (said). */
    function hide() {
        close({ toWorkspace: true });
    }

    /** Alt+Shift+M: the latest reply in the transcript, opening the panel if needed. */
    function focusLatestReply() {
        if (blockQuizInput()) return false;
        if (!panel.isOpen()) open();
        const reply = panel.latestReply();
        if (!reply) return false;
        reply.scrollIntoView?.({ block: 'nearest' });
        reply.focus();
        return true;
    }

    /** Alt+Shift+L: the first step, opening the panel if needed. */
    function focusSteps() {
        if (blockQuizInput()) return false;
        if (!panel.isOpen()) open();
        if (!steps.count()) {
            panelSay(NO_PLAN);
            return false;
        }
        steps.selectStep(0);
        focusItem(steps.element);
        return true;
    }

    /**
     * The coordinator's step list changed (its onPlanChange). An ended plan leaves a note after the reply that ended it.
     * @param {?Object} view the coordinator's plan()
     */
    function showPlan(view) {
        if (disposed || quizRestricted) return;
        if (view?.ended && view.proposalId === shownPlanId) pendingNote = view;
        lastPlan = view;
        const live = !!view && !view.ended;
        shownPlanId = live ? view.proposalId : null;
        if (live && !toldSteps) {
            toldSteps = true;
            introPending = true;
        }
        const { hadFocus } = steps.update(view);
        if (hadFocus) panel.textarea.focus();
        // Normally the reply that changed the plan comes right after; if not, the note still goes in.
        if (pendingNote) setTimeout(flushPlanLines, 0);
    }

    function flushPlanLines() {
        if (pendingNote) {
            const view = pendingNote;
            pendingNote = null;
            panel.addNote(planEndedText(view), { details: endedStepsList(doc, view, `${panel.element.id || 'assistant'}-ended-${view.proposalId}`) });
        }
    }

    /**
     * Enter or Space on a step never applies it. On the next step (Step-confirm) the panel asks and focus goes to Yes;
     * other steps get their line.
     */
    function enterStep(view, index) {
        if (blockQuizInput()) return;
        const { ask, line } = enterLine(view, index);
        panelSay(line);
        if (ask) panel.answers.querySelector('[data-answer="yes"]')?.focus();
    }

    /** Ctrl+Shift+I: stop the assistant voice and listen (opening the panel if needed). */
    function talk() {
        if (blockQuizInput()) return;
        bringFocusIn();
        conversation.talk();
    }

    function focusInPanel() {
        return panel.isOpen() && panel.element.contains(doc.activeElement);
    }

    /** Opens the panel, or brings focus back into an open one (listening resumes there). */
    function bringFocusIn() {
        if (!panel.isOpen()) open();
        else if (!focusInPanel()) focusPanel();
    }

    /**
     * Listening waits while focus is outside the panel: the microphone would hear navigation speech as the learner's
     * words. The conversation stays on; the controller plays the listening cues.
     */
    /** A navigation key in the panel: listening pauses now and resumes after a quiet while. */
    function noteNavigation() {
        clearTimeout(navTimer);
        holding = false;
        navigating = true;
        updateAway();
        navTimer = setTimeout(() => {
            if (onResumeButtons()) {
                holding = true;
                return;
            }
            navigating = false;
            updateAway();
        }, options.navQuietMs ?? NAV_QUIET_MS);
    }

    const onResumeButtons = () => mode === 'voice' && (doc.activeElement === panel.voiceButton || doc.activeElement === panel.resumeButton);

    /** The resume button or "Hey Neon" while paused: focus to the voice area, and listening again. */
    function resumeListening() {
        if (blockQuizInput()) return;
        if (!panel.isOpen()) open();
        clearTimeout(navTimer);
        holding = false;
        navigating = false;
        panel.voiceArea.focus();
        updateAway();
        if (sessionState === 'inactive') startVoice();
    }

    function updateAway() {
        if (disposed) return;
        // Held, then focus moved on (a click): the usual quiet wait starts again.
        if (holding && !onResumeButtons()) {
            noteNavigation();
            return;
        }
        // On the resume button listening stays paused until it is pressed (it hides once listening).
        const away = quizRestricted || !focusInPanel() || navigating || doc.activeElement === panel.resumeButton;
        if (conversation.isAway?.() === away) return;
        conversation.setAway?.(away);
        // The voice area says when keyboard use (or focus elsewhere) has paused listening.
        panel.setMicrophoneState(away && sessionState === ACTIVE ? 'paused' : micState);
        refreshStatus();
    }

    function focusDraft() {
        if (mode === 'voice') {
            if (inConversation() && doc.activeElement !== panel.voiceArea) panel.voiceArea.focus();
            return;
        }
        setTyping(true);
        if (inConversation() && doc.activeElement !== panel.textarea) panel.textarea.focus();
    }

    let switchedToVoice = false;
    function startVoice() {
        if (blockQuizInput()) return;
        startingVoice = true;
        conversation.start();
    }

    /**
     * Voice mode or text mode: the draft row, the microphone and where focus goes; said as "Voice mode, listening." or
     * "Text mode." A fallback (voice not set up) isn't remembered.
     */
    function applyMode(next, remember = true) {
        mode = next;
        panel.setMode(next);
        if (remember) {
            try {
                storage?.setItem(MODE_KEY, next);
            } catch (e) { /* used, not remembered */ }
        }
    }

    function setMode(next, { remember = true, say = true } = {}) {
        if (blockQuizInput()) return;
        applyMode(next, remember);
        if (next === 'voice') {
            if (panel.isOpen()) panel.voiceArea.focus();
            if (say) panelSay('Voice mode, listening.');
            switchedToVoice = say;
            if (sessionState === 'inactive') startVoice();
        } else {
            conversation.end();
            if (panel.isOpen()) {
                panel.textarea.focus();
                setTyping(true);
            }
            if (say) panelSay('Text mode.');
        }
        conversation.refreshWake?.();
    }

    /** Enter in the voice area: the whole message, read back; Ctrl+Enter sends it. */
    function readBack() {
        const text = panel.draft.value().trim().replace(/[.!?]+$/, '');
        panelSay(text ? `Your message: ${text}. Press Control Enter to send.` : 'Nothing to send yet. Say your message.');
    }

    function shownAnswers() {
        return panel.answers.hidden ? [] : [...panel.answers.querySelectorAll('[data-answer]')].map((b) => /** @type {HTMLElement} */ (b).dataset.answer);
    }

    function showSession(state) {
        if (quizRestricted && state !== 'inactive') return;
        if (state === 'inactive') sentMessages.length = 0;
        const wasActive = sessionState === ACTIVE;
        sessionState = state;
        if (state !== STARTING) panel.setVoiceAnnouncement('');
        // A session started from outside the panel ("Hey Neon"): the panel opens, or takes focus, and listens.
        if (state === STARTING && !focusInPanel()) bringFocusIn();
        if (state === ACTIVE) {
            startingVoice = false;
            // The first time, the assistant itself says "I'm listening"; a switch to voice mode already said so.
            if (listenedBefore && !switchedToVoice) panelSay('Listening');
            listenedBefore = true;
            switchedToVoice = false;
        } else if (state === 'inactive') {
            switchedToVoice = false;
            if (startingVoice && mode === 'voice') {
                // Voice isn't set up or the microphone is blocked (the controller said why): text mode for now.
                startingVoice = false;
                setMode('text', { remember: false, say: false });
            } else if (wasActive && mode === 'voice') {
                // The idle stop says its own line ("Listening stopped..."); its event follows the state at once.
                idleStop = false;
                queueMicrotask(() => {
                    if (!idleStop && !disposed && !quizRestricted) panelSay('Stopped listening');
                });
            }
        }
        refreshStatus();
    }

    function voiceStatus() {
        if (sessionState === STARTING || micState === 'starting') return 'Voice loading';
        if (sessionState === ACTIVE && conversation.isAway?.()) return 'Listening paused';
        if (sessionState === ACTIVE || micState === 'listening') return speechEngine === 'server' ? 'Listening' : `Listening, ${speechEngine}`;
        if (micState === 'wake') return `Listening for Hey ${name}`;
        return 'Microphone off';
    }

    /** One line: Working, then Waiting for your answer, then Speaking, then the voice state. */
    function refreshStatus() {
        if (disposed) return;
        if (quizRestricted) {
            panel.setStatus(quizMessage);
            panel.setSendAction('send');
            return;
        }
        const state = coordinator.state?.() || {};
        const task = state.task?.state;
        const text = busy || task === 'working' || task === 'applying' ? 'Working' :
            state.lock === 'read-only' ? 'Waiting for your answer' :
            output.state?.() === 'speaking' ? 'Speaking' : voiceStatus();
        panel.setStatus(text, options.offline ? 'Offline: practice replies' : '');
        panel.setSendAction(busy && !requestInterrupted ? 'pause' : 'send');
    }

    /**
     * @param {string} text
     * @param {string=} medium 'text' or 'voice'
     * @param {{segments?: !Array<!Object>}=} metadata Provisional pieces in a sent voice message.
     */
    async function handleUserInput(text, medium = 'text', metadata = {}) {
        if (blockQuizInput()) return;
        if (!String(text).trim()) return;
        const turn = panel.addTurn('user', text, { spoken: medium === 'voice' });
        const request = ++requestCount;
        const messageId = `${panel.element.id}-message-${request}`;
        if (metadata.segments?.some((piece) => piece.provisional)) {
            sentMessages.push({messageId, turn, segments: metadata.segments, original: text, text});
            if (sentMessages.length > SENT_MESSAGES) sentMessages.shift();
        }
        requestInterrupted = false;
        const taskId = `request-${request}`;
        // A newer message replaces this one; only the latest request may end the working state and its updates.
        const latest = () => request === requestCount;
        setBusy(true);
        stopWorkingUpdates();
        try {
            if (medium === 'voice') startWorkingUpdates(taskId);
            const reply = await coordinator.ask(text, {messageId});
            if (!latest()) return;
            if (latest()) stopWorkingUpdates();
            displayReply(reply, reply.taskId || taskId);
        } catch (err) {
            if (!latest()) return;
            if (latest()) stopWorkingUpdates();
            console.warn('[assistant]', err);
            displayReply({ say: FAILED, actions: [], expectsAnswer: false }, taskId, 'error');
        } finally {
            if (latest()) setBusy(false);
        }
    }

    function updateSentMessage(updates) {
        const sent = sentMessages.find((record) => updates.every((update) => record.segments.some((piece) =>
            piece.utterance === update.utterance && piece.provisional)));
        if (!sent) return;
        const revised = conversation.reviseSegments(sent.segments, updates);
        if (!revised) return;
        const comparable = (text) => text.toLowerCase().replace(/\p{P}/gu, '').replace(/\s+/g, ' ').trim();
        if (comparable(sent.text) === comparable(revised.text)) return;
        const before = sent.text;
        sent.text = revised.text; sent.segments = revised.segments;
        coordinator.reviseWords(sent.messageId, sent.text);
        panel.updateTurn(sent.turn, sent.text);
        onEvent('voice.retranscribed', {messageId: sent.messageId, before, after: sent.text, used: 'transcript'});
    }

    /** Undo a step is offered only when a step of the current plan was applied (the keys still work as before). */
    function answersFor(actions) {
        const applied = !!lastPlan?.steps.some((s) => s.status === 'applied');
        return actions.filter((a) => a.name !== 'undo' || applied);
    }

    function setBusy(on) {
        busy = on;
        panel.setBusy(on);
        refreshStatus();
    }

    /**
     * Shows a reply in the transcript and has it heard. Its commands become the answers group.
     * @param {{say: string, actions: !Array<{name: string, label: string}>, expectsAnswer: boolean, kind?: string,
     *     taskId?: ?string}} reply
     * @param {?string=} taskId
     * @param {?string=} kind for the output manager; the reply's own kind by default
     */
    function displayReply(reply, taskId = null, kind = null) {
        if (disposed || quizRestricted) return;
        api.onReply?.(reply);
        if (inConversation()) {
            // A reply never pulls focus back into the panel while the learner works elsewhere.
            if (reply.say && !conversation.isAway?.()) focusDraft();
        }
        // Repeat ("say that again", Alt+Shift+R) gives the latest reply again: heard again, with the open plan's steps,
        // but not written again.
        const repeated = !!reply.say && (reply.repeated || reply.say === panel.latestReply()?.querySelector('.assistant-text')?.textContent);
        if (reply.say && !repeated) panel.addTurn('assistant', reply.say);
        flushPlanLines();
        panel.setAnswers(answersFor(reply.actions || []));
        refreshStatus();
        if (!reply.say) return;
        const said = kind || reply.kind || 'answer';
        const view = steps.view();
        const text = repeated && view ? `${reply.say} ${view.steps.map((_, i) => stepText(view, i).replace(/([^.!?])$/, '$1.')).join(' ')}` : reply.say;
        onEvent('ai.said', { replyKind: said, text, taskId: reply.taskId || null, route: route() });
        output.say({ source: 'ai', kind: said, text, taskId: taskId || reply.taskId || null });
        // Once a page session, after the first plan's brief: where the steps are.
        if (introPending) {
            introPending = false;
            panelSay(STEPS_INTRO);
        }
    }

    /**
     * A command from a key or button: yes, all, stop, undo, repeat, go, and in Guided mode how and check.
     * @param {string} command
     * @param {string=} input 'key' or 'button'
     */
    async function runCommand(command, input = 'key') {
        if (blockQuizInput()) return;
        const revision = requestCount;
        if (command === 'cancel') conversation.cancelPending?.();
        onEvent('message.submitted', { input, text: command });
        try {
            const reply = await coordinator.act(command);
            if (revision === requestCount) displayReply(reply);
        } catch (err) {
            console.warn('[assistant]', err);
            if (revision === requestCount) displayReply({ say: FAILED, actions: [], expectsAnswer: false }, null, 'error');
        }
    }

    /** A line to say while a task works (e.g. the program changed and the assistant checks again). */
    function sayProgress(text, taskId) {
        if (quizRestricted) return;
        onEvent('ai.said', { replyKind: 'progress', text, taskId, route: route() });
        output.say({ source: 'ai', kind: 'progress', text, taskId });
    }

    // "I'm still working on it." every 10 seconds while a spoken request waits; the reply replaces a waiting one.
    function startWorkingUpdates(taskId) {
        stopWorkingUpdates();
        workingTimer = setInterval(() => {
            output.say({ source: 'ai', kind: 'progress', text: "I'm still working on it.", taskId });
        }, WORKING_UPDATE_MS);
    }

    function stopWorkingUpdates() {
        clearInterval(workingTimer);
        workingTimer = null;
    }

    function dispose() {
        if (disposed) return;
        clearTimeout(navTimer);
        stopWorkingUpdates();
        offState?.();
        offSpeak?.();
        offPolicy?.();
        doc.removeEventListener('keydown', onPanelKey, true);
        doc.removeEventListener('focusin', updateAway);
        doc.removeEventListener('focusout', onFocusOut);
        doc.removeEventListener('keydown', onKeyDown);
        conversation.dispose?.();
        disposed = true;
        panel.dispose();
    }

    return api;
}
