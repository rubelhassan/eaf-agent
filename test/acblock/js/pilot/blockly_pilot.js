/**
 * Blockly Neon - Main Orchestrator
 * Coordinates the panel, chat, voice conversation and the assistant. Replies are spoken by the output manager
 * in the assistant's voice.
 */

import { PilotState, VoiceState } from './pilot_state.js';
import { PilotPanel } from './pilot_panel.js';
import { PilotChat, ActionType } from './pilot_chat.js';
import { PilotMiddleware, createContext } from './pilot_middleware.js';

/**
 * BlocklyPilot - Main orchestrator class
 */
export class BlocklyPilot {
    /**
     * @param {Object} options
     * @param {Blockly.WorkspaceSvg} options.workspace - The Blockly workspace
     * @param {Object} options.assistant - From createCoordinator (src/interaction/coordinator.js)
     * @param {Object} options.output - From createOutputManager (src/output/output_manager.js)
     * @param {?Object} options.recognizer - A Recognizer (src/voice/engines.js), or null without voice
     * @param {function(): !Array<string>} [options.hotwords] - Words the recognizer should favour
     * @param {Object} [options.voice] - More options for the conversation controller (vad, spotter, fallback,
     *     settings, isBusy, isWaiting, onEvent, mark)
     */
    constructor({ workspace, assistant, output, recognizer = null, hotwords = () => [], voice = {} }) {
        if (!workspace) {
            throw new Error('BlocklyPilot requires a workspace');
        }
        if (!assistant) {
            throw new Error('BlocklyPilot requires an assistant');
        }
        if (!output) {
            throw new Error('BlocklyPilot requires an output manager');
        }

        this.workspace = workspace;
        this.assistant = assistant;
        this.output = output;
        this.recognizer = recognizer;
        this.hotwords = hotwords;
        this.voiceOptions = voice;

        // Create modules
        this.state = new PilotState();
        this.panel = new PilotPanel({ state: this.state });
        this.chat = null; // Created after panel init
        this.conversation = null;

        // Middleware pipeline for business logic
        this.middleware = new PilotMiddleware();

        // Bound handlers
        this.boundKeyHandler = null;

        // Called after each reply is shown (the host resets the navigation lock's message)
        this.onReply = null;

        // "Still working" updates while a spoken request waits for its reply
        this.workingUpdateTimer = null;
        this.workingUpdateInterval = 10000; // 10 seconds
        this.requestCount = 0;
    }

    /**
     * Register a "before" middleware hook
     * @param {Function} hook - async (context) => context | void
     * @returns {Function} Unregister function
     */
    use(hook) {
        return this.middleware.before(hook);
    }

    /**
     * Register a custom error handler
     * @param {Function} handler - async (error, context) => { responseText, actions } | null
     */
    useErrorHandler(handler) {
        this.middleware.onError(handler);
    }

    /**
     * Initialize the pilot
     */
    init() {
        // Initialize panel first (creates DOM); its messages go through the output manager
        this.panel.init();
        this.panel.speak = (text) => this.output.say({ source: 'system', text });

        // Initialize chat with container from panel
        this.chat = new PilotChat({
            state: this.state,
            container: this.panel.getMessagesContainer()
        });
        this.chat.init();

        // The text box is the draft: spoken words are added to it, typing fixes them.
        this.conversation = createConversationController({
            ...this.voiceOptions,
            output: this.output,
            recognizer: this.recognizer,
            draft: {
                value: () => this.panel.inputTextarea.value,
                set: (text) => {
                    this.panel.setInputValue(text);
                    if (text) this.focusDraft();
                },
                setPartial: (text) => {
                    this.panel.setPartial(text);
                    if (text) this.focusDraft();
                },
            },
            submit: (text, medium) => this.handleUserInput(text, medium),
            hotwords: this.hotwords,
            onState: (state) => this.showVoiceState(state),
            onMicrophoneState: (state) => {
                const on = state !== 'off';
                this.panel.voiceButton.setAttribute('aria-pressed', String(on));
                this.panel.voiceButton.setAttribute('aria-label', on ? 'Turn microphone off' : 'Turn microphone on');
                this.panel.voiceButton.setAttribute('title', on ? 'Turn microphone off' : 'Turn microphone on');
                const status = {off: 'Microphone off', starting: 'Voice is loading', listening: 'Listening', wake: 'Listening for Hey Neon'};
                this.panel.setVoiceStatus(status[state]);
            },
        });

        // Typing in the draft keeps a voice session from going idle
        this.panel.inputTextarea.addEventListener('input', () => this.conversation.noteActivity());

        // Wire up panel callbacks
        this.panel.onSend = () => this.conversation.send();
        this.panel.onVoiceToggle = () => this.conversation.toggleMicrophone();
        this.panel.onClose = () => this.close();
        this.panel.onClear = () => this.chat.clear();
        this.panel.onToggle = () => this.toggle();

        // Wire up chat action callback
        this.chat.onAction = (action, messageIndex) => this.handleAction(action, messageIndex);

        // Bind global keyboard shortcuts
        this.bindKeyboardShortcuts();

        console.log('[BlocklyPilot] Initialized');
    }

    /**
     * Bind global keyboard shortcuts
     * @private
     */
    bindKeyboardShortcuts() {
        this.boundKeyHandler = (e) => {
            // Ctrl+Enter (Cmd+Enter on a Mac) sends the draft from anywhere
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && this.state.panelVisible) {
                e.preventDefault();
                this.conversation.send();
                return;
            }

            // Shift+P to toggle panel
            if (e.shiftKey && (e.key === 'p' || e.key === 'P')) {
                e.preventDefault();
                this.toggle();
                return;
            }

            // Escape in the text box empties a draft; otherwise it closes the panel (a working task is stopped
            // by the assistant keys first). In a voice conversation it goes back to the workspace, keeping the draft.
            if (e.key === 'Escape' && this.state.panelVisible) {
                e.preventDefault();
                if (e.target === this.panel.inputTextarea && this.inConversation()) {
                    this.focusWorkspace();
                    return;
                }
                if (e.target === this.panel.inputTextarea && this.panel.inputTextarea.value.trim()) {
                    this.conversation.discard();
                    return;
                }
                this.close();
                return;
            }

            // Ctrl+Shift+V starts or ends a voice conversation (opening the panel if needed)
            if (e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
                e.preventDefault();
                if (!this.state.panelVisible) {
                    this.open();
                }
                this.conversation.toggle();
                return;
            }
        };

        document.addEventListener('keydown', this.boundKeyHandler);
    }

    inConversation() {
        return this.conversation.state() === SessionState.ACTIVE;
    }

    /**
     * In a voice conversation the text box has focus while the learner talks and the assistant answers, so Enter
     * sends; the workspace gets it back when the exchange ends.
     * @private
     */
    focusDraft() {
        clearTimeout(this.returnTimer);
        this.offReturn?.();
        if (this.inConversation() && document.activeElement !== this.panel.inputTextarea) this.panel.focusInput();
    }

    /** @private */
    focusWorkspace() {
        this.workspace.getParentSvg()?.focus();
    }

    /**
     * After a reply that doesn't wait for an answer has been spoken, focus goes back to the same place in the
     * workspace (the cursor stays where it was), unless the learner has started a new message.
     * @private
     */
    returnAfterSpeech() {
        this.offReturn?.();
        let spoke = this.output.state() === 'speaking';
        const back = () => {
            this.offReturn?.();
            const box = this.panel.inputTextarea;
            if (this.inConversation() && document.activeElement === box && !box.value.trim()) this.focusWorkspace();
        };
        const off = this.output.onState((s) => {
            if (s === 'speaking') spoke = true;
            else if (spoke) back();
        });
        this.offReturn = () => {
            off();
            clearTimeout(this.returnTimer);
            this.offReturn = null;
        };
        // Nothing to speak (e.g. "go there" moved the cursor): back at once.
        this.returnTimer = setTimeout(() => !spoke && back(), 300);
    }

    /**
     * Ctrl+Shift+I: stop the assistant voice and listen (opening the panel if needed).
     */
    talk() {
        if (!this.state.panelVisible) this.open();
        this.conversation.talk();
    }

    /**
     * Open the pilot panel
     */
    open() {
        this.state.panelVisible = true;
    }

    /**
     * Close the pilot panel
     */
    close() {
        this.conversation.end();
        this.output.interrupt();
        this.state.panelVisible = false;
    }

    /**
     * Toggle the pilot panel
     */
    toggle() {
        if (this.state.panelVisible) {
            this.close();
        } else {
            this.open();
        }
    }

    /**
     * The voice button and status line follow the conversation's state.
     * @param {string} state - SessionState value
     * @private
     */
    showVoiceState(state) {
        if (state === SessionState.STARTING) {
            this.state.voiceState = VoiceState.PROCESSING;
            this.panel.setVoiceStatus('Voice is loading');
        } else if (state === SessionState.ACTIVE) {
            this.state.voiceState = VoiceState.LISTENING;
            this.panel.setVoiceStatus('Listening');
            // The first time the assistant itself says "I'm listening."
            if (this.listenedBefore) this.panel.announce('Listening');
            this.listenedBefore = true;
        } else {
            const wasListening = this.state.voiceState === VoiceState.LISTENING;
            this.state.voiceState = VoiceState.IDLE;
            this.panel.setVoiceStatus(wasListening ? 'Stopped listening' : '');
            if (wasListening) this.panel.announce('Stopped listening');
        }
    }

    /**
     * Handle user input (from text or voice)
     * @param {string} text
     * @param {string} medium - 'text' | 'voice'
     */
    async handleUserInput(text, medium = 'text') {
        if (!text.trim()) {
            return;
        }

        // Add user message to chat
        this.chat.addUserMessage(text);

        await this.processWithAgent(text, medium);
    }

    /**
     * Sends a request or an answer to the assistant and shows its reply.
     * @param {string} text
     * @param {string} medium - 'text' | 'voice'
     * @private
     */
    async processWithAgent(text, medium) {
        const taskId = `request-${++this.requestCount}`;
        this.state.isProcessing = true;
        this.chat.showThinking();
        let context = createContext({ input: text, mode: null, workspace: this.workspace });
        try {
            context = await this.middleware.runBefore(context);
            if (context.skipApi && context.customResponse) {
                this.displayReply({ say: context.customResponse.voiceLine || '', actions: [], expectsAnswer: false }, taskId);
                return;
            }
            if (medium === 'voice') this.startWorkingUpdates(taskId);
            const reply = await this.assistant.ask(text);
            this.stopWorkingUpdates();
            this.displayReply(reply, reply.taskId || taskId);
        } catch (err) {
            this.stopWorkingUpdates();
            const custom = await this.middleware.handleError(err, context);
            this.displayReply({ say: custom?.responseText || 'Sorry, something went wrong. Please try again.', actions: [], expectsAnswer: false }, taskId, 'error');
        } finally {
            this.state.isProcessing = false;
            this.chat.hideThinking();
        }
    }

    /**
     * Shows a reply in the chat and speaks it in the assistant's voice. Its commands become buttons.
     * @param {{say: string, actions: !Array<{name: string, label: string}>, expectsAnswer: boolean, kind?: string,
     *     taskId?: ?string}} reply
     * @param {string=} taskId
     * @param {string=} kind - for the output manager; the reply's own kind by default
     * @private
     */
    displayReply(reply, taskId = null, kind = null) {
        const actions = reply.actions.map((a) => ({ type: ActionType.COMMAND, name: a.name, label: a.label }));
        this.onReply?.(reply);
        if (this.inConversation()) {
            if (reply.say) this.focusDraft();
            if (!reply.expectsAnswer) this.returnAfterSpeech();
        }
        if (!reply.say) return;
        this.chat.addAssistantMessage(reply.say, actions);
        const said = kind || reply.kind || 'answer';
        this.voiceOptions.onEvent?.('ai.said', { replyKind: said, text: reply.say, taskId: reply.taskId || null });
        this.output.say({ source: 'ai', kind: said, text: reply.say, taskId: taskId || reply.taskId || null });
    }

    /**
     * A command from a key or button: yes, all, stop, undo, repeat, go.
     * @param {string} name
     * @param {string=} input - 'key' or 'button'
     */
    async runCommand(name, input = 'key') {
        this.voiceOptions.onEvent?.('message.submitted', { input, text: name });
        this.displayReply(await this.assistant.act(name));
    }

    /**
     * A line to say while a task works (e.g. the program changed and the assistant checks again).
     * @param {string} text
     * @param {string} taskId
     */
    sayProgress(text, taskId) {
        this.voiceOptions.onEvent?.('ai.said', { replyKind: 'progress', text, taskId });
        this.output.say({ source: 'ai', kind: 'progress', text, taskId });
    }

    /**
     * A reply's button: the same command as saying it.
     * @param {Object} action
     * @private
     */
    async handleAction(action) {
        if (action.type !== ActionType.COMMAND || this.state.isProcessing) return;
        await this.runCommand(action.name, 'button');
    }

    /**
     * Says "I'm still working on it." every 10 seconds until the reply comes; the reply replaces a waiting one.
     * @param {string} taskId
     * @private
     */
    startWorkingUpdates(taskId) {
        this.stopWorkingUpdates();
        this.workingUpdateTimer = setInterval(() => {
            this.output.say({ source: 'ai', kind: 'progress', text: "I'm still working on it.", taskId });
        }, this.workingUpdateInterval);
    }

    /**
     * @private
     */
    stopWorkingUpdates() {
        if (this.workingUpdateTimer) {
            clearInterval(this.workingUpdateTimer);
            this.workingUpdateTimer = null;
        }
    }

    /**
     * Dispose of the pilot
     */
    dispose() {
        if (this.boundKeyHandler) {
            document.removeEventListener('keydown', this.boundKeyHandler);
        }

        this.stopWorkingUpdates();
        this.offReturn?.();
        this.conversation.dispose();
        this.chat.dispose();
        this.panel.dispose();

        console.log('[BlocklyPilot] Disposed');
    }
}
