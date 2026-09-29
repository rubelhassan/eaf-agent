/**
 * PromptBuilder — mode-specific prompts for Blockly on-canvas AI assistant.
 *
 * Each mode (COMPREHEND, EDIT_GUIDE, DEBUG) gets its own system prompt
 * containing ONLY the relevant schema fields. This reduces payload size
 * and gives the model a clear, focused target.
 *
 * Uses `response_format: { type: "json_object" }` for broad model
 * compatibility (works with Grok, Qwen, Llama, GPT, etc.).
 */

import { getPrompt } from './prompts/index.js';

export class PromptBuilder {
    /** @type {{ [k: string]: number }} */
    static defaultTemperatures = { COMPREHEND: 0.2, EDIT_GUIDE: 0.35, DEBUG: 0.25, INTENT: 0.1 };

    /** @type {{ [k: string]: number }} */
    static defaultMaxTokens = { COMPREHEND: 600, EDIT_GUIDE: 1000, DEBUG: 1000, INTENT: 150 };

    /** @type {string[]} */
    static modes = ["COMPREHEND", "EDIT_GUIDE", "DEBUG"];

    /** @type {string[]} */
    static allModes = ["COMPREHEND", "EDIT_GUIDE", "DEBUG", "INTENT"];

    /**
     * @param {Object} [opts]
     * @param {boolean} [opts.includeFewShot=false] - Include few-shot examples.
     * @param {Record<string, number>} [opts.temperatures] - Per-mode temperatures.
     * @param {Record<string, number>} [opts.maxTokens] - Per-mode max_tokens.
     * @param {string} [opts.model] - Default model name.
     * @param {Record<string, string>} [opts.promptVersions] - Per-mode prompt version (see ./prompts).
     */
    constructor(opts = {}) {
        this.includeFewShot = opts.includeFewShot ?? false;
        this.temperatures = { ...PromptBuilder.defaultTemperatures, ...(opts.temperatures || {}) };
        this.maxTokens = { ...PromptBuilder.defaultMaxTokens, ...(opts.maxTokens || {}) };
        this.model = opts.model || "x-ai/grok-4.1-fast";
        this.promptVersions = { ...(opts.promptVersions || {}) };
    }

    /** Validate mode */
    static assertMode(mode) {
        if (!PromptBuilder.modes.includes(mode)) {
            throw new Error(`Invalid mode: ${mode}. Expected one of ${PromptBuilder.modes.join(", ")}`);
        }
    }

    // ----------------------------------------------------------------
    //  System prompts (versioned files in ./prompts)
    // ----------------------------------------------------------------

    /** @returns {string} */
    _buildIntentPrompt() {
        return getPrompt('INTENT', this.promptVersions.INTENT);
    }

    /** @returns {string} */
    _buildComprehendPrompt() {
        return getPrompt('COMPREHEND', this.promptVersions.COMPREHEND);
    }

    /** @returns {string} */
    _buildEditGuidePrompt() {
        return getPrompt('EDIT_GUIDE', this.promptVersions.EDIT_GUIDE);
    }

    /** @returns {string} */
    _buildDebugPrompt() {
        return getPrompt('DEBUG', this.promptVersions.DEBUG);
    }

    // ----------------------------------------------------------------
    //  Few-shot examples (per mode, compact)
    // ----------------------------------------------------------------

    getFewShots(mode) {
        PromptBuilder.assertMode(mode);

        const examples = {
            COMPREHEND: [
                {
                    input: {
                        mode: "COMPREHEND",
                        cursor: { blockId: "set1", connection: null },
                        workspace: {
                            typeCatalog: ["variables_set", "math_arithmetic", "variables_get", "math_number"],
                            variables: [{ id: "v1", name: "count" }],
                            blocks: [
                                { id: "set1", type: "variables_set", fields: { VAR: "count" }, inputs: [{ name: "VALUE", kind: "INPUT_VALUE", connectedBlockId: "add1" }], next: null, previous: null, output: null },
                                { id: "add1", type: "math_arithmetic", fields: { OP: "ADD" }, inputs: [{ name: "A", kind: "INPUT_VALUE", connectedBlockId: "get1" }, { name: "B", kind: "INPUT_VALUE", connectedBlockId: "num1" }], next: null, previous: null, output: "add1" },
                                { id: "get1", type: "variables_get", fields: { VAR: "count" }, inputs: [], next: null, previous: null, output: "get1" },
                                { id: "num1", type: "math_number", fields: { NUM: "1" }, inputs: [], next: null, previous: null, output: "num1" }
                            ]
                        }
                    },
                    output: {
                        focus: { blockId: "set1", connection: null },
                        comprehension: {
                            summary: "This block sets the variable count to count plus one.",
                            blockId: "set1",
                            runtimeNotes: ["Reads current value of count", "Adds 1 to it", "Stores result back in count"]
                        },
                        debugValueProbe: { variable: "count", valueAtFocus: null, explanation: "Value depends on the prior value of count" },
                        voiceLine: "This block increases the count by one."
                    }
                }
            ],
            EDIT_GUIDE: [
                {
                    input: {
                        mode: "EDIT_GUIDE",
                        cursor: { blockId: null, connection: { parentBlockId: "if1", kind: "INPUT_VALUE", inputName: "IF0" } },
                        workspace: {
                            typeCatalog: ["controls_if", "logic_compare", "logic_boolean", "math_number"],
                            blocks: [
                                { id: "if1", type: "controls_if", fields: {}, inputs: [{ name: "IF0", kind: "INPUT_VALUE", connectedBlockId: null }, { name: "DO0", kind: "NEXT_STATEMENT", connectedBlockId: null }], next: null, previous: null, output: null }
                            ]
                        }
                    },
                    output: {
                        focus: { blockId: null, connection: { parentBlockId: "if1", kind: "INPUT_VALUE", inputName: "IF0" } },
                        editPlan: {
                            steps: [
                                {
                                    title: "Insert a comparison A = 0",
                                    rationale: "IF expects true/false. A simple comparison is a clear start.",
                                    patch: {
                                        idempotencyKey: "step-compare-if1-if0",
                                        operations: [
                                            { op: "createBlock", blockType: "logic_compare", targetBlockId: "acc-logic_compare-if1-if0", fields: { OP: "EQ" }, position: { x: 0, y: 0 }, parentConn: null, childConn: null },
                                            { op: "createBlock", blockType: "math_number", targetBlockId: "acc-math_number-zero", fields: { NUM: "0" }, position: { x: 0, y: 0 }, parentConn: null, childConn: null },
                                            { op: "connect", blockType: null, targetBlockId: null, fields: null, position: null, parentConn: { blockId: "acc-logic_compare-if1-if0", kind: "INPUT", inputName: "B" }, childConn: { blockId: "acc-math_number-zero", kind: "OUTPUT", inputName: null } },
                                            { op: "connect", blockType: null, targetBlockId: null, fields: null, position: null, parentConn: { blockId: "if1", kind: "INPUT", inputName: "IF0" }, childConn: { blockId: "acc-logic_compare-if1-if0", kind: "OUTPUT", inputName: null } }
                                        ]
                                    }
                                }
                            ]
                        },
                        voiceLine: "Let's add a comparison so the IF has a true-or-false test."
                    }
                }
            ],
            DEBUG: [
                {
                    input: {
                        mode: "DEBUG",
                        cursor: { blockId: "if1", connection: null },
                        workspace: {
                            typeCatalog: ["controls_if", "math_number", "logic_compare"],
                            blocks: [
                                { id: "if1", type: "controls_if", fields: {}, inputs: [{ name: "IF0", kind: "INPUT_VALUE", connectedBlockId: "num1" }, { name: "DO0", kind: "NEXT_STATEMENT", connectedBlockId: null }], next: null, previous: null, output: null },
                                { id: "num1", type: "math_number", fields: { NUM: "42" }, inputs: [], next: null, previous: null, output: "num1" }
                            ]
                        }
                    },
                    output: {
                        focus: { blockId: "if1", connection: null },
                        diagnostics: {
                            issues: [{ message: "IF expects a boolean but receives a number literal (42).", relatedIds: ["if1", "num1"], severity: "warn", type: "logic" }],
                            proposedFixes: [
                                {
                                    title: "Replace number with a comparison",
                                    rationale: "Comparisons produce a boolean for IF.",
                                    patch: {
                                        idempotencyKey: "fix-if1-nonboolean",
                                        operations: [
                                            { op: "createBlock", blockType: "logic_compare", targetBlockId: "acc-logic_compare-if1", fields: { OP: "GT" }, position: { x: 0, y: 0 }, parentConn: null, childConn: null },
                                            { op: "connect", blockType: null, targetBlockId: null, fields: null, position: null, parentConn: { blockId: "if1", kind: "INPUT", inputName: "IF0" }, childConn: { blockId: "acc-logic_compare-if1", kind: "OUTPUT", inputName: null } }
                                        ]
                                    }
                                }
                            ]
                        },
                        voiceLine: "Switch the number to a comparison so the IF checks true or false."
                    }
                }
            ]
        };

        return examples[mode];
    }

    // ----------------------------------------------------------------
    //  Public API
    // ----------------------------------------------------------------

    /**
     * Build the system prompt for a given mode.
     * @param {string} mode - COMPREHEND | EDIT_GUIDE | DEBUG | INTENT
     * @returns {string}
     */
    buildSystemPrompt(mode) {
        if (mode === 'INTENT') {
            return this._buildIntentPrompt();
        }
        PromptBuilder.assertMode(mode);
        switch (mode) {
            case 'COMPREHEND': return this._buildComprehendPrompt();
            case 'EDIT_GUIDE': return this._buildEditGuidePrompt();
            case 'DEBUG':      return this._buildDebugPrompt();
        }
    }

    /**
     * Build messages for intent classification.
     * @param {Object} params
     * @param {string} params.userInput - User's text input
     * @param {Object} params.contextSummary - Workspace context summary from InputBuilder
     * @returns {{ role: string, content: string }[]}
     */
    buildIntentMessages({ userInput, contextSummary }) {
        const systemPrompt = this._buildIntentPrompt();
        const userMessage = `User input: "${userInput}"

Workspace context:
${JSON.stringify(contextSummary, null, 2)}

Classify the user's intent.`;

        return [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage }
        ];
    }

    /**
     * Build a ready-to-send payload for intent classification.
     * @param {Object} params
     * @param {string} params.userInput - User's text input
     * @param {Object} params.contextSummary - Workspace context summary from InputBuilder
     * @param {string} [params.model] - Override model name
     * @returns {Object} API payload
     */
    buildIntentPayload({ userInput, contextSummary, model }) {
        const messages = this.buildIntentMessages({ userInput, contextSummary });

        return {
            model: model || this.model,
            temperature: this.temperatures.INTENT,
            max_tokens: this.maxTokens.INTENT,
            include_reasoning: false,
            messages,
            response_format: { type: "json_object" }
        };
    }

    /**
     * Build the chat messages array.
     * @param {Object} params
     * @param {"COMPREHEND"|"EDIT_GUIDE"|"DEBUG"} params.mode
     * @param {any} params.input - Runtime payload (cursor + workspace snapshot).
     * @param {boolean} [params.includeFewShot] - Override instance default.
     * @returns {{ role: string, content: string }[]}
     */
    buildMessages({ mode, input, includeFewShot } = {}) {
        PromptBuilder.assertMode(mode);
        const useFewShot = includeFewShot ?? this.includeFewShot;

        const messages = [];

        // 1) Single system message with mode-specific prompt + schema
        messages.push({ role: "system", content: this.buildSystemPrompt(mode) });

        // 2) Few-shot exemplars (optional)
        if (useFewShot) {
            const shots = this.getFewShots(mode);
            for (const ex of shots) {
                messages.push({ role: "user", content: JSON.stringify(ex.input) });
                messages.push({ role: "assistant", content: JSON.stringify(ex.output) });
            }
        }

        // 3) Current request (pretty-printed for better LLM readability)
        messages.push({ role: "user", content: JSON.stringify(input) });

        return messages;
    }

    /**
     * Build a ready-to-send payload for OpenAI-style Chat Completions APIs.
     * Uses `response_format: { type: "json_object" }` for broad compatibility.
     *
     * @param {Object} params
     * @param {"COMPREHEND"|"EDIT_GUIDE"|"DEBUG"} params.mode
     * @param {any} params.input
     * @param {string} [params.model]
     * @param {Record<string, number>} [params.temperatures]
     * @param {Record<string, number>} [params.maxTokens]
     * @param {boolean} [params.includeFewShot]
     */
    buildChatPayload({ mode, input, model, temperatures, maxTokens, includeFewShot } = {}) {
        PromptBuilder.assertMode(mode);
        const messages = this.buildMessages({ mode, input, includeFewShot });
        const temp = (temperatures || this.temperatures)[mode];
        const tokens = (maxTokens || this.maxTokens)[mode];

        return {
            model: model || this.model,
            temperature: temp,
            max_tokens: tokens,
            include_reasoning: false,
            messages,
            response_format: { type: "json_object" }
        };
    }
}
