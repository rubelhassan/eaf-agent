/**
 * Pilot Middleware - Business logic layer between user input and agent API
 *
 * Middleware functions receive a context object and can:
 * - Transform user input before API call
 * - Add context/metadata to requests
 * - Short-circuit and return early (skip API)
 * - Transform API responses before display
 * - Handle errors with custom logic
 */

/**
 * @typedef {Object} MiddlewareContext
 * @property {string} input - User's input text
 * @property {string} mode - Detected mode: 'COMPREHEND' | 'EDIT_GUIDE' | 'DEBUG'
 * @property {Blockly.WorkspaceSvg} workspace - The Blockly workspace
 * @property {Object} metadata - Custom metadata (add anything here)
 * @property {boolean} skipApi - Set true to skip API call
 * @property {Object|null} customResponse - Provide custom response when skipping API
 */

/**
 * @typedef {Object} MiddlewareResult
 * @property {Object} result - Agent result (or custom response)
 * @property {string} responseText - Text to display to user
 * @property {Array} actions - Action buttons to show
 * @property {boolean} speak - Whether to speak the response
 */

/**
 * PilotMiddleware - Extensible middleware pipeline
 */
export class PilotMiddleware {
    constructor() {
        /** @type {Array<Function>} */
        this.beforeHandlers = [];

        /** @type {Array<Function>} */
        this.afterHandlers = [];

        /** @type {Function|null} */
        this.errorHandler = null;
    }

    /**
     * Register a "before" hook - runs before API call
     * @param {Function} handler - async (context) => context | void
     *   - Modify context.input to transform user input
     *   - Modify context.mode to change agent mode
     *   - Set context.skipApi = true to skip API call
     *   - Set context.customResponse when skipping API
     * @returns {Function} Unregister function
     */
    before(handler) {
        this.beforeHandlers.push(handler);
        return () => {
            const idx = this.beforeHandlers.indexOf(handler);
            if (idx > -1) this.beforeHandlers.splice(idx, 1);
        };
    }

    /**
     * Register an "after" hook - runs after API call (or custom response)
     * @param {Function} handler - async (context, result) => result | void
     *   - Modify result.responseText to change displayed text
     *   - Modify result.actions to change action buttons
     *   - Set result.speak = true/false to control TTS
     * @returns {Function} Unregister function
     */
    after(handler) {
        this.afterHandlers.push(handler);
        return () => {
            const idx = this.afterHandlers.indexOf(handler);
            if (idx > -1) this.afterHandlers.splice(idx, 1);
        };
    }

    /**
     * Register a custom error handler
     * @param {Function} handler - async (error, context) => { responseText, actions } | null
     *   - Return object to show custom error message
     *   - Return null to use default error handling
     */
    onError(handler) {
        this.errorHandler = handler;
    }

    /**
     * Run all "before" handlers
     * @param {MiddlewareContext} context
     * @returns {Promise<MiddlewareContext>}
     */
    async runBefore(context) {
        for (const handler of this.beforeHandlers) {
            try {
                const modified = await handler(context);
                if (modified) {
                    context = { ...context, ...modified };
                }
            } catch (err) {
                console.error('[PilotMiddleware] Before handler error:', err);
            }
        }

        return context;
    }

    /**
     * Run all "after" handlers
     * @param {MiddlewareContext} context
     * @param {MiddlewareResult} result
     * @returns {Promise<MiddlewareResult>}
     */
    async runAfter(context, result) {
        for (const handler of this.afterHandlers) {
            try {
                const modified = await handler(context, result);
                if (modified) {
                    result = { ...result, ...modified };
                }
            } catch (err) {
                console.error('[PilotMiddleware] After handler error:', err);
            }
        }
        return result;
    }

    /**
     * Handle an error through custom handler
     * @param {Error} error
     * @param {MiddlewareContext} context
     * @returns {Promise<Object|null>}
     */
    async handleError(error, context) {
        if (this.errorHandler) {
            try {
                return await this.errorHandler(error, context);
            } catch (err) {
                console.error('[PilotMiddleware] Error handler failed:', err);
            }
        }
        return null;
    }
}

/**
 * Create a context object for middleware
 * @param {Object} options
 * @returns {MiddlewareContext}
 */
export function createContext({ input, mode, workspace }) {
    return {
        input,
        mode,
        workspace,
        metadata: {},
        skipApi: false,
        customResponse: null,
        timestamp: Date.now()
    };
}

/**
 * Create a result object for middleware
 * @param {Object} options
 * @returns {MiddlewareResult}
 */
export function createResult({ result, responseText, actions = [], speak = false }) {
    return {
        result,
        responseText,
        actions,
        speak
    };
}


// ============================================================
// Example middleware handlers (uncomment and customize as needed)
// ============================================================

/**
 * Example: Logging middleware
 */
export function createLoggingMiddleware() {
    return {
        before: (ctx) => {
            console.log('[Middleware] Input:', ctx.input);
            console.log('[Middleware] Mode:', ctx.mode);
            ctx.metadata.startTime = Date.now();
        },
        after: (ctx, result) => {
            const duration = Date.now() - ctx.metadata.startTime;
            console.log('[Middleware] Response time:', duration, 'ms');
            console.log('[Middleware] Response:', result.responseText);
        }
    };
}

export function dummyCommandMiddleware() {
    return {
        before: (ctx) => {
            const input = ctx.input.trim().toLowerCase();
            return {
                skipApi: true,
                customResponse: {
                    voiceLine: `Thank you for your input: ${input}`
                }
            };
        }
    };
}

/**
 * Example: Command shortcuts middleware
 * Handles special commands like "/clear", "/help" without calling API
 */
export function createCommandMiddleware({ onClear, onHelp }) {
    return {
        before: (ctx) => {
            const input = ctx.input.trim().toLowerCase();

            if (input === '/clear' || input === 'clear') {
                if (onClear) onClear();
                return {
                    skipApi: true,
                    customResponse: {
                        voiceLine: 'Conversation cleared.'
                    }
                };
            }

            if (input === '/help' || input === 'help') {
                if (onHelp) onHelp();
                return {
                    skipApi: true,
                    customResponse: {
                        voiceLine: 'I can help you understand your blocks, suggest edits, or debug issues. Just describe what you need!'
                    }
                };
            }
        }
    };
}

/**
 * Example: Rate limiting middleware
 */
export function createRateLimitMiddleware({ maxRequests = 10, windowMs = 60000 }) {
    const requests = [];

    return {
        before: (ctx) => {
            const now = Date.now();
            // Remove old requests outside window
            while (requests.length && requests[0] < now - windowMs) {
                requests.shift();
            }

            if (requests.length >= maxRequests) {
                return {
                    skipApi: true,
                    customResponse: {
                        voiceLine: `Please slow down. You can make ${maxRequests} requests per minute.`
                    }
                };
            }

            requests.push(now);
        }
    };
}

/**
 * Example: Context enrichment middleware
 * Adds workspace state info to help the agent
 */
export function createContextEnrichmentMiddleware() {
    return {
        before: (ctx) => {
            const blockCount = ctx.workspace.getAllBlocks(false).length;
            ctx.metadata.blockCount = blockCount;
            ctx.metadata.hasBlocks = blockCount > 0;

            // Could modify input to add context
            // ctx.input = `[${blockCount} blocks in workspace] ${ctx.input}`;
        }
    };
}
