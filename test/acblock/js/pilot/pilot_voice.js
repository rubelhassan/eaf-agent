/**
 * Pilot Voice - Web Speech API integration
 * Handles speech recognition (STT) and speech synthesis (TTS)
 * Supports wake word detection for hands-free operation
 */

import { VoiceState } from './pilot_state.js';

/**
 * Default wake phrases that trigger command processing
 * Case and punctuation tolerant: "Neon", "Hi Neon", "Hey Neon", "Hello Neon"
 */
export const WAKE_PHRASES = [
    'neon',
    'hi neon',
    'hey neon',
    'hello neon'
];

/**
 * Conversation state for voice interaction
 */
export const ConversationState = {
    INACTIVE: 'INACTIVE',
    ACTIVE: 'ACTIVE'
};

/**
 * PilotVoice class - manages voice input and output
 */
export class PilotVoice {
    /**
     * @param {Object} options
     * @param {PilotState} options.state - State manager instance
     * @param {Object} [options.voiceOptions] - Voice configuration
     */
    constructor({ state, voiceOptions = {} }) {
        this.state = state;
        this.recognition = null;
        this.synthesis = window.speechSynthesis || null;

        // Recognition settings
        this.language = voiceOptions.language || 'en-US';
        this.continuous = voiceOptions.continuous ?? true; // Default to continuous for wake word
        this.interimResults = voiceOptions.interimResults ?? true;

        // Wake word settings
        this.useWakeWord = voiceOptions.useWakeWord ?? true;
        this.wakePhrases = voiceOptions.wakePhrases || WAKE_PHRASES;

        // Silence/end-of-utterance timeout settings (3s after user stops speaking)
        this.silenceTimeout = voiceOptions.silenceTimeout ?? 3000;
        this.silenceTimer = null;
        this.pendingCommand = null; // Accumulated command waiting to be processed

        // Conversation state and inactivity timeout (15s of no input)
        this.conversationState = ConversationState.INACTIVE;
        this.inactivityTimeout = voiceOptions.inactivityTimeout ?? 15000;
        this.inactivityTimer = null;

        // Audio context for earcons (created lazily to handle autoplay restrictions)
        this.audioContext = null;

        // Callbacks
        this.onResult = null;
        this.onError = null;
        this.onWakeWordDetected = null; // Called when wake word heard
        this.onPartialResult = null; // Called with interim results
        this.onSilenceTimeout = null; // Called when silence timeout triggers
        this.onDirectInput = null; // Called in follow-up mode (bypasses wake word)
        this.onConversationStateChange = null; // Called when ACTIVE/INACTIVE changes

        // Track current state
        this.isListening = false;
        this.isAwake = false; // True after wake word detected, waiting for command

        // Follow-up mode - when true, skips wake word requirement
        this.followUpMode = false;

        // help prompt tracking
        this.missedWakeWord = false;
    }

    /**
     * Enable follow-up mode (skip wake word for next input)
     * Used when AgentController has a pending follow-up question
     */
    enableFollowUpMode() {
        this.followUpMode = true;
        console.log('[PilotVoice] Follow-up mode enabled - wake word not required');
    }

    /**
     * Disable follow-up mode (require wake word again)
     */
    disableFollowUpMode() {
        this.followUpMode = false;
        console.log('[PilotVoice] Follow-up mode disabled - wake word required');
    }

    /**
     * Check if in follow-up mode
     * @returns {boolean}
     */
    isInFollowUpMode() {
        return this.followUpMode;
    }

    /**
     * Check if speech recognition is supported
     * @returns {boolean}
     */
    static isRecognitionSupported() {
        return 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
    }

    /**
     * Check if speech synthesis is supported
     * @returns {boolean}
     */
    static isSynthesisSupported() {
        return 'speechSynthesis' in window;
    }

    /**
     * Initialize the voice system
     */
    init() {
        if (PilotVoice.isRecognitionSupported()) {
            this.initRecognition();
        } else {
            console.warn('[PilotVoice] Speech recognition not supported');
        }

        if (PilotVoice.isSynthesisSupported()) {
            // Pre-load voices
            this.synthesis.getVoices();
            // Chrome loads voices async
            if (this.synthesis.onvoiceschanged !== undefined) {
                this.synthesis.onvoiceschanged = () => {
                    console.log('[PilotVoice] Voices loaded:', this.synthesis.getVoices().length);
                };
            }
        } else {
            console.warn('[PilotVoice] Speech synthesis not supported');
        }

        console.log('[PilotVoice] Initialized', {
            recognition: PilotVoice.isRecognitionSupported(),
            synthesis: PilotVoice.isSynthesisSupported()
        });
    }

    /**
     * Initialize speech recognition
     * @private
     */
    initRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        this.recognition = new SpeechRecognition();

        this.recognition.lang = this.language;
        this.recognition.continuous = this.continuous;
        this.recognition.interimResults = this.interimResults;

        // Handle results
        this.recognition.onresult = (event) => {
            let finalTranscript = '';
            let interimTranscript = '';

            for (let i = event.resultIndex; i < event.results.length; i++) {
                const transcript = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    finalTranscript += transcript;
                } else {
                    interimTranscript += transcript;
                }
            }

            // Handle interim results (for UI feedback)
            if (interimTranscript && this.onPartialResult) {
                this.onPartialResult(interimTranscript);
            }

            // Handle final transcript
            if (finalTranscript) {
                this.handleFinalTranscript(finalTranscript.trim());
            }
        };

        // Handle end
        this.recognition.onend = () => {
            const wasListening = this.isListening;
            this.isListening = false;
            this.isAwake = false;

            // Auto-restart if continuous mode and not manually stopped
            if (this.continuous && wasListening && this.state.voiceState === VoiceState.LISTENING) {
                console.log('[PilotVoice] Auto-restarting continuous recognition');
                setTimeout(() => this.startListening(), 100);
                return;
            }

            // Only reset to idle if not processing
            if (this.state.voiceState === VoiceState.LISTENING) {
                this.state.voiceState = VoiceState.IDLE;
            }
        };

        // Handle errors
        this.recognition.onerror = (event) => {
            console.error('[PilotVoice] Recognition error:', event.error);

            let userMessage = 'Voice input error';
            let shouldRestart = false;

            switch (event.error) {
                case 'no-speech':
                    // In continuous mode, this is normal - just restart
                    if (this.continuous) {
                        shouldRestart = true;
                        return;
                    }
                    userMessage = 'No speech detected. Please try again.';
                    break;
                case 'audio-capture':
                    userMessage = 'No microphone found. Please check your audio settings.';
                    break;
                case 'not-allowed':
                    userMessage = 'Microphone access denied. Please allow microphone permission.';
                    break;
                case 'network':
                    userMessage = 'Network error. Please check your connection.';
                    break;
                case 'aborted':
                    // User cancelled - not really an error
                    this.isListening = false;
                    this.isAwake = false;
                    this.state.voiceState = VoiceState.IDLE;
                    return;
                default:
                    userMessage = `Voice error: ${event.error}`;
            }

            this.isListening = false;
            this.isAwake = false;
            this.state.voiceState = VoiceState.ERROR;

            if (this.onError) {
                this.onError(userMessage);
            }

            // Reset to idle after brief delay
            setTimeout(() => {
                if (this.state.voiceState === VoiceState.ERROR) {
                    this.state.voiceState = VoiceState.IDLE;
                }
            }, 3000);
        };

        // Handle start
        this.recognition.onstart = () => {
            this.isListening = true;
            this.state.voiceState = VoiceState.LISTENING;
            console.log('[PilotVoice] Recognition started, listening for wake word...');
        };
    }

    /**
     * Handle final transcript - check for wake word and extract command
     * @param {string} transcript
     * @private
     */
    handleFinalTranscript(transcript) {
        const lower = transcript.toLowerCase();

        // Reset inactivity timer on any transcription event
        this.resetInactivityTimer();

        // In follow-up mode, skip wake word requirement entirely
        if (this.followUpMode) {
            console.log('[PilotVoice] Follow-up mode - processing direct input:', transcript);

            this.clearSilenceTimer();

            // Accumulate to pending command
            this.pendingCommand = this.pendingCommand
                ? this.pendingCommand + ' ' + transcript
                : transcript;

            // Start silence timer for batching
            this.startSilenceTimer();
            return;
        }

        // If conversation is ACTIVE, wake word is optional
        if (this.conversationState === ConversationState.ACTIVE) {
            console.log('[PilotVoice] Conversation ACTIVE - processing input:', transcript);

            this.clearSilenceTimer();
            this.missedWakeWord = false;

            // Check for wake word anyway (to handle explicit re-activation)
            const wakeResult = this.extractCommand(lower, transcript);
            const command = wakeResult ? wakeResult.command : transcript;

            // Accumulate to pending command
            if (command) {
                this.pendingCommand = this.pendingCommand
                    ? this.pendingCommand + ' ' + command
                    : command;
            }

            // Mark as awake for this utterance
            this.isAwake = true;

            // Start silence timer
            this.startSilenceTimer();
            return;
        }

        // Conversation is INACTIVE - require wake word
        if (this.useWakeWord) {
            // Check if transcript contains a wake phrase
            const wakeResult = this.extractCommand(lower, transcript);

            if (wakeResult) {
                console.log('[PilotVoice] Wake word detected, activating conversation. Command:', wakeResult.command);

                // Clear any existing timer
                this.clearSilenceTimer();

                this.missedWakeWord = false;

                // Activate conversation on successful wake word
                this.activateConversation();

                // Mark as awake
                if (!this.isAwake) {
                    this.isAwake = true;
                    if (this.onWakeWordDetected) {
                        this.onWakeWordDetected(wakeResult.wakePhrase);
                    }
                }

                // Accumulate command
                if (wakeResult.command) {
                    this.pendingCommand = this.pendingCommand
                        ? this.pendingCommand + ' ' + wakeResult.command
                        : wakeResult.command;
                }

                // Start silence timer - will process after silence
                this.startSilenceTimer();

            } else if (this.isAwake) {
                // Already awake - this is continuation of command (no wake word needed)
                console.log('[PilotVoice] Continuing command:', transcript);

                this.clearSilenceTimer();
                this.missedWakeWord = false;

                // Accumulate to pending command
                this.pendingCommand = this.pendingCommand
                    ? this.pendingCommand + ' ' + transcript
                    : transcript;

                // Restart silence timer
                this.startSilenceTimer();

            } else {
                // No wake word and not awake - ignore
                console.log('[PilotVoice] No wake word detected, will prompt after silence:', transcript);
                this.clearSilenceTimer();
                this.missedWakeWord = true;
                this.startSilenceTimer();
            }
        } else {
            // No wake word required - use silence timer for batching
            this.clearSilenceTimer();

            this.pendingCommand = this.pendingCommand
                ? this.pendingCommand + ' ' + transcript
                : transcript;

            this.startSilenceTimer();
        }
    }

    /**
     * Start the silence timer
     * @private
     */
    startSilenceTimer() {
        this.clearSilenceTimer();

        this.silenceTimer = setTimeout(() => {
            this.processPendingCommand();
        }, this.silenceTimeout);

        console.log(`[PilotVoice] Silence timer started (${this.silenceTimeout}ms)`);
    }

    /**
     * Clear the silence timer
     * @private
     */
    clearSilenceTimer() {
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
            this.silenceTimer = null;
        }
    }

    /**
     * Process the accumulated pending command
     * @private
     */
    processPendingCommand() {
        const command = this.pendingCommand?.trim();
        const wasInFollowUpMode = this.followUpMode;

        // Reset state
        this.pendingCommand = null;
        this.isAwake = false;
        this.clearSilenceTimer();

        // In follow-up mode, process differently
        if (wasInFollowUpMode) {
            console.log('[PilotVoice] Processing follow-up mode command:', command);

            // Disable follow-up mode after processing (will be re-enabled if needed)
            this.followUpMode = false;

            // Stop listening to prevent TTS from being captured as input
            this.stopListening();

            // Play processing cue before submitting
            this.playProcessingCue();

            if (this.onSilenceTimeout) {
                this.onSilenceTimeout();
            }

            // Use onDirectInput if available, otherwise fall back to onResult
            if (this.onDirectInput) {
                this.state.voiceState = VoiceState.PROCESSING;
                this.onDirectInput(command || '');
            } else if (this.onResult) {
                this.state.voiceState = VoiceState.PROCESSING;
                this.onResult(command || '');
            }

            return;
        }

        if (this.useWakeWord && this.missedWakeWord && !command) {
            this.missedWakeWord = false;
            const prompt = 'Say "Hey Neon" followed by your command.';

            if (this.onSilenceTimeout) {
                this.onSilenceTimeout();
            }

            // Show message in UI/screen reader too (optional but helpful)
            if (this.onError) {
                this.onError(prompt);
            }

            // Speak the prompt (audio feedback)
            // Optional: prevent the recognizer from picking up its own TTS
            const wasListening = this.isListening;
            if (this.recognition && wasListening) {
                // prevent auto-restart in onend
                this.state.voiceState = VoiceState.PROCESSING;
                try {
                    this.recognition.stop();
                } catch (e) {
                }
                this.isListening = false;
            }

            this.speak(prompt).finally(() => {
                if (this.recognition && wasListening) {
                    // Resume listening 3 seconds after speaking to avoid echo pickup
                    setTimeout(() => {
                        if (!this.isListening) {
                            this.startListening();
                        }
                    }, 3000);
                }
            });

            return;

        }

        console.log('[PilotVoice] Silence timeout - processing command:', command);

        // Stop listening to prevent TTS from being captured as input
        this.stopListening();

        // Play processing cue before submitting
        this.playProcessingCue();

        if (this.onSilenceTimeout) {
            this.onSilenceTimeout();
        }

        if (this.onResult) {
            this.state.voiceState = VoiceState.PROCESSING;
            this.onResult(command || '');
        }
    }

    /**
     * Extract command from transcript by removing wake phrase
     * @param {string} lowerTranscript - Lowercase transcript for matching
     * @param {string} originalTranscript - Original transcript to preserve case
     * @returns {Object|null} { wakePhrase, command } or null if no wake phrase found
     * @private
     */
    extractCommand(lowerTranscript, originalTranscript) {
        for (const phrase of this.wakePhrases) {
            const index = lowerTranscript.indexOf(phrase);
            if (index !== -1) {
                // Found wake phrase - extract command after it
                const afterPhrase = originalTranscript.substring(index + phrase.length).trim();

                // Remove common filler words at the start
                const command = afterPhrase
                    .replace(/^(please|can you|could you|would you|i want you to|i need you to)\s*/i, '')
                    .trim();

                return {
                    wakePhrase: phrase,
                    command: command
                };
            }
        }
        return null;
    }

    /**
     * Check if text contains a wake phrase
     * @param {string} text
     * @returns {boolean}
     */
    hasWakePhrase(text) {
        const lower = text.toLowerCase();
        return this.wakePhrases.some(phrase => lower.includes(phrase));
    }

    /**
     * Start listening for voice input
     */
    startListening() {
        if (!this.recognition) {
            console.error('[PilotVoice] Recognition not available');
            if (this.onError) {
                this.onError('Voice input not supported in this browser.');
            }
            return;
        }

        if (this.isListening) {
            return;
        }

        try {
            this.recognition.start();
        } catch (err) {
            // Already started or other error
            console.error('[PilotVoice] Error starting recognition:', err);
        }
    }

    /**
     * Stop listening for voice input
     */
    stopListening() {
        // Clear any pending command processing
        this.clearSilenceTimer();
        this.pendingCommand = null;
        this.isAwake = false;

        if (this.recognition && this.isListening) {
            try {
                this.recognition.stop();
            } catch (err) {
                console.error('[PilotVoice] Error stopping recognition:', err);
            }
        }
        this.isListening = false;
    }

    /**
     * Toggle listening state
     */
    toggleListening() {
        if (this.isListening) {
            this.stopListening();
        } else {
            this.startListening();
        }
    }

    /**
     * Speak text using speech synthesis
     * @param {string} text - Text to speak
     * @param {Object} [options]
     * @param {number} [options.rate=1] - Speech rate (0.1 to 10)
     * @param {number} [options.pitch=1] - Speech pitch (0 to 2)
     * @param {number} [options.volume=1] - Volume (0 to 1)
     * @returns {Promise<void>}
     */
    speak(text, options = {}) {
        return new Promise((resolve, reject) => {
            if (!this.synthesis) {
                console.warn('[PilotVoice] Speech synthesis not available');
                resolve();
                return;
            }

            const { rate = 1, pitch = 1, volume = 1 } = options;

            // Cancel any current speech
            this.synthesis.cancel();

            const utterance = new SpeechSynthesisUtterance(text);
            utterance.rate = rate;
            utterance.pitch = pitch;
            utterance.volume = volume;
            utterance.lang = this.language;

            // Try to get a natural voice
            const voices = this.synthesis.getVoices();
            const preferredVoice = voices.find(v =>
                v.lang.startsWith('en') && v.name.includes('Natural')
            ) || voices.find(v =>
                v.lang.startsWith('en') && !v.name.includes('Google')
            ) || voices.find(v =>
                v.lang.startsWith('en')
            );

            if (preferredVoice) {
                utterance.voice = preferredVoice;
            }

            utterance.onstart = () => {
                this.state.voiceState = VoiceState.SPEAKING;
            };

            utterance.onend = () => {
                this.state.voiceState = VoiceState.IDLE;
                // Reset inactivity timer after speaking so user gets full time to respond
                if (this.conversationState === ConversationState.ACTIVE) {
                    this.resetInactivityTimer();
                }
                resolve();
            };

            utterance.onerror = (e) => {
                console.error('[PilotVoice] Synthesis error:', e);
                this.state.voiceState = VoiceState.IDLE;
                // Resolve anyway to not break flow
                resolve();
            };

            this.synthesis.speak(utterance);
        });
    }

    /**
     * Stop any current speech
     */
    stopSpeaking() {
        if (this.synthesis) {
            this.synthesis.cancel();
            this.state.voiceState = VoiceState.IDLE;
        }
    }

    /**
     * Check if currently speaking
     * @returns {boolean}
     */
    isSpeaking() {
        return this.synthesis && this.synthesis.speaking;
    }

    /**
     * Configure voice options
     * @param {Object} options
     * @param {boolean} [options.useWakeWord] - Whether to require wake word
     * @param {boolean} [options.continuous] - Whether to listen continuously
     * @param {string[]} [options.wakePhrases] - Custom wake phrases
     * @param {number} [options.silenceTimeout] - Silence timeout in ms (default 3000)
     */
    configure(options = {}) {
        if (options.useWakeWord !== undefined) {
            this.useWakeWord = options.useWakeWord;
        }
        if (options.continuous !== undefined) {
            this.continuous = options.continuous;
            if (this.recognition) {
                this.recognition.continuous = options.continuous;
            }
        }
        if (options.wakePhrases) {
            this.wakePhrases = options.wakePhrases;
        }
        if (options.silenceTimeout !== undefined) {
            this.silenceTimeout = options.silenceTimeout;
        }

        console.log('[PilotVoice] Configured:', {
            useWakeWord: this.useWakeWord,
            continuous: this.continuous,
            silenceTimeout: this.silenceTimeout,
            wakePhrases: this.wakePhrases
        });
    }

    /**
     * Add a custom wake phrase
     * @param {string} phrase
     */
    addWakePhrase(phrase) {
        const lower = phrase.toLowerCase().trim();
        if (!this.wakePhrases.includes(lower)) {
            this.wakePhrases.push(lower);
        }
    }

    // ========= Conversation State Management =========

    /**
     * Activate conversation mode (wake word optional while active)
     * @param {boolean} [silent=false] - If true, skip activation beep
     */
    activateConversation(silent = false) {
        if (this.conversationState === ConversationState.ACTIVE) {
            // Already active, just reset inactivity timer
            this.resetInactivityTimer();
            return;
        }

        this.conversationState = ConversationState.ACTIVE;

        // Only play beep if not speaking (don't interrupt TTS)
        if (!silent && !this.isSpeaking()) {
            this.playActivationBeep();
        }

        this.resetInactivityTimer();

        console.log('[PilotVoice] Conversation ACTIVE');

        if (this.onConversationStateChange) {
            this.onConversationStateChange(ConversationState.ACTIVE);
        }
    }

    /**
     * Deactivate conversation mode (wake word required again)
     * @param {boolean} [silent=false] - If true, skip deactivation sound
     */
    deactivateConversation(silent = false) {
        if (this.conversationState === ConversationState.INACTIVE) {
            return;
        }

        this.conversationState = ConversationState.INACTIVE;
        this.clearInactivityTimer();

        // Only play sound if not speaking (don't interrupt TTS)
        if (!silent && !this.isSpeaking()) {
            this.playDeactivationSound();
        }

        console.log('[PilotVoice] Conversation INACTIVE');

        if (this.onConversationStateChange) {
            this.onConversationStateChange(ConversationState.INACTIVE);
        }
    }

    /**
     * Check if conversation is active
     * @returns {boolean}
     */
    isConversationActive() {
        return this.conversationState === ConversationState.ACTIVE;
    }

    /**
     * Reset the inactivity timer (call on any user input/transcription)
     */
    resetInactivityTimer() {
        this.clearInactivityTimer();

        if (this.conversationState === ConversationState.ACTIVE) {
            this.inactivityTimer = setTimeout(() => {
                // If currently speaking, defer deactivation until speech ends
                if (this.isSpeaking()) {
                    console.log('[PilotVoice] Inactivity timeout deferred - TTS in progress');
                    // Check again after a short interval
                    this.inactivityTimer = setTimeout(() => {
                        this.handleInactivityTimeout();
                    }, 1000);
                    return;
                }
                this.handleInactivityTimeout();
            }, this.inactivityTimeout);
        }
    }

    /**
     * Handle inactivity timeout with speaking check
     * @private
     */
    handleInactivityTimeout() {
        // Double-check we're not speaking before deactivating
        if (this.isSpeaking()) {
            console.log('[PilotVoice] Inactivity timeout deferred - TTS still in progress');
            // Schedule another check
            this.inactivityTimer = setTimeout(() => {
                this.handleInactivityTimeout();
            }, 1000);
            return;
        }

        console.log('[PilotVoice] Inactivity timeout - deactivating conversation');
        this.deactivateConversation();
    }

    /**
     * Clear the inactivity timer
     * @private
     */
    clearInactivityTimer() {
        if (this.inactivityTimer) {
            clearTimeout(this.inactivityTimer);
            this.inactivityTimer = null;
        }
    }

    // ========= Audio Cues =========

    /**
     * Get or create AudioContext (handles autoplay restrictions)
     * @returns {AudioContext|null}
     * @private
     */
    _getAudioContext() {
        try {
            if (!this.audioContext) {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                if (AudioContext) {
                    this.audioContext = new AudioContext();
                }
            }
            // Resume if suspended (autoplay restriction)
            if (this.audioContext?.state === 'suspended') {
                this.audioContext.resume().catch(() => {});
            }
            return this.audioContext;
        } catch (e) {
            return null;
        }
    }

    /**
     * Play activation beep (conversation becomes ACTIVE)
     */
    playActivationBeep() {
        const ctx = this._getAudioContext();
        if (!ctx) return;

        try {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();

            osc.type = 'sine';
            // Two-tone rising beep
            osc.frequency.setValueAtTime(660, ctx.currentTime);
            osc.frequency.setValueAtTime(880, ctx.currentTime + 0.08);
            gain.gain.setValueAtTime(0.04, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);

            osc.connect(gain);
            gain.connect(ctx.destination);

            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.15);
        } catch (e) {
            // ignore
        }
    }

    /**
     * Play deactivation sound (conversation becomes INACTIVE)
     */
    playDeactivationSound() {
        const ctx = this._getAudioContext();
        if (!ctx) return;

        try {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();

            osc.type = 'sine';
            // Falling tone
            osc.frequency.setValueAtTime(660, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.2);
            gain.gain.setValueAtTime(0.03, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);

            osc.connect(gain);
            gain.connect(ctx.destination);

            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.2);
        } catch (e) {
            // ignore
        }
    }

    /**
     * Play processing cue (utterance submitted for processing)
     * Skips if TTS is currently speaking to avoid interruption
     */
    playProcessingCue() {
        // Don't play audio cue while TTS is speaking
        if (this.isSpeaking()) {
            return;
        }

        const ctx = this._getAudioContext();
        if (!ctx) return;

        try {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();

            osc.type = 'sine';
            // Short blip
            osc.frequency.value = 1000;
            gain.gain.setValueAtTime(0.025, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);

            osc.connect(gain);
            gain.connect(ctx.destination);

            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.08);
        } catch (e) {
            // ignore
        }
    }

    /**
     * Legacy alias for activation beep
     * @private
     */
    playWakeEarcon() {
        this.playActivationBeep();
    }

    /**
     * Dispose of voice resources
     */
    dispose() {
        // Force stop continuous mode
        this.continuous = false;
        this.clearSilenceTimer();
        this.clearInactivityTimer();
        this.stopListening();
        this.stopSpeaking();

        if (this.recognition) {
            this.recognition.onresult = null;
            this.recognition.onerror = null;
            this.recognition.onend = null;
            this.recognition.onstart = null;
        }

        // Close audio context
        if (this.audioContext) {
            this.audioContext.close?.().catch(() => {});
            this.audioContext = null;
        }

        console.log('[PilotVoice] Disposed');
    }
}
