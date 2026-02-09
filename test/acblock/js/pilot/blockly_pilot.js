/**
 * Blockly Neon - Main Orchestrator
 * Coordinates panel, voice, chat, and state to provide an accessible AI assistant
 */

import { PilotState, VoiceState } from './pilot_state.js';
import { PilotPanel } from './pilot_panel.js';
import { PilotVoice, ConversationState } from './pilot_voice.js';
import { PilotChat, ActionType } from './pilot_chat.js';
import { PilotMiddleware, createContext, createResult, dummyCommandMiddleware } from './pilot_middleware.js';

/**
 * BlocklyPilot - Main orchestrator class
 */
export class BlocklyPilot {
    /**
     * @param {Object} options
     * @param {Blockly.WorkspaceSvg} options.workspace - The Blockly workspace
     * @param {AgentController} options.agentController - Agent controller instance
     */
    constructor({ workspace, agentController }) {
        if (!workspace) {
            throw new Error('BlocklyPilot requires a workspace');
        }
        if (!agentController) {
            throw new Error('BlocklyPilot requires an agentController');
        }

        this.workspace = workspace;
        this.agentController = agentController;

        // Create modules
        this.state = new PilotState();
        this.panel = new PilotPanel({ state: this.state });
        this.voice = new PilotVoice({ state: this.state });
        this.chat = null; // Created after panel init

        // Middleware pipeline for business logic
        this.middleware = new PilotMiddleware();

        // Bound handlers
        this.boundKeyHandler = null;

        // track input medium
        this.inputMedium = 'text'; // 'text' | 'voice'

        // "Neon is working" update timer during long API waits
        this.workingUpdateTimer = null;
        this.workingUpdateInterval = 10000; // 10 seconds
        this.isWorkingUpdateActive = false;

        // Track if voice greeting has been given this session
        this.hasGivenVoiceGreeting = false;
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
     * Register an "after" middleware hook
     * @param {Function} hook - async (context, result) => result | void
     * @returns {Function} Unregister function
     */
    useAfter(hook) {
        return this.middleware.after(hook);
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
        // Initialize panel first (creates DOM)
        this.panel.init();

        // Initialize chat with container from panel
        this.chat = new PilotChat({
            state: this.state,
            container: this.panel.getMessagesContainer()
        });
        this.chat.init();

        // Initialize voice
        this.voice.init();

        // Wire up panel callbacks
        this.panel.onSend = (text) => this.handleUserInput(text, 'text');
        this.panel.onVoiceToggle = () => this.handleVoiceToggle();
        this.panel.onClose = () => this.close();
        this.panel.onClear = () => this.chat.clear();
        this.panel.onToggle = () => this.toggle();

        // Wire up voice callbacks
        this.voice.onResult = (transcript) => this.handleVoiceResult(transcript);
        this.voice.onError = (message) => this.handleVoiceError(message);
        this.voice.onWakeWordDetected = (phrase) => this.handleWakeWordDetected(phrase);
        this.voice.onPartialResult = (partial) => this.handlePartialVoiceResult(partial);
        this.voice.onSilenceTimeout = () => this.handleSilenceTimeout();
        this.voice.onDirectInput = (transcript) => this.handleDirectVoiceInput(transcript);
        this.voice.onConversationStateChange = (state) => this.handleConversationStateChange(state);

        // Wire up chat action callback
        this.chat.onAction = (action, messageIndex) => this.handleAction(action, messageIndex);

        // Bind global keyboard shortcuts
        this.bindKeyboardShortcuts();

        // TODO: rubel middleware
        // this.middleware.before(dummyCommandMiddleware().before);

        console.log('[BlocklyPilot] Initialized');
    }

    /**
     * Bind global keyboard shortcuts
     * @private
     */
    bindKeyboardShortcuts() {
        this.boundKeyHandler = (e) => {
            // Shift+P to toggle panel
            if (e.shiftKey && (e.key === 'p' || e.key === 'P')) {
                e.preventDefault();
                this.toggle();
                return;
            }

            // Escape to close
            if (e.key === 'Escape' && this.state.panelVisible) {
                e.preventDefault();
                this.close();
                return;
            }

            // Ctrl+Shift+V to open panel (if closed) and toggle voice
            if (e.ctrlKey && e.shiftKey && e.key === 'V') {
                e.preventDefault();
                // Open panel if not visible
                if (!this.state.panelVisible) {
                    this.open();
                }
                // Activate voice after panel opens
                setTimeout(() => this.activateVoiceWithGreeting(), 100);
                return;
            }
        };

        document.addEventListener('keydown', this.boundKeyHandler);
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
        // Stop any voice activity
        this.voice.stopListening();
        this.voice.stopSpeaking();

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
     * Handle user input (from text or voice)
     * @param {string} text
     * @param {string} medium - 'text' | 'voice'
     */
    async handleUserInput(text, medium = 'text') {
        if (!text.trim()) {
            return;
        }

        this.inputMedium = medium;

        // Add user message to chat
        this.chat.addUserMessage(text);

        // Process with agent controller (two-step flow)
        await this.processWithAgent(text);
    }

    /**
     * Check if there's a pending follow-up question
     * @returns {boolean}
     */
    hasPendingFollowUp() {
        return this.agentController?.hasPendingFollowUp() || false;
    }

    /**
     * Process user input with the agent controller (two-step flow)
     * @param {string} text
     * @private
     */
    async processWithAgent(text) {
        this.state.isProcessing = true;
        this.chat.showThinking();

        // Create middleware context (mode will be set by AgentController)
        let context = createContext({
            input: text,
            mode: null, // Will be determined by AgentController
            workspace: this.workspace
        });

        try {
            // Run "before" middleware hooks
            context = await this.middleware.runBefore(context);

            let result;

            // Check if middleware wants to skip API
            if (context.skipApi && context.customResponse) {
                console.log("[BlocklyPilot] Middleware provided custom response");
                result = {
                    phase: Phase.COMPLETE,
                    wait: false,
                    intent: context.mode,
                    mode: context.mode,
                    llmResponse: context.customResponse,
                    actor: null,
                    voiceLine: context.customResponse.voiceLine || null
                };
            } else {
                console.log("[BlocklyPilot] Calling AgentController");

                // Start "Neon is working" updates for voice users
                if (this.inputMedium === 'voice') {
                    this.startWorkingUpdates();
                }

                // Use AgentController's two-step flow (pass inputMedium for follow-up handling)
                result = await this.agentController.process({
                    userInput: text,
                    workspace: this.workspace,
                    inputMedium: this.inputMedium,
                    onIntermediateResponse: (intermediate) => {
                        this.handleIntermediateResponse(intermediate);
                    }
                });

                // Stop working updates before speaking final response
                this.stopWorkingUpdates();

                console.log("Rubel: we have got result in pilot", { phase: result.phase, intent: result.intent, mode: result.mode, hasFollowUp: result.hasFollowUp });
            }

            // Handle CLARIFICATION intent differently
            if (result.phase === Phase.CLARIFICATION) {
                this.handleClarificationResponse(result);
                return;
            }

            // Handle FOLLOW_UP_ANSWER phase
            if (result.phase === Phase.FOLLOW_UP_ANSWER) {
                this.handleFollowUpAnswerResponse(result);
                return;
            }

            // Handle ERROR phase
            if (result.phase === Phase.ERROR) {
                throw new Error(result.message);
            }

            // Store result for action buttons
            this.state.lastResult = result;

            // Build initial response
            const responseText = this.buildResponseText(result);
            const actions = this.buildActions(result);

            // Create result object for "after" middleware
            let middlewareResult = createResult({
                result,
                responseText,
                actions,
                speak: false
            });

            // Run "after" middleware hooks
            middlewareResult = await this.middleware.runAfter(context, middlewareResult);

            // Display final response (with follow-up question if present)
            this.displayResponse(middlewareResult);

        } catch (err) {
            console.error('[BlocklyPilot] Agent error:', err);

            // Stop working updates on error
            this.stopWorkingUpdates();

            // Try custom error handler first
            const customError = await this.middleware.handleError(err, context);

            if (customError) {
                this.chat.addAssistantMessage(customError.responseText, customError.actions || []);
                this.panel.announce(customError.responseText);

                if (this.inputMedium === 'voice') {
                    const wasListening = !!this.voice?.isListening;
                    if (wasListening) this.voice.stopListening();
                    this.voice.speak('Error processing request').finally(() => {
                        // Wait 2.5s after speaking before resuming listening
                        if (wasListening) {
                            setTimeout(() => {
                                if (this.voice.isConversationActive() && !this.voice.isListening) {
                                    this.voice.startListening();
                                }
                            }, 3000);
                        }
                    });
                }

            } else {
                // Default error handling
                const errorMessage = err.name === 'AbortError'
                    ? 'Request was cancelled.'
                    : `I encountered an error: ${err.message || 'Unknown error'}`;

                this.chat.addAssistantMessage(errorMessage);
                this.panel.announce('Error processing request');

                if (this.inputMedium === 'voice') {
                    const wasListening = !!this.voice?.isListening;
                    if (wasListening) this.voice.stopListening();
                    this.voice.speak(errorMessage).finally(() => {
                        // Wait 2.5s after speaking before resuming listening
                        if (wasListening) {
                            setTimeout(() => {
                                if (this.voice.isConversationActive() && !this.voice.isListening) {
                                    this.voice.startListening();
                                }
                            }, 3000);
                        }
                    });
                }
            }

        } finally {
            this.state.isProcessing = false;
            this.chat.hideThinking();
        }
    }

    /**
     * Handle follow-up answer response from AgentController
     * @param {Object} result
     * @private
     */
    handleFollowUpAnswerResponse(result) {
        console.log('[BlocklyPilot] Follow-up answer response:', result);

        // Hide thinking indicator
        this.chat.hideThinking();
        this.state.isProcessing = false;

        // Show response message
        this.chat.addAssistantMessage(result.message, []);
        this.panel.announce(result.message);

        // If re-asking the follow-up (unclear answer), keep follow-up mode active for voice
        if (result.reAskFollowUp && this.inputMedium === 'voice') {
            console.log('[BlocklyPilot] Re-asking follow-up question, keeping follow-up mode');
            this.voice.enableFollowUpMode();
        } else {
            // Disable follow-up mode since the answer was processed
            this.voice.disableFollowUpMode();
        }

        // Speak for voice users
        if (this.inputMedium === 'voice') {
            // Stop listening while speaking
            if (this.voice.isListening) {
                this.voice.stopListening();
            }

            this.voice.speak(result.message).finally(() => {
                // Auto-start listening after TTS if conversation is active
                // Wait 3 seconds to avoid picking up echo/residual audio
                if (this.voice.isConversationActive()) {
                    setTimeout(() => {
                        if (this.voice.isConversationActive() && !this.voice.isListening) {
                            this.voice.startListening();
                        }
                    }, 3000);
                }
            });
        }

        // Clear voice status
        this.panel.setVoiceStatus('');
    }

    /**
     * Handle intermediate response from AgentController
     * @param {Object} intermediate
     * @private
     */
    handleIntermediateResponse(intermediate) {
        console.log('[BlocklyPilot] Intermediate response:', intermediate);

        // Update UI to show what intent was detected
        if (intermediate.phase === Phase.INTENT_DETECTED && intermediate.wait) {
            // Show intent detection message in voice status
            this.panel.setVoiceStatus(intermediate.message);

            // Announce to screen readers
            this.panel.announce(intermediate.message);

            // Speak for voice users
            if (this.inputMedium === 'voice') {
                // Don't wait for speech to complete since we're still processing
                this.voice.speak(intermediate.message);
            }
        }
    }

    /**
     * Handle CLARIFICATION response from AgentController
     * @param {Object} result
     * @private
     */
    handleClarificationResponse(result) {
        console.log('[BlocklyPilot] Clarification needed:', result);

        // Hide thinking indicator
        this.chat.hideThinking();
        this.state.isProcessing = false;

        // Show clarification question as assistant message
        this.chat.addAssistantMessage(result.message, []);
        this.panel.announce(result.message);

        // Speak for voice users — auto-listen since we're asking a question
        if (this.inputMedium === 'voice') {
            // Stop listening while speaking
            if (this.voice.isListening) {
                this.voice.stopListening();
            }

            // Activate conversation silently since we're about to speak
            this.voice.activateConversation(true);

            this.voice.speak(result.message).finally(() => {
                // Auto-start listening after TTS finishes
                // Wait 3 seconds to avoid picking up echo/residual audio
                setTimeout(() => {
                    if (this.voice.isConversationActive() && !this.voice.isListening) {
                        this.voice.startListening();
                    }
                }, 3000);
            });
        }

        // Clear voice status
        this.panel.setVoiceStatus('');
    }

    /**
     * Build response text from agent result
     * @param {Object} result
     * @returns {string}
     * @private
     */
    buildResponseText(result) {
        const { mode, intent, llmResponse, voiceLine } = result;
        console.log('Rubel: [BlocklyPilot] llmResponse:', llmResponse);
        const effectiveMode = mode || intent;

        let responseText = '';

        const noIssuesMessage = 'No issues found at the current location.';

        // Voice interaction: always use voiceLine for all modes
        if (this.inputMedium === 'voice') {
            if (effectiveMode === Intent.DEBUG) {
                const hasIssues = llmResponse?.diagnostics?.issues?.length > 0;
                responseText = hasIssues ? (voiceLine || noIssuesMessage) : (voiceLine || noIssuesMessage);
            } else {
                responseText = voiceLine || '';
            }
        } else {
            // Text interaction: use mode-specific content
            if (effectiveMode === Intent.COMPREHEND) {
                // For COMPREHEND with text input, prefer comprehension.summary
                responseText = llmResponse?.comprehension?.summary || voiceLine || '';
            } else if (effectiveMode === Intent.DEBUG) {
                // For DEBUG with text input, use diagnostics.issues[0].message
                const issues = llmResponse?.diagnostics?.issues;
                if (issues && issues.length > 0) {
                    responseText = issues[0].message || voiceLine || '';
                } else {
                    responseText = noIssuesMessage;
                }
            } else {
                // For EDIT_GUIDE with text input, use voiceLine
                responseText = voiceLine || '';
            }
        }

        // Fallbacks if responseText is still empty
        if (!responseText && llmResponse) {
            if (effectiveMode === Intent.COMPREHEND && llmResponse.summary) {
                responseText = llmResponse.summary;
            }

            if (effectiveMode === Intent.EDIT_GUIDE) {
                const steps = llmResponse.editPlan?.steps?.length || 0;
                if (steps > 0) {
                    responseText = `I have ${steps} edit step(s) for your program.`;
                }
            }
        }

        return responseText || 'I analyzed your blocks. Let me know if you have any questions!';
    }

    /**
     * Display the final response after middleware processing
     * @param {Object} middlewareResult
     * @private
     */
    displayResponse(middlewareResult) {
        const { result, responseText, actions, speak } = middlewareResult;

        // Build full response text including follow-up question
        let fullResponseText = responseText;
        if (result?.hasFollowUp && result?.followUpQuestion) {
            fullResponseText = `${responseText}\n\n${result.followUpQuestion}`;
        }

        // Add assistant message
        this.chat.addAssistantMessage(fullResponseText, actions);

        // Announce to screen reader
        this.panel.announce(fullResponseText);

        // Clear voice status
        this.panel.setVoiceStatus('');

        // Enable follow-up mode for voice if there's a follow-up question
        if (result?.hasFollowUp && this.inputMedium === 'voice') {
            this.voice.enableFollowUpMode();
            console.log('[BlocklyPilot] Follow-up mode enabled for voice input');
        }

        // Speak if medium is voice
        const shouldSpeakForVoiceUser = (this.inputMedium === 'voice');

        if (shouldSpeakForVoiceUser) {
            // Stop listening while speaking to avoid recognizer picking up TTS
            if (this.voice.isListening) {
                this.voice.stopListening();
            }

            this.voice.speak(fullResponseText).finally(() => {
                // Auto-start listening after TTS finishes if conversation is active
                // Wait 3 seconds to avoid picking up echo/residual audio
                if (this.voice.isConversationActive()) {
                    setTimeout(() => {
                        // Double-check conversation is still active before starting
                        if (this.voice.isConversationActive() && !this.voice.isListening) {
                            this.voice.startListening();
                        }
                    }, 3000);
                }
            });
        } else if (speak && result?.voiceLine) {
            this.voice.speak(result.voiceLine);
        }
    }

    /**
     * Build action buttons based on agent result
     * @param {Object} result
     * @returns {Array}
     * @private
     */
    buildActions(result) {
        const actions = [];
        const { mode, intent, llmResponse, actor } = result;
        const effectiveMode = mode || intent;

        // Always offer "hear again" if there's a voice line
        if (result.voiceLine) {
            actions.push({
                type: ActionType.HEAR_AGAIN,
                label: 'Hear again'
            });
        }

        // Check for patches in various locations
        const hasPatches = llmResponse?.patches?.length > 0 ||
                           llmResponse?.diagnostics?.proposedFixes?.length > 0 ||
                           llmResponse?.editPlan?.steps?.some(s => s.patch);

        // Add mode-specific actions
        if (effectiveMode === Intent.DEBUG && hasPatches) {
            actions.push({
                type: ActionType.APPLY_FIX,
                label: 'Apply fix'
            });
        }

        if (effectiveMode === Intent.EDIT_GUIDE && hasPatches) {
            actions.push({
                type: ActionType.APPLY_SUGGESTION,
                label: 'Apply suggestion'
            });
        }

        return actions;
    }

    /**
     * Handle action button click
     * @param {Object} action
     * @param {number} messageIndex
     * @private
     */
    async handleAction(action, messageIndex) {
        const result = this.state.lastResult;

        switch (action.type) {
            case ActionType.HEAR_AGAIN:
                if (result?.voiceLine) {
                    await this.voice.speak(result.voiceLine);
                }
                break;

            case ActionType.APPLY_FIX:
            case ActionType.APPLY_SUGGESTION: {
                if (!result?.actor || !result?.llmResponse) break;

                const isFix = action.type === ActionType.APPLY_FIX;
                const label = isFix ? 'fix' : 'suggestion';

                // Collect patches from the correct response shape
                const items = isFix
                    ? (result.llmResponse.diagnostics?.proposedFixes?.filter(f => f.patch) || [])
                    : (result.llmResponse.editPlan?.steps?.filter(s => s.patch) || []);

                if (items.length === 0) {
                    this.chat.addAssistantMessage(`No ${label}s found to apply.`);
                    break;
                }

                try {
                    let appliedCount = 0;
                    let skippedCount = 0;
                    for (const item of items) {
                        const res = result.actor.applyPatch(item.patch);
                        console.log("rubel: res: " + JSON.stringify(res));
                        if (res.skipped) {
                            skippedCount++;
                        } else if (res.applied) {
                            appliedCount++;
                        }
                    }

                    if (appliedCount > 0) {
                        this.chat.addAssistantMessage(`Applied ${appliedCount} ${label}(s) to your workspace.`);
                        this.panel.announce(`Applied ${appliedCount} ${label}s`);
                    } else if (skippedCount > 0) {
                        this.chat.addAssistantMessage(`These ${label}s were already applied.`);
                    } else {
                        this.chat.addAssistantMessage(`No changes were needed.`);
                    }
                } catch (err) {
                    console.error('[BlocklyPilot] Error applying patches:', err);
                    this.chat.addAssistantMessage(`Could not apply changes: ${err.message}`);
                }
                break;
            }
        }
    }

    /**
     * Handle voice toggle
     * @private
     */
    handleVoiceToggle() {
        if (!PilotVoice.isRecognitionSupported()) {
            this.panel.announce('Voice input is not supported in this browser.');
            return;
        }

        this.voice.toggleListening();
    }

    /**
     * Activate voice input with a greeting (for first-time activation)
     * @private
     */
    activateVoiceWithGreeting() {
        if (!PilotVoice.isRecognitionSupported()) {
            this.panel.announce('Voice input is not supported in this browser.');
            return;
        }

        // If already listening, do nothing
        if (this.voice.isListening) {
            return;
        }

        // Give greeting on first voice activation
        if (!this.hasGivenVoiceGreeting) {
            this.hasGivenVoiceGreeting = true;

            const greeting = "Hi, I'm Neon. How can I help you?";
            this.panel.announce(greeting);

            // Activate conversation silently since we're about to speak greeting
            this.voice.activateConversation(true);

            // Speak greeting, then start listening after delay
            this.voice.speak(greeting).then(() => {
                // Wait 3 seconds after greeting before starting to listen
                setTimeout(() => {
                    if (this.voice.isConversationActive() && !this.voice.isListening) {
                        this.voice.startListening();
                    }
                }, 3000);
            });
        } else {
            // Already greeted - activate with beep and start listening
            this.voice.activateConversation();
            this.voice.startListening();
        }
    }

    /**
     * Handle wake word detection
     * @param {string} phrase - The wake phrase that was detected
     * @private
     */
    handleWakeWordDetected(phrase) {
        this.panel.setVoiceStatus('Neon is listening...');
        this.panel.announce('Neon is listening');
    }

    /**
     * Handle silence timeout - user stopped speaking
     * @private
     */
    handleSilenceTimeout() {
        this.panel.setVoiceStatus('Processing...');
    }

    /**
     * Handle partial voice recognition result (interim)
     * @param {string} partial
     * @private
     */
    handlePartialVoiceResult(partial) {
        // Show partial transcript in voice status for feedback
        if (this.voice.hasWakePhrase(partial)) {
            this.panel.setVoiceStatus(`Hearing: "${partial}"`);
        }
    }

    /**
     * Handle voice recognition result
     * @param {string} transcript
     * @param {boolean} [isDirectInput=false] - If true, skip wake word check (for follow-up mode)
     * @private
     */
    handleVoiceResult(transcript, isDirectInput = false) {
        // Clear voice status
        this.panel.setVoiceStatus('');

        // Empty transcript means wake word only - prompt user (unless in direct input mode)
        if (!transcript && !isDirectInput) {
            this.panel.announce('Yes? How can I help you?');
            this.panel.setVoiceStatus('Say your command...');
            setTimeout(() => this.panel.setVoiceStatus(''), 3000);
            return;
        }

        // If empty in direct input mode (follow-up), treat as unclear
        if (!transcript && isDirectInput) {
            console.log('[BlocklyPilot] Empty voice input in follow-up mode');
            return;
        }

        // Show transcript in input briefly, then process
        this.panel.setInputValue(transcript);

        // Small delay so user can see what was recognized
        setTimeout(() => {
            this.handleUserInput(transcript, 'voice');
            this.panel.setInputValue('');
        }, 500);
    }

    /**
     * Handle raw voice input (called when wake word is skipped for follow-up)
     * @param {string} transcript
     * @private
     */
    handleDirectVoiceInput(transcript) {
        console.log('[BlocklyPilot] Direct voice input (follow-up mode):', transcript);
        this.handleVoiceResult(transcript, true);
    }

    /**
     * Handle voice recognition error
     * @param {string} message
     * @private
     */
    handleVoiceError(message) {
        this.panel.announce(message);
        this.panel.setVoiceStatus(message);

        // Clear status after delay
        setTimeout(() => {
            this.panel.setVoiceStatus('');
        }, 3000);
    }

    /**
     * Handle conversation state change (ACTIVE/INACTIVE)
     * @param {string} state - ConversationState.ACTIVE or ConversationState.INACTIVE
     * @private
     */
    handleConversationStateChange(state) {
        console.log('[BlocklyPilot] Conversation state changed:', state);

        if (state === ConversationState.ACTIVE) {
            this.panel.setVoiceStatus('Neon is listening...');
        } else if (state === ConversationState.INACTIVE) {
            this.panel.setVoiceStatus('');
            // Clear any pending working updates when deactivating
            this.stopWorkingUpdates();
        }
    }

    // ========= "Neon is working" Updates =========

    /**
     * Start the "Neon is working" update timer
     * Speaks "I'm working on it" every 10s while waiting for API
     * @private
     */
    startWorkingUpdates() {
        this.stopWorkingUpdates(); // Clear any existing timer

        // Ensure listening is stopped during processing to prevent TTS capture
        if (this.voice.isListening) {
            this.voice.stopListening();
        }

        this.isWorkingUpdateActive = true;

        // First update after 10 seconds
        this.workingUpdateTimer = setTimeout(() => {
            this.speakWorkingUpdate();
        }, this.workingUpdateInterval);

        console.log('[BlocklyPilot] Started working updates timer');
    }

    /**
     * Speak a working update and schedule the next one
     * @private
     */
    speakWorkingUpdate() {
        if (!this.isWorkingUpdateActive) {
            return;
        }

        console.log('[BlocklyPilot] Speaking working update');

        // Ensure listening is stopped to prevent TTS from being captured
        if (this.voice.isListening) {
            this.voice.stopListening();
        }

        // Speak the update (don't await - let it run in background)
        // Note: Don't resume listening after working update - only after final response
        this.voice.speak("I'm working on it.").then(() => {
            // Schedule next update after speaking completes
            if (this.isWorkingUpdateActive) {
                this.workingUpdateTimer = setTimeout(() => {
                    this.speakWorkingUpdate();
                }, this.workingUpdateInterval);
            }
        }).catch(() => {
            // If speech fails, still schedule next update
            if (this.isWorkingUpdateActive) {
                this.workingUpdateTimer = setTimeout(() => {
                    this.speakWorkingUpdate();
                }, this.workingUpdateInterval);
            }
        });
    }

    /**
     * Stop the "Neon is working" update timer
     * @private
     */
    stopWorkingUpdates() {
        this.isWorkingUpdateActive = false;

        if (this.workingUpdateTimer) {
            clearTimeout(this.workingUpdateTimer);
            this.workingUpdateTimer = null;
            console.log('[BlocklyPilot] Stopped working updates timer');
        }

        // Cancel any in-progress "working on it" speech to avoid overlap
        // with the final response
        if (this.voice.isSpeaking()) {
            this.voice.stopSpeaking();
        }
    }

    /**
     * Dispose of the pilot
     */
    dispose() {
        if (this.boundKeyHandler) {
            document.removeEventListener('keydown', this.boundKeyHandler);
        }

        // Clear working updates timer
        this.stopWorkingUpdates();

        this.voice.dispose();
        this.chat.dispose();
        this.panel.dispose();

        console.log('[BlocklyPilot] Disposed');
    }
}
