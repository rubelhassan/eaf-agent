/**
 * Pilot State Management
 * Simple observable state for the Blockly Neon assistant
 */

/**
 * Voice states
 * @enum {string}
 */
export const VoiceState = {
    IDLE: 'idle',
    LISTENING: 'listening',
    PROCESSING: 'processing',
    SPEAKING: 'speaking',
    ERROR: 'error'
};

/**
 * PilotState class - manages observable state for the pilot
 */
export class PilotState {
    constructor() {
        /** @type {boolean} */
        this._panelVisible = false;

        /** @type {VoiceState} */
        this._voiceState = VoiceState.IDLE;

        /** @type {boolean} */
        this._isProcessing = false;

        /** @type {Object|null} */
        this._lastResult = null;

        /** @type {Array<{role: string, content: string, timestamp: number, actions?: Array}>} */
        this._history = [];

        /** @type {Map<string, Set<Function>>} */
        this._listeners = new Map();
    }

    /**
     * Subscribe to state changes
     * @param {string} property - Property name to watch
     * @param {Function} callback - Callback function (newValue, oldValue)
     * @returns {Function} Unsubscribe function
     */
    subscribe(property, callback) {
        if (!this._listeners.has(property)) {
            this._listeners.set(property, new Set());
        }
        this._listeners.get(property).add(callback);

        return () => {
            this._listeners.get(property)?.delete(callback);
        };
    }

    /**
     * Notify listeners of a state change
     * @param {string} property - Property that changed
     * @param {*} newValue - New value
     * @param {*} oldValue - Previous value
     * @private
     */
    _notify(property, newValue, oldValue) {
        const callbacks = this._listeners.get(property);
        if (callbacks) {
            callbacks.forEach(cb => {
                try {
                    cb(newValue, oldValue);
                } catch (err) {
                    console.error(`[PilotState] Error in listener for ${property}:`, err);
                }
            });
        }
    }

    // --- Getters and Setters ---

    get panelVisible() {
        return this._panelVisible;
    }

    set panelVisible(value) {
        const oldValue = this._panelVisible;
        if (oldValue !== value) {
            this._panelVisible = value;
            this._notify('panelVisible', value, oldValue);
        }
    }

    get voiceState() {
        return this._voiceState;
    }

    set voiceState(value) {
        const oldValue = this._voiceState;
        if (oldValue !== value) {
            this._voiceState = value;
            this._notify('voiceState', value, oldValue);
        }
    }

    get isProcessing() {
        return this._isProcessing;
    }

    set isProcessing(value) {
        const oldValue = this._isProcessing;
        if (oldValue !== value) {
            this._isProcessing = value;
            this._notify('isProcessing', value, oldValue);
        }
    }

    get lastResult() {
        return this._lastResult;
    }

    set lastResult(value) {
        const oldValue = this._lastResult;
        this._lastResult = value;
        this._notify('lastResult', value, oldValue);
    }

    get history() {
        return this._history;
    }

    /**
     * Add a message to history
     * @param {string} role - 'user' or 'assistant'
     * @param {string} content - Message content
     * @param {Array} [actions] - Optional action buttons for assistant messages
     */
    addMessage(role, content, actions = null) {
        const message = {
            role,
            content,
            timestamp: Date.now(),
            ...(actions && { actions })
        };

        const oldHistory = [...this._history];
        this._history.push(message);
        this._notify('history', this._history, oldHistory);

        return message;
    }

    /**
     * Clear all history
     */
    clearHistory() {
        const oldHistory = [...this._history];
        this._history = [];
        this._notify('history', this._history, oldHistory);
    }

    /**
     * Get latest message
     * @returns {Object|null}
     */
    getLatestMessage() {
        return this._history.length > 0 ? this._history[this._history.length - 1] : null;
    }

    /**
     * Reset state to defaults
     */
    reset() {
        this.panelVisible = false;
        this.voiceState = VoiceState.IDLE;
        this.isProcessing = false;
        this.lastResult = null;
        // Keep history - it persists until page reload per requirements
    }
}
