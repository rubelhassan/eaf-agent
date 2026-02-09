/**
 * Agent Controller
 * Handles all API calls to OpenRouter with a two-step intent classification flow.
 *
 * Flow:
 * 1. User sends input → AgentController calls NEXT_ACTION API
 * 2. Returns intermediate response with wait=true (or wait=false for CLARIFICATION)
 * 3. Calls appropriate mode API based on intent
 * 4. Returns final response with wait=false
 */

import { PromptBuilder } from './prompt_builder.js';
import { InputBuilder } from './input_builder.js';
import { AgentActor } from './agent_actor.js';

/**
 * Intent types returned by NEXT_ACTION API
 */
export const Intent = {
    COMPREHEND: 'COMPREHEND',
    EDIT_GUIDE: 'EDIT_GUIDE',
    DEBUG: 'DEBUG',
    CLARIFICATION: 'CLARIFICATION'
};

/**
 * Response phase indicators
 */
export const Phase = {
    INTENT_DETECTED: 'INTENT_DETECTED',
    PROCESSING: 'PROCESSING',
    COMPLETE: 'COMPLETE',
    CLARIFICATION: 'CLARIFICATION',
    ERROR: 'ERROR',
    FOLLOW_UP_ANSWER: 'FOLLOW_UP_ANSWER'
};

/**
 * Follow-up question types
 */
export const FollowUpType = {
    APPLY_CHANGES: 'APPLY_CHANGES',       // For EDIT_GUIDE - "Do you want me to apply these changes?"
    NEED_MORE_HELP: 'NEED_MORE_HELP',     // For COMPREHEND/DEBUG - "Do you need more help?"
    NONE: 'NONE'
};

/**
 * Follow-up answer types
 */
export const FollowUpAnswer = {
    YES: 'YES',
    NO: 'NO',
    UNCLEAR: 'UNCLEAR',
    NEW_REQUEST: 'NEW_REQUEST'  // User started a new request instead of answering
};

/**
 * Default configuration
 */
const DEFAULT_CONFIG = {
    model: 'qwen/qwen3-coder',
    intentModel: 'qwen/qwen3-coder', // Model for intent classification
    testing: true,
    includeFewShot: false,
    inputOptions: {
        includeXML: false, // TODO: rubel - skipping xml for reducing paylod overload
        includeVariables: true,
        includeBlocks: true,
        includeTypeCatalog: true,
        includeAllowedTypeCatalog: true,
        trimBlocks: true,
        maxHops: 2
    },
    actorOptions: {
        replaceExistingChild: true,
        trackIdempotency: true,
        defaultGroupPrefix: "ai-patch",
        allowDelete: true,
        recordUndo: true
    }
};

const DEFAULT_API_URL = "https://openrouter.ai/api/v1/chat/completions";

// ---- Dummy responses for testing mode ----

const DUMMY_INTENT_RESPONSE = {
    id: "dummy-intent-001",
    provider: "dummy",
    model: "dummy/test",
    object: "chat.completion",
    created: Date.now(),
    choices: [{
        index: 0,
        finish_reason: "stop",
        message: {
            role: "assistant",
            content: JSON.stringify({
                intent: "EDIT_GUIDE",
                confidence: 0.95,
                userInputForLLM: "[TESTING] Dummy refined voice.",
                clarificationQuestion: null
            })
        }
    }]
};

const DUMMY_EDIT_GUIDE_RESPONSE = {
    id: "dummy-edit-001",
    provider: "dummy",
    model: "dummy/test",
    object: "chat.completion",
    created: Date.now(),
    choices: [{
        index: 0,
        finish_reason: "stop",
        message: {
            role: "assistant",
            content: JSON.stringify({
                focus: { blockId: "set1", connection: null },
                editPlan: {
                    steps: [
                        {
                            title: "Set count to 1",
                            rationale: "Creates a variables_set block wired to a math_number block with value 1.",
                            patch: {
                                idempotencyKey: "dummy-set-count-1",
                                operations: [
                                    { op: "createBlock", blockType: "variables_set", targetBlockId: "set1", fields: { VAR: "count" }, position: { x: 50, y: 50 }, parentConn: null, childConn: null },
                                    { op: "createBlock", blockType: "math_number", targetBlockId: "n10", fields: { NUM: "1" }, position: { x: 0, y: 0 }, parentConn: null, childConn: null },
                                    { op: "connect", blockType: null, targetBlockId: null, fields: null, position: null, parentConn: { blockId: "set1", kind: "INPUT", inputName: "VALUE" }, childConn: { blockId: "n10", kind: "OUTPUT", inputName: null } }
                                ]
                            }
                        }
                    ]
                },
                voiceLine: "I'll set the variable count to one for you."
            })
        }
    }]
};

const DUMMY_COMPREHEND_RESPONSE = {
    id: "dummy-comprehend-001",
    provider: "dummy",
    model: "dummy/test",
    object: "chat.completion",
    created: Date.now(),
    choices: [{
        index: 0,
        finish_reason: "stop",
        message: {
            role: "assistant",
            content: JSON.stringify({
                focus: { blockId: null, connection: null },
                comprehension: {
                    summary: "This block sets the variable count to a value.",
                    blockId: null,
                    runtimeNotes: ["Runs once each time this block executes"]
                },
                debugValueProbe: null,
                voiceLine: "This block sets the variable count."
            })
        }
    }]
};

const DUMMY_DEBUG_RESPONSE = {
    id: "dummy-debug-001",
    provider: "dummy",
    model: "dummy/test",
    object: "chat.completion",
    created: Date.now(),
    choices: [{
        index: 0,
        finish_reason: "stop",
        message: {
            role: "assistant",
            content: JSON.stringify({
                focus: { blockId: null, connection: null },
                diagnostics: {
                    issues: [],
                    proposedFixes: []
                },
                voiceLine: "Everything looks good — no issues found."
            })
        }
    }]
};

/**
 * AgentController class - manages intent classification and agent execution
 */
export class AgentController {
    /**
     * @param {Object} options
     * @param {string} options.apiKey - OpenRouter API key
     * @param {string} [options.baseUrl] - API base URL (defaults to OpenRouter)
     * @param {Object} [options.config] - Override default configuration
     */
    constructor({ apiKey, baseUrl, config = {} }) {
        if (!apiKey) throw new Error("AgentController requires an API key");

        this.apiKey = apiKey;
        this.baseUrl = baseUrl || DEFAULT_API_URL;
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.abortController = null;

        /**
         * Pending follow-up state
         * Stores context needed to interpret user's next message as a follow-up answer
         * @type {Object|null}
         */
        this.pendingFollowUp = null;
    }

    /**
     * Check if there's a pending follow-up question
     * @returns {boolean}
     */
    hasPendingFollowUp() {
        return this.pendingFollowUp !== null;
    }

    /**
     * Get the pending follow-up state
     * @returns {Object|null}
     */
    getPendingFollowUp() {
        return this.pendingFollowUp;
    }

    /**
     * Clear the pending follow-up state
     */
    clearFollowUp() {
        console.log('[AgentController] Clearing follow-up state');
        this.pendingFollowUp = null;
    }

    /**
     * Store follow-up state for the next user interaction
     * @param {Object} state
     * @private
     */
    _storeFollowUp(state) {
        this.pendingFollowUp = {
            type: state.type,
            question: state.question,
            intent: state.intent,
            inputMedium: state.inputMedium,
            timestamp: Date.now(),
            // Store last response context for potential re-use
            lastResult: state.lastResult,
            lastRequest: state.lastRequest,
            lastResponse: state.lastResponse,
            // Queue for one-by-one patch application
            remainingItems: state.remainingItems || null
        };
        console.log('[AgentController] Stored follow-up state:', this.pendingFollowUp);
    }

    /**
     * Process user input with two-step flow
     * @param {Object} params
     * @param {string} params.userInput - User's text input
     * @param {Blockly.WorkspaceSvg} params.workspace - The Blockly workspace
     * @param {Function} params.onIntermediateResponse - Callback for intermediate responses
     * @param {string} [params.inputMedium='text'] - Input medium ('text' or 'voice')
     * @returns {Promise<Object>} Final result
     */
    async process({ userInput, workspace, onIntermediateResponse, inputMedium = 'text' }) {
        this.abortController = new AbortController();

        try {
            // Check if there's a pending follow-up question
            if (this.hasPendingFollowUp()) {
                return await this._processFollowUpAnswer(userInput, workspace, onIntermediateResponse, inputMedium);
            }

            // Step 1: Classify intent
            const intentResult = await this._classifyIntent(userInput, workspace);

            // Handle CLARIFICATION intent immediately
            if (intentResult.intent === Intent.CLARIFICATION) {
                const clarificationResponse = {
                    phase: Phase.CLARIFICATION,
                    wait: false,
                    intent: Intent.CLARIFICATION,
                    message: intentResult.clarificationQuestion || "Could you please provide more details?",
                    voiceLine: intentResult.clarificationQuestion || "Could you please provide more details?"
                };

                if (onIntermediateResponse) {
                    onIntermediateResponse(clarificationResponse);
                }

                return clarificationResponse;
            }

            // Send intermediate response for other intents
            const intermediateResponse = {
                phase: Phase.INTENT_DETECTED,
                wait: true,
                intent: intentResult.intent,
                message: this._getIntentMessage(intentResult.intent),
                voiceLine: this._getIntentMessage(intentResult.intent)
            };

            if (onIntermediateResponse) {
                onIntermediateResponse(intermediateResponse);
            }

            // Step 2: Execute the appropriate mode (use userInputForLLM if provided)
            const llmInput = intentResult.userInputForLLM || userInput;
            const result = await this._executeMode(intentResult.intent, workspace, llmInput);

            console.log("Rubel: main execution done");

            // Generate follow-up question based on intent
            const followUp = this._generateFollowUpQuestion(intentResult.intent, result);

            // Store follow-up state if there's a follow-up question
            if (followUp.type !== FollowUpType.NONE) {
                this._storeFollowUp({
                    type: followUp.type,
                    question: followUp.question,
                    intent: intentResult.intent,
                    inputMedium,
                    lastResult: result,
                    lastRequest: userInput,
                    lastResponse: result.llmResponse
                });
            }

            console.log("Rubel:Final response");
            // Return final response with follow-up question
            // NOTE: `actor` is kept as a non-enumerable-safe reference for
            // workspace operations but must NOT be serialised (circular refs).
            return {
                phase: Phase.COMPLETE,
                wait: false,
                intent: intentResult.intent,
                mode: result.mode,
                llmResponse: result.llmResponse,
                actor: result.actor,           // kept for workspace ops, not serialisable
                voiceLine: result.voiceLine,
                followUpQuestion: followUp.question,
                followUpType: followUp.type,
                hasFollowUp: followUp.type !== FollowUpType.NONE
            };

        } catch (error) {
            console.error('Rubel: [AgentController] Error:', error);

            // Clear any pending follow-up on error
            this.clearFollowUp();

            const errorResponse = {
                phase: Phase.ERROR,
                wait: false,
                intent: null,
                error: true,
                message: this._getUserFriendlyError(error),
                voiceLine: this._getUserFriendlyError(error)
            };

            if (onIntermediateResponse) {
                onIntermediateResponse(errorResponse);
            }

            throw error;
        }
    }

    /**
     * Process user's answer to a follow-up question
     * @param {string} userInput
     * @param {Blockly.WorkspaceSvg} workspace
     * @param {Function} onIntermediateResponse
     * @param {string} inputMedium
     * @returns {Promise<Object>}
     * @private
     */
    async _processFollowUpAnswer(userInput, workspace, onIntermediateResponse, inputMedium) {
        const followUp = this.pendingFollowUp;
        console.log('[AgentController] Processing follow-up answer:', userInput, 'for:', followUp);

        // Interpret the user's answer
        const answerResult = this._interpretFollowUpAnswer(userInput, followUp);

        // If it's a new request (not an answer), clear follow-up and process as new
        if (answerResult.answer === FollowUpAnswer.NEW_REQUEST) {
            console.log('[AgentController] User started new request, clearing follow-up');
            this.clearFollowUp();
            // Re-process as a new request
            return this.process({ userInput, workspace, onIntermediateResponse, inputMedium });
        }

        // If answer is unclear (possibly corrupted voice input), re-ask
        if (answerResult.answer === FollowUpAnswer.UNCLEAR) {
            console.log('[AgentController] Unclear answer, re-asking follow-up');
            return {
                phase: Phase.FOLLOW_UP_ANSWER,
                wait: false,
                intent: followUp.intent,
                answerType: FollowUpAnswer.UNCLEAR,
                message: `I didn't quite catch that. ${followUp.question}`,
                voiceLine: `I didn't quite catch that. ${followUp.question}`,
                followUpQuestion: followUp.question,
                followUpType: followUp.type,
                hasFollowUp: true,
                reAskFollowUp: true
            };
        }

        // Clear the follow-up state since we got a valid answer
        const storedFollowUp = { ...followUp };
        this.clearFollowUp();

        // Handle YES answer
        if (answerResult.answer === FollowUpAnswer.YES) {
            return this._handleFollowUpYes(storedFollowUp, workspace, onIntermediateResponse);
        }

        // Handle NO answer
        return this._handleFollowUpNo(storedFollowUp);
    }

    /**
     * Interpret user's response as a follow-up answer
     * @param {string} userInput
     * @param {Object} followUp
     * @returns {{answer: string, confidence: number}}
     * @private
     */
    _interpretFollowUpAnswer(userInput, followUp) {
        const input = userInput.toLowerCase().trim();

        // Affirmative patterns
        const yesPatterns = [
            /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|apply|please|absolutely|definitely|of course)$/i,
            /^(yes,?\s*(please|do it|apply|go ahead)?)$/i,
            /^(please\s*(do|apply|yes))$/i,
            /^(go\s*ahead)$/i,
            /^(apply\s*(it|them|changes|the changes)?)$/i,
            /^(do\s*it)$/i,
            /^y$/i
        ];

        // Negative patterns
        const noPatterns = [
            /^(no|nope|nah|not now|maybe later|skip|cancel|never mind|nevermind|don't|dont)$/i,
            /^(no,?\s*(thanks|thank you)?)$/i,
            /^(i'm\s*(good|fine|okay|ok))$/i,
            /^(that's\s*(all|enough|it))$/i,
            /^n$/i
        ];

        // Check for yes
        for (const pattern of yesPatterns) {
            if (pattern.test(input)) {
                return { answer: FollowUpAnswer.YES, confidence: 0.9 };
            }
        }

        // Check for no
        for (const pattern of noPatterns) {
            if (pattern.test(input)) {
                return { answer: FollowUpAnswer.NO, confidence: 0.9 };
            }
        }

        // Check if it looks like a new request (longer input with keywords)
        if (input.length > 20 || this._looksLikeNewRequest(input)) {
            return { answer: FollowUpAnswer.NEW_REQUEST, confidence: 0.7 };
        }

        // Too short or unclear - might be corrupted voice
        if (input.length < 3) {
            return { answer: FollowUpAnswer.UNCLEAR, confidence: 0.5 };
        }

        // Default: treat as new request if it doesn't match yes/no patterns
        return { answer: FollowUpAnswer.NEW_REQUEST, confidence: 0.6 };
    }

    /**
     * Check if input looks like a new request rather than a follow-up answer
     * @param {string} input
     * @returns {boolean}
     * @private
     */
    _looksLikeNewRequest(input) {
        const newRequestIndicators = [
            'what', 'how', 'why', 'when', 'where', 'who',
            'can you', 'could you', 'will you', 'would you',
            'help me', 'show me', 'tell me', 'explain',
            'add', 'create', 'make', 'build', 'fix', 'debug',
            'change', 'modify', 'edit', 'update', 'delete', 'remove'
        ];

        return newRequestIndicators.some(indicator => input.includes(indicator));
    }

    /**
     * Handle YES answer to follow-up
     * @param {Object} followUp
     * @param {Blockly.WorkspaceSvg} workspace
     * @param {Function} onIntermediateResponse
     * @returns {Promise<Object>}
     * @private
     */
    async _handleFollowUpYes(followUp, workspace, onIntermediateResponse) {
        const { type, lastResult, intent } = followUp;

        if (type === FollowUpType.APPLY_CHANGES) {
            let applyMessage = '';

            // If we already have a pre-built queue from a previous round, use it
            let queue = followUp.remainingItems;

            if (!queue) {
                // First time: build the queue from the LLM response
                if (!lastResult?.actor || !lastResult?.llmResponse) {
                    return {
                        phase: Phase.FOLLOW_UP_ANSWER, wait: false, intent,
                        answerType: FollowUpAnswer.YES,
                        message: "I couldn't find the previous changes to apply.",
                        voiceLine: "I couldn't find the previous changes to apply.",
                        hasFollowUp: false
                    };
                }

                const steps = lastResult.llmResponse.editPlan?.steps?.filter(s => s.patch) || [];
                const fixes = lastResult.llmResponse.diagnostics?.proposedFixes?.filter(f => f.patch) || [];

                queue = [
                    ...steps.map(s => ({ title: s.title, patch: s.patch })),
                    ...fixes.map(f => ({ title: f.title, patch: f.patch }))
                ];
            }

            if (queue.length === 0) {
                return {
                    phase: Phase.FOLLOW_UP_ANSWER, wait: false, intent,
                    answerType: FollowUpAnswer.YES,
                    message: "I couldn't find any changes to apply.",
                    voiceLine: "I couldn't find any changes to apply.",
                    hasFollowUp: false
                };
            }

            // Apply only the first item
            const current = queue[0];
            const remaining = queue.slice(1);

            try {
                const res = lastResult.actor.applyPatch(current.patch);
                if (res.applied) {
                    applyMessage = `Applied: "${current.title}".`;
                } else {
                    applyMessage = `"${current.title}" was already applied or had no effect.`;
                }
            } catch (err) {
                console.error('[AgentController] Error applying patch:', err);
                applyMessage = `Error applying "${current.title}": ${err.message}`;
            }

            // If there are more items, ask about the next one
            if (remaining.length > 0) {
                const nextTitle = remaining[0].title;
                const nextQuestion = `Do you want to apply the next change: "${nextTitle}"?`;
                applyMessage += `\n\n${remaining.length} more change(s) remaining. ${nextQuestion}`;

                this._storeFollowUp({
                    type: FollowUpType.APPLY_CHANGES,
                    question: nextQuestion,
                    intent,
                    inputMedium: followUp.inputMedium,
                    lastResult,
                    lastRequest: followUp.lastRequest,
                    lastResponse: followUp.lastResponse,
                    remainingItems: remaining
                });

                return {
                    phase: Phase.FOLLOW_UP_ANSWER, wait: false, intent,
                    answerType: FollowUpAnswer.YES,
                    appliedChanges: true,
                    message: applyMessage,
                    voiceLine: applyMessage,
                    followUpQuestion: nextQuestion,
                    followUpType: FollowUpType.APPLY_CHANGES,
                    hasFollowUp: true
                };
            }

            // All done
            applyMessage += ' All changes have been applied!';
            return {
                phase: Phase.FOLLOW_UP_ANSWER, wait: false, intent,
                answerType: FollowUpAnswer.YES,
                appliedChanges: true,
                message: applyMessage,
                voiceLine: applyMessage,
                hasFollowUp: false
            };
        }

        if (type === FollowUpType.NEED_MORE_HELP) {
            // User wants more help - prompt them to ask
            const helpMessage = intent === Intent.DEBUG
                ? "Sure! What would you like me to help you fix?"
                : "Of course! What else would you like to know?";

            return {
                phase: Phase.FOLLOW_UP_ANSWER,
                wait: false,
                intent,
                answerType: FollowUpAnswer.YES,
                message: helpMessage,
                voiceLine: helpMessage,
                hasFollowUp: false,
                awaitingNewRequest: true
            };
        }

        // Fallback
        return {
            phase: Phase.FOLLOW_UP_ANSWER,
            wait: false,
            intent,
            answerType: FollowUpAnswer.YES,
            message: "How can I help you further?",
            voiceLine: "How can I help you further?",
            hasFollowUp: false
        };
    }

    /**
     * Handle NO answer to follow-up
     * @param {Object} followUp
     * @returns {Object}
     * @private
     */
    _handleFollowUpNo(followUp) {
        const { type, intent } = followUp;

        let message;
        if (type === FollowUpType.APPLY_CHANGES) {
            const skipped = followUp.remainingItems?.length || 0;
            message = skipped > 0
                ? `Okay, skipping the remaining ${skipped} change(s). Let me know if you need anything else!`
                : "Okay, I won't apply the changes. Let me know if you need anything else!";
        } else {
            message = "Alright! Let me know if you have any other questions.";
        }

        return {
            phase: Phase.FOLLOW_UP_ANSWER,
            wait: false,
            intent,
            answerType: FollowUpAnswer.NO,
            message,
            voiceLine: message,
            hasFollowUp: false
        };
    }

    /**
     * Generate follow-up question based on intent and result
     * @param {string} intent
     * @param {Object} result
     * @returns {{type: string, question: string}}
     * @private
     */
    _generateFollowUpQuestion(intent, result) {
        // Check if there are changes to apply for EDIT_GUIDE
        if (intent === Intent.EDIT_GUIDE) {
            const hasPatches = result.llmResponse?.patches?.length > 0 ||
                               result.llmResponse?.editPlan?.steps?.some(s => s.patch);

            if (hasPatches) {
                return {
                    type: FollowUpType.APPLY_CHANGES,
                    question: "Do you want me to apply these changes to your workspace?"
                };
            }
        }

        // Check if there are fixes to apply for DEBUG
        if (intent === Intent.DEBUG) {
            const hasFixes = result.llmResponse?.patches?.length > 0 ||
                             result.llmResponse?.diagnostics?.proposedFixes?.length > 0;

            if (hasFixes) {
                return {
                    type: FollowUpType.APPLY_CHANGES,
                    question: "Do you want me to apply these fixes to your workspace?"
                };
            }

            // No fixes but might need more help
            return {
                type: FollowUpType.NEED_MORE_HELP,
                question: "Do you need more help debugging this?"
            };
        }

        // For COMPREHEND, ask if they need more explanation
        if (intent === Intent.COMPREHEND) {
            return {
                type: FollowUpType.NEED_MORE_HELP,
                question: "Do you need more help understanding this?"
            };
        }

        return { type: FollowUpType.NONE, question: null };
    }

    /**
     * Cancel any in-progress request
     */
    cancel() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    }

    /**
     * Debug utility: Log workspace XML and full API request payload to console.
     * Can be called from index.html for debugging purposes.
     *
     * @param {Blockly.WorkspaceSvg} workspace - The Blockly workspace
     * @param {Object} [options] - Customization options
     * @param {string} [options.mode='COMPREHEND'] - Mode: 'COMPREHEND' | 'EDIT_GUIDE' | 'DEBUG'
     * @param {Object} [options.cursor] - Custom cursor override { blockId, connection }
     * @param {boolean} [options.trimBlocks=true] - Whether to trim blocks to focus neighborhood
     * @param {number} [options.maxHops=2] - Graph radius from focus when trimming
     * @param {boolean} [options.includeXML=true] - Include workspace XML
     * @param {boolean} [options.includeFewShot=false] - Include few-shot examples
     * @param {string} [options.model] - Override model name
     * @returns {Object} The payload object (also logged to console)
     */
    logPayload(workspace, options = {}) {
        const {
            mode = 'COMPREHEND',
            cursor = null,
            trimBlocks = true,
            maxHops = 2,
            includeXML = true,
            includeFewShot = false,
            model = null
        } = options;

        // Validate mode
        if (!['COMPREHEND', 'EDIT_GUIDE', 'DEBUG'].includes(mode)) {
            console.error(`[AgentController] Invalid mode: ${mode}. Expected COMPREHEND, EDIT_GUIDE, or DEBUG.`);
            return null;
        }

        // Build InputBuilder with custom options
        const inputBuilder = new InputBuilder(workspace, {
            includeXML,
            includeVariables: true,
            includeBlocks: true,
            includeTypeCatalog: true,
            includeAllowedTypeCatalog: ['EDIT_GUIDE', 'DEBUG'].includes(mode),
            trimBlocks,
            maxHops
        });

        // Build input - use custom cursor or default from workspace
        let input;
        if (cursor) {
            if (cursor.blockId) {
                input = inputBuilder.buildForBlock(mode, cursor.blockId);
            } else if (cursor.connection) {
                input = inputBuilder.buildForConnection(mode, cursor.connection);
            } else {
                input = inputBuilder.buildFromCursor(mode);
            }
        } else {
            input = inputBuilder.buildFromCursor(mode);
        }

        // Build PromptBuilder with options
        const promptBuilder = new PromptBuilder({
            model: model || this.config.model,
            includeFewShot
        });

        // Build full chat payload
        const payload = promptBuilder.buildChatPayload({
            mode,
            input,
            model: model || this.config.model,
            includeFewShot
        });

        // Extract workspace XML directly from workspace (independent of includeXML option)
        let workspaceXML = 'N/A';
        try {
            const dom = Blockly.Xml.workspaceToDom(workspace);
            workspaceXML = Blockly.Xml.domToPrettyText(dom);
        } catch (e) {
            console.warn('[AgentController] Could not extract workspace XML:', e);
        }

        // Log to console
        console.group(`[AgentController] logPayload - Mode: ${mode}`);

        console.log('%c=== Workspace XML ===', 'color: #4CAF50; font-weight: bold;');
        console.log(workspaceXML);

        console.log('%c=== Cursor ===', 'color: #2196F3; font-weight: bold;');
        console.log(JSON.stringify(input.cursor, null, 2));

        console.log('%c=== Input (workspace snapshot) ===', 'color: #FF9800; font-weight: bold;');
        console.log(JSON.stringify(input, null, 2));

        console.log('%c=== Full API Payload ===', 'color: #9C27B0; font-weight: bold;');
        console.log(JSON.stringify(payload, null, 2));

        console.log('%c=== Payload Stats ===', 'color: #607D8B; font-weight: bold;');
        console.log({
            model: payload.model,
            temperature: payload.temperature,
            messageCount: payload.messages.length,
            systemPromptLength: payload.messages[0]?.content?.length || 0,
            userInputLength: payload.messages[payload.messages.length - 1]?.content?.length || 0,
            blocksIncluded: input.workspace?.blocks?.length || 0,
            variablesIncluded: input.workspace?.variables?.length || 0,
            trimBlocks,
            maxHops
        });

        console.groupEnd();

        return { payload, input, workspaceXML };
    }

    /**
     * Classify user intent using NEXT_ACTION API
     * @private
     */
    async _classifyIntent(userInput, workspace) {
        // Build context summary from workspace
        const inputBuilder = new InputBuilder(workspace, this.config.inputOptions);
        const contextSummary = inputBuilder.buildContextSummary();

        // Use PromptBuilder to build the intent classification payload
        const promptBuilder = new PromptBuilder({
            model: this.config.intentModel
        });

        const payload = promptBuilder.buildIntentPayload({
            userInput,
            contextSummary,
            model: this.config.intentModel
        });

        console.log('[AgentController] Intent classification request:', JSON.stringify(payload));

        const response = await this._callApi(payload);
        const parsed = this._extractJSON(response);

        console.log('RUBEL: [AgentController] Intent classification result:', parsed);

        return {
            intent: parsed.intent || Intent.COMPREHEND,
            confidence: parsed.confidence || 0,
            clarificationQuestion: parsed.clarificationQuestion || null,
            userInputForLLM: parsed.userInputForLLM || null
        };
    }

    /**
     * Execute the appropriate mode based on intent
     * @param {string} intent
     * @param {Blockly.WorkspaceSvg} workspace
     * @param {string} [userInputForLLM] - Processed user input from intent classifier
     * @private
     */
    async _executeMode(intent, workspace, userInputForLLM = null) {
        const mode = intent === Intent.CLARIFICATION ? Intent.COMPREHEND : intent;

        // Build prompt (mode-specific: each mode gets its own schema + instructions)
        const promptBuilder = new PromptBuilder({
            model: this.config.model,
            includeFewShot: this.config.includeFewShot
        });

        const inputBuilder = new InputBuilder(workspace, this.config.inputOptions);
        const input = inputBuilder.buildFromCursor(mode);

        // Add user instruction for downstream LLM (used by EDIT_GUIDE, can be used by others)
        if (userInputForLLM) {
            input.instruction = userInputForLLM;
        }

        const payload = promptBuilder.buildChatPayload({
            mode,
            input,
            includeFewShot: this.config.includeFewShot
        });

        console.log(`[AgentController] ${mode} payload:`, JSON.stringify(payload));

        // Call API
        const apiResponse = await this._callApi(payload);

        // Log raw LLM message before parsing
        console.log(`[AgentController] ${mode} raw message:`, apiResponse?.choices?.[0]?.message);

        const llmResponse = this._extractJSON(apiResponse);

        console.debug(`[AgentController] ${mode} response:`, llmResponse);

        // Create actor for workspace operations
        const actor = new AgentActor(workspace, this.config.actorOptions);

        return {
            mode,
            llmResponse,
            actor,
            voiceLine: llmResponse.voiceLine || null
        };
    }

    /**
     * Call the OpenRouter API
     * @private
     */
    async _callApi(payload) {
        // Testing mode: return dummy response without hitting the real API
        if (this.config.testing) {
            return this._getDummyResponse(payload);
        }

        const headers = {
            "Authorization": `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
        };

        // Add optional metadata headers
        if (typeof window !== 'undefined') {
            headers["HTTP-Referer"] = window.location.origin;
            headers["X-Title"] = document.title || "Blockly Agent";
        }

        const body = {
            model: payload.model,
            messages: payload.messages,
            ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
            ...(payload.response_format ? { response_format: payload.response_format } : {}),
            ...(payload.max_tokens !== undefined ? { max_tokens: payload.max_tokens } : {}),
            reasoning: {
                exclude: true,
            }
        };

        const res = await fetch(this.baseUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: this.abortController?.signal
        });

        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`API error ${res.status}: ${text || res.statusText}`);
        }

        return res.json();
    }

    /**
     * Return a dummy API response based on payload context (intent vs mode).
     * @private
     */
    _getDummyResponse(payload) {
        const systemContent = payload.messages?.[0]?.content || '';

        // Intent classification call
        if (systemContent.includes('intent classifier')) {
            console.log('[AgentController] TESTING: returning dummy intent response');
            return DUMMY_INTENT_RESPONSE;
        }

        // Mode execution call — pick by mode keyword in system prompt
        if (systemContent.includes('EDIT_GUIDE')) {
            console.log('[AgentController] TESTING: returning dummy EDIT_GUIDE response');
            return DUMMY_EDIT_GUIDE_RESPONSE;
        }
        if (systemContent.includes('DEBUG')) {
            console.log('[AgentController] TESTING: returning dummy DEBUG response');
            return DUMMY_DEBUG_RESPONSE;
        }

        // Default: COMPREHEND
        console.log('[AgentController] TESTING: returning dummy COMPREHEND response');
        return DUMMY_COMPREHEND_RESPONSE;
    }

    /**
     * Extract JSON from API response
     * @private
     */
    _extractJSON(apiResponse) {
        const msg = apiResponse?.choices?.[0]?.message;
        if (!msg) throw new Error("No assistant message found");

        const content = msg.content;

        if (typeof content === "string") {
            // Try plain JSON first
            try {
                return JSON.parse(content);
            } catch {
                // Try code-fenced JSON
                const m = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
                if (m) {
                    return JSON.parse(m[1]);
                }
                throw new Error("Assistant content is not valid JSON");
            }
        }

        // Already an object/array
        if (typeof content === "object" && content !== null) return content;

        throw new Error("Unsupported assistant content format");
    }

    /**
     * Get user-friendly message for detected intent
     * @private
     */
    _getIntentMessage(intent) {
        const messages = {
            [Intent.COMPREHEND]: "Let me explain that for you...",
            [Intent.EDIT_GUIDE]: "I'll help you make those changes...",
            [Intent.DEBUG]: "Let me check for issues...",
            [Intent.CLARIFICATION]: "I need a bit more information..."
        };
        return messages[intent] || "Processing your request...";
    }

    /**
     * Get user-friendly error message
     * @private
     */
    _getUserFriendlyError(error) {
        if (error.name === 'AbortError') {
            return "Request was cancelled.";
        }

        if (error.message?.includes('401')) {
            return "Authentication failed. Please check your API key.";
        }

        if (error.message?.includes('429')) {
            return "Too many requests. Please wait a moment and try again.";
        }

        if (error.message?.includes('500') || error.message?.includes('502') || error.message?.includes('503')) {
            return "The AI service is temporarily unavailable. Please try again later.";
        }

        if (error.message?.includes('network') || error.message?.includes('fetch')) {
            return "Network error. Please check your internet connection.";
        }

        return "I encountered an error processing your request. Please try again.";
    }
}

/**
 * Create and configure an AgentController instance
 * @param {string} apiKey - OpenRouter API key
 * @param {Object} [options] - Optional configuration
 * @param {string} [options.baseUrl] - API base URL
 * @param {Object} [options.config] - Configuration overrides
 * @returns {AgentController}
 */
export function createAgentController(apiKey, options = {}) {
    return new AgentController({
        apiKey,
        baseUrl: options.baseUrl,
        config: options.config || options
    });
}
