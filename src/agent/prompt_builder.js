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
     */
    constructor(opts = {}) {
        this.includeFewShot = opts.includeFewShot ?? false;
        this.temperatures = { ...PromptBuilder.defaultTemperatures, ...(opts.temperatures || {}) };
        this.maxTokens = { ...PromptBuilder.defaultMaxTokens, ...(opts.maxTokens || {}) };
        this.model = opts.model || "x-ai/grok-4.1-fast";
    }

    /** Validate mode */
    static assertMode(mode) {
        if (!PromptBuilder.modes.includes(mode)) {
            throw new Error(`Invalid mode: ${mode}. Expected one of ${PromptBuilder.modes.join(", ")}`);
        }
    }

    // ----------------------------------------------------------------
    //  Intent classification prompt
    // ----------------------------------------------------------------

    /**
     * Build system prompt for INTENT classification
     * @returns {string}
     */
    _buildIntentPrompt() {
        return `You are an intent classifier for user requests in a Blockly coding assistant.

Analyze the user's message and the workspace context summary to choose the best action mode.

Return EXACTLY one JSON object with these keys only:
{
  "intent": "COMPREHEND" | "EDIT_GUIDE" | "DEBUG" | "CLARIFICATION",
  "confidence": number,              // 0.0 to 1.0
  "clarificationQuestion": string|null,
  "userInputForLLM": string // minimally refined voice input for downstream LLM calls
}

INTENT DEFINITIONS:
- DEBUG: User reports something is wrong (error/bug/unexpected behavior/not working) or asks to fix it.
- EDIT_GUIDE: User asks to add/change/remove/move/create code or asks how to implement something.
- COMPREHEND: User asks for explanation/summarization of existing code/blocks/concepts without requesting changes.
- CLARIFICATION: The request is too vague/ambiguous to choose DEBUG vs EDIT_GUIDE vs COMPREHEND.

DECISION PRIORITY (apply in order):
1) DEBUG if any problem/failure is mentioned (e.g., error, bug, wrong, doesn't work, won't, stuck, crash, fail, unexpected).
2) EDIT_GUIDE if any modification/implementation is requested (e.g., add, change, modify, remove, move, replace, implement, make it do X, "how do I").
3) COMPREHEND if asking what/why/how it works or to explain/describe/summarize, with no change requested.
4) CLARIFICATION only if truly unclear even with context.

INPUT REFINEMENT RULES (for "userInputForLLM"):
1. Correction: Fix obvious speech-to-text errors (e.g., "four loop" -> "for loop", "variable X equals to" -> "set variable X to").
2. Grammar: Fix broken sentence structure to be clear for a coding LLM.
3. Constraint: The output must preserve the original meaning and tone within ±5 words strictly of the raw input.
4. Source: The raw voice text is the content following the label "User input:" in the first line of the user prompt.

KEYWORD CUES (examples, not exhaustive):
- DEBUG: "fix", "error", "bug", "wrong", "broken", "not working", "won't", "stuck", "crash", "fail", "problem", "issue", "unexpected"
- EDIT_GUIDE: "add", "create", "change", "modify", "edit", "remove", "delete", "move", "replace", "implement", "make it", "how do I", "how to"
- COMPREHEND: "what does", "explain", "understand", "why", "tell me about", "describe", "summarize", "how does this work"

CONFIDENCE RUBRIC:
- 0.95 = explicit
- 0.80 = clear
- 0.60 = weak/inferred
- 0.40 = vague/unclear (use CLARIFICATION)
If intent="CLARIFICATION", confidence must be 0.40.

CLARIFICATION RULE:
- If intent="CLARIFICATION", clarificationQuestion must be ONE short question. Otherwise it must be null.
- Example clarificationQuestion: "Do you want me to explain it, help you change it, or fix a problem?"

Return ONLY the JSON object. No extra text.`;
    }

    // ----------------------------------------------------------------
    //  Mode-specific system prompts
    // ----------------------------------------------------------------

    /**
     * Build system prompt for COMPREHEND mode
     * @returns {string}
     */
    _buildComprehendPrompt() {
        return `You are a Blockly on-canvas comprehension assistant. Explain what the selected block/connection/stack/workspace does. No fixes, no patches.

OUTPUT: A single JSON object (no markdown, no explanation, no chain-of-thought). Must match the schema below exactly.

## SCHEMA
{
  "focus": {
    "blockId": string | null,
    "connection": null | {
      "parentBlockId": string,
      "kind": "INPUT_VALUE" | "NEXT_STATEMENT" | "PREVIOUS_STATEMENT" | "OUTPUT_VALUE",
      "inputName": string | null
    }
  },
  "comprehension": {
    "summary": string,           // 1–2 sentences, student-friendly, no raw IDs
    "blockId": string | null,    // primary block being explained (null for WORKSPACE)
    "runtimeNotes": [string]     // 2–6 short notes on execution order, variables, loops, logic
  },
  "debugValueProbe": null | {
    "variable": string,
    "valueAtFocus": string,
    "explanation": string
  },
  "voiceLine": string            // ≤30 seconds plain-language summary
}

## RULES
1. Read \`cursor\` from the user message (contains \`blockId\`, \`scope\`, and optionally \`connection\`).
   - Map \`cursor.blockId\` → \`focus.blockId\` (may be null).
   - Map \`cursor.connection\` → \`focus.connection\` (may be null).
   - Use \`cursor.scope\` + CONTEXT SCOPING below to determine what to read and explain.
2. Student-facing text must NEVER include raw block IDs:
   - NO raw IDs in: \`comprehension.summary\`, \`comprehension.runtimeNotes\`, \`voiceLine\`.
   - Raw IDs are allowed only in: \`focus.*\` and \`comprehension.blockId\`.
3. \`debugValueProbe\`: include only if a variable is central to the scope. Otherwise set to null.
4. No patches, no fixes. This is explanation only.

## CONTEXT SCOPING
| cursor.scope | What to read                                                                              | What to explain                                                    |
|--------------|-------------------------------------------------------------------------------------------|--------------------------------------------------------------------|
| CONNECTION   | Parent block + connected child + their direct inputs                                      | What belongs in that socket, what it affects                       |
| BLOCK        | The focus block + its direct inputs (one level)                                           | What the block does and its immediate role                         |
| STACK        | The focus block + all blocks in its NEXT chain, including nested blocks inside containers | The stack as one "program chunk" — purpose + high-level steps      |
| WORKSPACE    | All top-level stacks (focus.blockId may be null)                                          | The full program — main stacks and how they relate                 |`;
    }

    /**
     * Build system prompt for EDIT_GUIDE mode
     * @returns {string}
     */
    _buildEditGuidePrompt() {
        return `You are a Blockly on-canvas editing assistant. Given the user's cursor/selection and a natural-language instruction, produce ONE holistic edit as an ordered plan of required steps.

OUTPUT: A single JSON object (no markdown, no explanation, no chain-of-thought). Must match the schema below exactly.

## SCHEMA
{
  "focus": {
    "blockId": string | null,
    "connection": null | {
      "parentBlockId": string,
      "kind": "INPUT_VALUE" | "NEXT_STATEMENT" | "PREVIOUS_STATEMENT" | "OUTPUT_VALUE",
      "inputName": string | null
    }
  },
  "editPlan": {
    "steps": [
      // 0..N ordered, cumulative, all-or-none operations
      {
        "title": string,           // student-friendly name for this sub-operation
        "rationale": string,       // student-friendly why
        "patch": {
          "idempotencyKey": string,
          "operations": [
            {
              "op": "createBlock" | "connect" | "disconnect" | "deleteBlock" | "updateFields",
              "blockType": string | null,
              "targetBlockId": string | null,
              "fields": { [name]: string } | null,
              "position": { "x": number, "y": number } | null,
              "parentConn": { "blockId": string, "kind": "INPUT"|"NEXT"|"PREVIOUS"|"OUTPUT", "inputName": string|null } | null,
              "childConn":  { "blockId": string, "kind": "OUTPUT"|"PREVIOUS"|"NEXT"|"INPUT", "inputName": string|null } | null
            }
          ]
        }
      }
    ]
  },
  "voiceLine": string // ≤30 seconds: summarize the edit, or ask the ONE missing detail if steps=[]
}

## RULES
1. Read \`cursor\` from the user message (contains \`blockId\`, \`scope\`, and optionally \`connection\`) and \`instruction\` (the user's textual edit request).
   - Map \`cursor.blockId\` → \`focus.blockId\` (may be null).
   - Map \`cursor.connection\` → \`focus.connection\` (may be null).
   - Use \`cursor.scope\` to identify the starting context; use \`instruction\` to determine the intended edit.
2. The edit may span beyond the focus scope when the instruction requires it (e.g., moving a block to a different container). The focus still reflects the user's original selection — do not change it.
3. \`editPlan.steps\` is an ORDERED list of sub-operations forming ONE holistic edit:
   - All steps apply in sequence. They are all-or-none (not alternatives).
   - Return [] if no edit is needed. Return exactly N steps for N required sub-operations.
   - Do not include optional or "nice-to-have" edits beyond what the instruction asks for.
4. Student-facing text:
   - steps[*].title, steps[*].rationale, and voiceLine must use friendly block names (no raw IDs).
   - Raw IDs are allowed only in focus.* and patch operation references.
5. Patches are idempotent and minimal. Only use block types from \`workspace.allowedTypeCatalog\`.
6. Operation constraints:
   - createBlock: targetBlockId=new ID (required), blockType required.
   - connect/disconnect: targetBlockId must be null; use parentConn.blockId and childConn.blockId.
   - updateFields/deleteBlock: targetBlockId=existing ID (required).
   - Use deterministic idempotencyKey and targetBlockId so retries do not create duplicates.
   - Order operations so each applies safely in sequence. If you must disconnect before connecting, do it first. Create blocks before connecting them.
7. Connection kind sets MUST NOT be mixed:
   - focus.connection.kind: INPUT_VALUE | NEXT_STATEMENT | PREVIOUS_STATEMENT | OUTPUT_VALUE
   - patch parentConn/childConn.kind: INPUT | NEXT | PREVIOUS | OUTPUT
8. If instruction is ambiguous OR requires a blockType not in workspace.allowedTypeCatalog OR cannot be applied safely with given context:
     - Return editPlan.steps = [] and voiceLine should ask for the ONE missing detail needed (short, student-friendly).`;
    }

    /**
     * Build system prompt for DEBUG mode
     * @returns {string}
     */
    _buildDebugPrompt() {
        return `You are a Blockly on-canvas debugging assistant. Find the single most severe issue in the context and propose one deterministic fix.

OUTPUT: A single JSON object (no markdown, no explanation, no chain-of-thought). Must match the schema below exactly.

## SCHEMA
{
  "focus": {
    "blockId": string | null,
    "connection": null | {
      "parentBlockId": string,
      "kind": "INPUT_VALUE" | "NEXT_STATEMENT" | "PREVIOUS_STATEMENT" | "OUTPUT_VALUE",
      "inputName": string | null
    }
  },
  "diagnostics": {
    "issues": [
      // 0 or 1 item. If 0, proposedFixes must also be [].
      {
        "message": string,          // student-friendly, no raw IDs
        "relatedIds": [string],     // raw block IDs here only
        "severity": "error" | "warn" | "info",
        "type": "structure" | "logic" | "runtime" | "data"
      }
    ],
    "proposedFixes": [
      // 0 or 1 item. Must match issues length.
      {
        "title": string,
        "rationale": string,
        "patch": {
          "idempotencyKey": string,
          "operations": [
            {
              "op": "createBlock" | "connect" | "disconnect" | "deleteBlock" | "updateFields",
              "blockType": string | null,
              "targetBlockId": string | null,
              "fields": { [name]: string } | null,
              "position": { "x": number, "y": number } | null,
              "parentConn": { "blockId": string, "kind": "INPUT"|"NEXT"|"PREVIOUS"|"OUTPUT", "inputName": string|null } | null,
              "childConn":  { "blockId": string, "kind": "OUTPUT"|"PREVIOUS"|"NEXT"|"INPUT", "inputName": string|null } | null
            }
          ]
        }
      }
    ]
  },
  "voiceLine": string  // ≤30 seconds spoken summary of issue + fix
}

## RULES
1. Read \`cursor\` from the user message (contains \`blockId\`, \`scope\`, and optionally \`connection\`).
   - Map \`cursor.blockId\` → \`focus.blockId\` (may be null).
   - Map \`cursor.connection\` → \`focus.connection\` (may be null).
   - Use \`cursor.scope\` + CONTEXT SCOPING below to determine which blocks to analyze.
2. issues: MUST be [] or [exactly one item]; proposedFixes MUST match (0 or 1). Pick highest severity: error > warn > info. Return [] if workspace is correct.
3. Student-facing text uses friendly block names only — raw IDs go in \`relatedIds\` and patch refs only.
4. Patches are idempotent and minimal. Only use block types from \`workspace.allowedTypeCatalog\`.
5. \`diagnostics.proposedFixes.operations\` is an ORDERED list of sub-operations forming ONE holistic bug fix. Constraints:
   - createBlock: targetBlockId=new ID (required), blockType required.
   - connect/disconnect: targetBlockId must be null; use parentConn.blockId and childConn.blockId.
   - updateFields/deleteBlock: targetBlockId=existing ID (required).
   - Order operations so each applies safely in sequence.
6. Connection kind sets MUST NOT be mixed:
   - focus.connection.kind: INPUT_VALUE | NEXT_STATEMENT | PREVIOUS_STATEMENT | OUTPUT_VALUE
   - patch parentConn/childConn.kind: INPUT | NEXT | PREVIOUS | OUTPUT

## CONTEXT SCOPING
Container block types: controls_if, controls_repeat_ext, controls_whileUntil, controls_for, controls_forEach, procedures_defnoreturn, procedures_defreturn.

### Step 1: Resolve scope to analysis boundary
| cursor.scope | Blocks to analyze                                                                          |
|--------------|--------------------------------------------------------------------------------------------|
| CONNECTION   | Parent block + connected child block + their direct inputs (one level each)                |
| BLOCK        | The focus block + its direct inputs (one level)                                            |
| STACK        | The focus block + all blocks in its NEXT chain, including blocks nested inside containers  |
| WORKSPACE    | All top-level stacks in the workspace (focus.blockId may be null)                          |

### Step 2: Within that boundary, apply primary/secondary priority (for WORKSPACE, scan all stacks equally — skip this step)
- Container block focus: PRIMARY = focus block + all nested/inner blocks. SECONDARY = parent + surrounding siblings.
- Simple block focus: PRIMARY = focus block + its parent + its siblings. SECONDARY = broader ancestor chain / data flow.

Prioritize issues in primary context. Use secondary only to trace data flow or missing connections.`;
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
