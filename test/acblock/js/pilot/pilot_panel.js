/**
 * Pilot Panel - DOM creation and management
 * Creates the accessible chat panel UI for Blockly Neon
 */

/**
 * PilotPanel class - manages DOM creation and panel visibility
 */
export class PilotPanel {
    /**
     * @param {Object} options
     * @param {PilotState} options.state - State manager instance
     */
    constructor({ state }) {
        this.state = state;
        this.panelElement = null;
        this.messagesContainer = null;
        this.inputTextarea = null;
        this.voiceButton = null;
        this.sendButton = null;
        this.voiceStatus = null;
        this.announcer = null;
        // Set by the pilot: speaks through the output manager (screen reader or built-in voice)
        this.speak = null;

        // Store references to containers we'll hide/show
        this.outputContainer = null;
        this.codeContainer = null;
        this.executionPanel = null;

        // Floating action button
        this.fabElement = null;

        // Callbacks
        this.onSend = null;
        this.onVoiceToggle = null;
        this.onClose = null;
        this.onClear = null;
        this.onToggle = null;
    }

    /**
     * Initialize the panel - create DOM and bind events
     */
    init() {
        this.findContainers();
        this.createFAB();
        this.createPanel();
        this.bindEvents();

        // Subscribe to state changes
        this.state.subscribe('panelVisible', (visible) => {
            this.updateVisibility(visible);
            this.updateFABVisibility(!visible);
        });

        this.state.subscribe('voiceState', (voiceState) => {
            this.updateVoiceUI(voiceState);
        });

        this.state.subscribe('isProcessing', (processing) => {
            this.updateProcessingUI(processing);
        });

        console.log('[PilotPanel] Initialized');
    }

    /**
     * Create the floating action button
     * @private
     */
    createFAB() {
        const fab = document.createElement('button');
        fab.id = 'pilotFAB';
        fab.className = 'pilot-fab pilot-fab--visible'; // Visible by default
        fab.setAttribute('type', 'button');
        fab.setAttribute('aria-label', 'Open Neon AI Assistant (Shift+P)');
        fab.setAttribute('title', 'Open Neon (Shift+P)');
        fab.innerHTML = '<i class="fa-solid fa-robot" aria-hidden="true"></i>';

        // Add to body
        document.body.appendChild(fab);
        this.fabElement = fab;

        // FAB click handler
        fab.addEventListener('click', () => {
            if (this.onToggle) {
                this.onToggle();
            }
        });
    }

    /**
     * Update FAB visibility
     * @param {boolean} visible
     * @private
     */
    updateFABVisibility(visible) {
        if (this.fabElement) {
            if (visible) {
                this.fabElement.classList.add('pilot-fab--visible');
            } else {
                this.fabElement.classList.remove('pilot-fab--visible');
            }
        }
    }

    /**
     * Find existing containers that we'll toggle visibility
     * @private
     */
    findContainers() {
        this.executionPanel = document.querySelector('.execution-panel');
        this.outputContainer = document.querySelector('.output-container');
        this.codeContainer = document.querySelector('.code-container');
    }

    /**
     * Create the panel DOM structure
     * @private
     */
    createPanel() {
        const panel = document.createElement('aside');
        panel.id = 'pilotPanel';
        panel.className = 'pilot-panel';
        panel.setAttribute('role', 'region');
        panel.setAttribute('aria-label', 'Neon AI Assistant');
        panel.setAttribute('aria-hidden', 'true');

        // Header
        const header = document.createElement('header');
        header.className = 'pilot-header';

        const title = document.createElement('h2');
        title.className = 'pilot-title';
        title.textContent = 'Blockly Neon';

        const headerButtons = document.createElement('div');
        headerButtons.className = 'pilot-header-buttons';

        const clearBtn = document.createElement('button');
        clearBtn.className = 'pilot-header-btn pilot-clear-btn';
        clearBtn.setAttribute('type', 'button');
        clearBtn.setAttribute('aria-label', 'Clear conversation');
        clearBtn.setAttribute('title', 'Clear conversation');
        clearBtn.innerHTML = '<i class="fas fa-trash-alt" aria-hidden="true"></i>';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'pilot-header-btn pilot-close-btn';
        closeBtn.setAttribute('type', 'button');
        closeBtn.setAttribute('aria-label', 'Close Neon');
        closeBtn.setAttribute('title', 'Close (Escape)');
        closeBtn.innerHTML = '<i class="fas fa-times" aria-hidden="true"></i>';

        headerButtons.appendChild(clearBtn);
        headerButtons.appendChild(closeBtn);
        header.appendChild(title);
        header.appendChild(headerButtons);

        // Messages area
        const messagesArea = document.createElement('div');
        messagesArea.id = 'pilotMessages';
        messagesArea.className = 'pilot-messages';
        messagesArea.setAttribute('role', 'log');
        // The assistant speaks its replies in its own voice, so screen readers don't read them again.
        messagesArea.setAttribute('aria-live', 'off');
        messagesArea.setAttribute('aria-label', 'Conversation history');

        // Welcome message
        const welcome = document.createElement('div');
        welcome.className = 'pilot-welcome';
        welcome.innerHTML = `
            <div class="pilot-welcome-icon">
                <i class="fa-solid fa-robot" aria-hidden="true"></i>
            </div>
            <h3>Hi! I'm Neon</h3>
            <p>I can help you understand, edit, and debug your blocks.</p>
            <p class="pilot-welcome-hint">Type a message, or press <strong>Control Shift V</strong> to talk. Enter sends.</p>
        `;
        messagesArea.appendChild(welcome);

        // Input area (footer)
        const inputArea = document.createElement('footer');
        inputArea.className = 'pilot-input-area';

        // Voice status
        const voiceStatus = document.createElement('div');
        voiceStatus.className = 'pilot-voice-status';
        // Shown only; "Listening" and "Stopped listening" are spoken through the output manager.

        // Input row
        const inputRow = document.createElement('div');
        inputRow.className = 'pilot-input-row';

        const voiceBtn = document.createElement('button');
        voiceBtn.className = 'pilot-voice-btn';
        voiceBtn.setAttribute('type', 'button');
        voiceBtn.setAttribute('aria-label', 'Start voice input');
        voiceBtn.setAttribute('aria-pressed', 'false');
        voiceBtn.setAttribute('title', 'Talk instead of typing (Ctrl+Shift+V)');
        voiceBtn.innerHTML = '<i class="fas fa-microphone" aria-hidden="true"></i>';

        const textarea = document.createElement('textarea');
        textarea.className = 'pilot-input';
        textarea.setAttribute('placeholder', 'Ask me anything about your blocks...');
        textarea.setAttribute('aria-label', 'Message input');
        textarea.setAttribute('rows', '1');

        const sendBtn = document.createElement('button');
        sendBtn.className = 'pilot-send-btn';
        sendBtn.setAttribute('type', 'button');
        sendBtn.setAttribute('aria-label', 'Send message');
        sendBtn.setAttribute('title', 'Send (Enter)');
        sendBtn.innerHTML = '<i class="fas fa-paper-plane" aria-hidden="true"></i>';

        inputRow.appendChild(voiceBtn);
        inputRow.appendChild(textarea);
        inputRow.appendChild(sendBtn);

        // Words still being recognized; screen readers skip it (the draft gets the finished words).
        const partial = document.createElement('div');
        partial.className = 'pilot-partial';
        partial.setAttribute('aria-hidden', 'true');

        inputArea.appendChild(voiceStatus);
        inputArea.appendChild(inputRow);
        inputArea.appendChild(partial);

        // Screen reader announcer
        const announcer = document.createElement('div');
        announcer.id = 'pilotAnnouncer';
        announcer.className = 'sr-only';
        announcer.setAttribute('aria-live', 'assertive');
        announcer.setAttribute('aria-atomic', 'true');

        // Assemble panel
        panel.appendChild(header);
        panel.appendChild(messagesArea);
        panel.appendChild(inputArea);
        panel.appendChild(announcer);

        // Store references
        this.panelElement = panel;
        this.messagesContainer = messagesArea;
        this.inputTextarea = textarea;
        this.voiceButton = voiceBtn;
        this.sendButton = sendBtn;
        this.voiceStatus = voiceStatus;
        this.partialLine = partial;
        this.announcer = announcer;
        this.clearButton = clearBtn;
        this.closeButton = closeBtn;

        // Insert into execution panel (before output-container)
        if (this.executionPanel) {
            this.executionPanel.insertBefore(panel, this.outputContainer);
        }
    }

    /**
     * Bind DOM events
     * @private
     */
    bindEvents() {
        // Send button click
        this.sendButton.addEventListener('click', () => {
            this.handleSend();
        });

        // Voice button click
        this.voiceButton.addEventListener('click', () => {
            if (this.onVoiceToggle) {
                this.onVoiceToggle();
            }
        });

        // Close button click
        this.closeButton.addEventListener('click', () => {
            if (this.onClose) {
                this.onClose();
            }
        });

        // Clear button click
        this.clearButton.addEventListener('click', () => {
            if (this.onClear) {
                this.onClear();
            }
        });

        // Textarea keyboard handling
        this.inputTextarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.handleSend();
            }
        });

        // Auto-resize textarea
        this.inputTextarea.addEventListener('input', () => {
            this.autoResizeTextarea();
        });
    }

    /**
     * Handle send action
     * @private
     */
    handleSend() {
        if (this.onSend) this.onSend();
    }

    /**
     * Auto-resize textarea to fit content
     * @private
     */
    autoResizeTextarea() {
        const textarea = this.inputTextarea;
        textarea.style.height = 'auto';
        const maxHeight = 120; // ~5 lines
        textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + 'px';
    }

    /**
     * Update panel visibility
     * @param {boolean} visible
     * @private
     */
    updateVisibility(visible) {
        if (visible) {
            // Show panel, hide output/code
            this.panelElement.classList.add('pilot-panel--open');
            this.panelElement.setAttribute('aria-hidden', 'false');

            if (this.outputContainer) {
                this.outputContainer.style.display = 'none';
            }
            if (this.codeContainer) {
                this.codeContainer.style.display = 'none';
            }

            // Focus input after animation
            setTimeout(() => {
                this.inputTextarea.focus();
            }, 350);

            this.announce('Neon opened. Type a message, or press Control Shift V to talk.');
        } else {
            // Hide panel, show output/code
            this.panelElement.classList.remove('pilot-panel--open');
            this.panelElement.setAttribute('aria-hidden', 'true');

            if (this.outputContainer) {
                this.outputContainer.style.display = '';
            }
            if (this.codeContainer) {
                this.codeContainer.style.display = '';
            }

            // Return focus to workspace
            const workspace = document.getElementById('blocklyApp');
            if (workspace) {
                workspace.focus();
            }

            this.announce('Neon closed.');
        }
    }

    /**
     * Update voice button UI based on state
     * @param {string} voiceState
     * @private
     */
    updateVoiceUI(voiceState) {
        const btn = this.voiceButton;
        const icon = btn.querySelector('i');

        // Remove all state classes
        btn.classList.remove('pilot-voice-btn--listening', 'pilot-voice-btn--processing', 'pilot-voice-btn--error');

        switch (voiceState) {
            case 'listening':
                btn.classList.add('pilot-voice-btn--listening');
                btn.setAttribute('aria-pressed', 'true');
                btn.setAttribute('aria-label', 'Stop voice input');
                icon.className = 'fas fa-microphone-slash';
                this.setVoiceStatus('Listening...');
                break;

            case 'processing':
                btn.classList.add('pilot-voice-btn--processing');
                btn.setAttribute('aria-pressed', 'false');
                btn.setAttribute('aria-label', 'Processing voice input');
                icon.className = 'fas fa-spinner fa-spin';
                this.setVoiceStatus('Processing...');
                break;

            case 'speaking':
                btn.setAttribute('aria-pressed', 'false');
                btn.setAttribute('aria-label', 'Assistant is speaking');
                icon.className = 'fas fa-volume-up';
                this.setVoiceStatus('Speaking...');
                break;

            case 'error':
                btn.classList.add('pilot-voice-btn--error');
                btn.setAttribute('aria-pressed', 'false');
                btn.setAttribute('aria-label', 'Voice input error, click to retry');
                icon.className = 'fas fa-exclamation-triangle';
                break;

            default: // idle
                btn.setAttribute('aria-pressed', 'false');
                btn.setAttribute('aria-label', 'Start voice input');
                icon.className = 'fas fa-microphone';
                this.setVoiceStatus('');
                break;
        }
    }

    /**
     * Update UI for processing state
     * @param {boolean} processing
     * @private
     */
    updateProcessingUI(processing) {
        // The text box stays usable: a new message while the assistant works replaces that task, and a disabled
        // box would lose focus.
        this.sendButton.setAttribute('aria-busy', String(processing));

        if (processing) {
            this.sendButton.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i>';
        } else {
            this.sendButton.innerHTML = '<i class="fas fa-paper-plane" aria-hidden="true"></i>';
        }
    }

    /**
     * Set voice status text
     * @param {string} text
     */
    setVoiceStatus(text) {
        if (this.voiceStatus) {
            this.voiceStatus.textContent = text;
        }
    }

    /**
     * Announce text: through the output manager when the pilot set one, else the panel's live region
     * @param {string} text
     */
    announce(text) {
        if (this.speak) {
            this.speak(text);
            return;
        }
        if (this.announcer) {
            this.announcer.textContent = '';
            requestAnimationFrame(() => {
                setTimeout(() => {
                    this.announcer.textContent = text;
                }, 100);
            });
        }
    }

    /**
     * Get the messages container element
     * @returns {HTMLElement}
     */
    getMessagesContainer() {
        return this.messagesContainer;
    }

    /**
     * Set input value programmatically (e.g., from voice)
     * @param {string} text
     */
    setInputValue(text) {
        this.inputTextarea.value = text;
        this.autoResizeTextarea();
    }

    /**
     * Show the words still being recognized under the text box
     * @param {string} text
     */
    setPartial(text) {
        this.partialLine.textContent = text;
    }

    /**
     * Focus the input
     */
    focusInput() {
        this.inputTextarea.focus();
    }

    /**
     * Show/hide the welcome message
     * @param {boolean} show
     */
    toggleWelcome(show) {
        const welcome = this.messagesContainer.querySelector('.pilot-welcome');
        if (welcome) {
            welcome.style.display = show ? '' : 'none';
        }
    }

    /**
     * Dispose of the panel
     */
    dispose() {
        if (this.panelElement && this.panelElement.parentNode) {
            this.panelElement.parentNode.removeChild(this.panelElement);
        }
        if (this.fabElement && this.fabElement.parentNode) {
            this.fabElement.parentNode.removeChild(this.fabElement);
        }
        console.log('[PilotPanel] Disposed');
    }
}
