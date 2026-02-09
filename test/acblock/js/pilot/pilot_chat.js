/**
 * Pilot Chat - Message rendering and actions
 * Handles rendering messages, thinking animation, and action buttons
 */

/**
 * Action types for assistant messages
 * @enum {string}
 */
export const ActionType = {
    APPLY_FIX: 'apply_fix',
    APPLY_SUGGESTION: 'apply_suggestion',
    HEAR_AGAIN: 'hear_again'
};

/**
 * PilotChat class - manages message rendering
 */
export class PilotChat {
    /**
     * @param {Object} options
     * @param {PilotState} options.state - State manager instance
     * @param {HTMLElement} options.container - Messages container element
     */
    constructor({ state, container }) {
        this.state = state;
        this.container = container;
        this.thinkingElement = null;

        // Callbacks for action buttons
        this.onAction = null;
    }

    /**
     * Initialize the chat system
     */
    init() {
        // Subscribe to history changes
        this.state.subscribe('history', () => {
            this.renderHistory();
        });

        console.log('[PilotChat] Initialized');
    }

    /**
     * Render the full history
     * @private
     */
    renderHistory() {
        // Clear existing messages (except welcome)
        const welcome = this.container.querySelector('.pilot-welcome');
        this.container.innerHTML = '';

        if (welcome && this.state.history.length === 0) {
            this.container.appendChild(welcome);
        }

        // Render each message
        this.state.history.forEach((message, index) => {
            const messageEl = this.createMessageElement(message, index);
            this.container.appendChild(messageEl);
        });

        // Auto-scroll to bottom
        this.scrollToBottom();
    }

    /**
     * Create a message element
     * @param {Object} message
     * @param {number} index
     * @returns {HTMLElement}
     * @private
     */
    createMessageElement(message, index) {
        const wrapper = document.createElement('div');
        wrapper.className = `pilot-message pilot-message--${message.role}`;
        wrapper.setAttribute('data-index', index);

        // Avatar
        const avatar = document.createElement('div');
        avatar.className = 'pilot-message-avatar';
        avatar.setAttribute('aria-hidden', 'true');

        if (message.role === 'user') {
            avatar.innerHTML = '<i class="fas fa-user"></i>';
        } else {
            avatar.innerHTML = '<i class="fa-solid fa-robot"></i>';
        }

        // Content
        const content = document.createElement('div');
        content.className = 'pilot-message-content';

        // Message text
        const text = document.createElement('div');
        text.className = 'pilot-message-text';
        text.textContent = message.content;

        content.appendChild(text);

        // Action buttons for assistant messages
        if (message.role === 'assistant' && message.actions && message.actions.length > 0) {
            const actionsContainer = this.createActionsElement(message.actions, index);
            content.appendChild(actionsContainer);
        }

        // Timestamp (screen reader only)
        const time = document.createElement('time');
        time.className = 'pilot-message-time sr-only';
        time.dateTime = new Date(message.timestamp).toISOString();
        time.textContent = new Date(message.timestamp).toLocaleTimeString();
        content.appendChild(time);

        wrapper.appendChild(avatar);
        wrapper.appendChild(content);

        return wrapper;
    }

    /**
     * Create action buttons container
     * @param {Array} actions
     * @param {number} messageIndex
     * @returns {HTMLElement}
     * @private
     */
    createActionsElement(actions, messageIndex) {
        const container = document.createElement('div');
        container.className = 'pilot-message-actions';

        actions.forEach((action) => {
            const btn = document.createElement('button');
            btn.className = `pilot-action-btn pilot-action-btn--${action.type}`;
            btn.setAttribute('type', 'button');
            btn.setAttribute('data-action', action.type);
            btn.setAttribute('data-message-index', messageIndex);

            // Icon and label based on type
            let icon = '';
            let label = action.label || '';

            switch (action.type) {
                case ActionType.APPLY_FIX:
                    icon = '<i class="fas fa-wrench" aria-hidden="true"></i>';
                    label = label || 'Apply fix';
                    break;
                case ActionType.APPLY_SUGGESTION:
                    icon = '<i class="fas fa-lightbulb" aria-hidden="true"></i>';
                    label = label || 'Apply suggestion';
                    break;
                case ActionType.HEAR_AGAIN:
                    icon = '<i class="fas fa-volume-up" aria-hidden="true"></i>';
                    label = label || 'Hear again';
                    break;
                default:
                    icon = '<i class="fas fa-play" aria-hidden="true"></i>';
            }

            btn.innerHTML = `${icon} <span>${label}</span>`;
            btn.setAttribute('aria-label', label);

            btn.addEventListener('click', () => {
                if (this.onAction) {
                    this.onAction(action, messageIndex);
                }
            });

            container.appendChild(btn);
        });

        return container;
    }

    /**
     * Add a user message
     * @param {string} text
     */
    addUserMessage(text) {
        this.state.addMessage('user', text);
    }

    /**
     * Add an assistant message
     * @param {string} text
     * @param {Array} [actions] - Optional action buttons
     */
    addAssistantMessage(text, actions = null) {
        this.state.addMessage('assistant', text, actions);
    }

    /**
     * Show thinking animation
     */
    showThinking() {
        if (this.thinkingElement) {
            return;
        }

        const wrapper = document.createElement('div');
        wrapper.className = 'pilot-message pilot-message--assistant pilot-message--thinking';

        const avatar = document.createElement('div');
        avatar.className = 'pilot-message-avatar';
        avatar.setAttribute('aria-hidden', 'true');
        avatar.innerHTML = '<i class="fa-solid fa-robot"></i>';

        const content = document.createElement('div');
        content.className = 'pilot-message-content';

        const dots = document.createElement('div');
        dots.className = 'pilot-thinking-dots';
        dots.setAttribute('role', 'status');
        dots.setAttribute('aria-label', 'Thinking');
        dots.innerHTML = `
            <span class="pilot-thinking-dot"></span>
            <span class="pilot-thinking-dot"></span>
            <span class="pilot-thinking-dot"></span>
        `;

        content.appendChild(dots);
        wrapper.appendChild(avatar);
        wrapper.appendChild(content);

        this.container.appendChild(wrapper);
        this.thinkingElement = wrapper;

        this.scrollToBottom();
    }

    /**
     * Hide thinking animation
     */
    hideThinking() {
        if (this.thinkingElement) {
            this.thinkingElement.remove();
            this.thinkingElement = null;
        }
    }

    /**
     * Clear all messages
     */
    clear() {
        this.state.clearHistory();

        // Re-add welcome message
        const welcome = document.createElement('div');
        welcome.className = 'pilot-welcome';
        welcome.innerHTML = `
            <div class="pilot-welcome-icon">
                <i class="fa-solid fa-robot" aria-hidden="true"></i>
            </div>
            <h3>Hi! I'm Neon</h3>
            <p>I can help you understand, edit, and debug your blocks.</p>
            <p class="pilot-welcome-hint">Type a message or use voice: say <strong>"Hey Neon"</strong> followed by your command</p>
        `;
        this.container.appendChild(welcome);
    }

    /**
     * Scroll to the bottom of the messages container
     */
    scrollToBottom() {
        requestAnimationFrame(() => {
            this.container.scrollTop = this.container.scrollHeight;
        });
    }

    /**
     * Get message by index
     * @param {number} index
     * @returns {Object|null}
     */
    getMessage(index) {
        return this.state.history[index] || null;
    }

    /**
     * Dispose
     */
    dispose() {
        this.hideThinking();
        console.log('[PilotChat] Disposed');
    }
}
