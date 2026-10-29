/**
 * Pilot Module - Entry point
 * Exports all pilot-related functionality for Blockly Neon AI assistant
 */

export { BlocklyPilot } from './blockly_pilot.js';
export { PilotState, VoiceState } from './pilot_state.js';
export { PilotPanel } from './pilot_panel.js';
export { PilotChat, ActionType } from './pilot_chat.js';
export {
    PilotMiddleware,
    createContext,
    createResult,
    // Example middleware factories
    createLoggingMiddleware,
    createCommandMiddleware,
    createRateLimitMiddleware,
    createContextEnrichmentMiddleware,
    dummyCommandMiddleware
} from './pilot_middleware.js';
