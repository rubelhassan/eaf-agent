// Copy to config.local.js (gitignored) and fill in your OpenRouter key.
// Without config.local.js (or without apiKey) the app runs with canned dummy responses.
export default {
    apiKey: 'sk-or-v1-...',
    model: 'deepseek/deepseek-v3.2',
    intentModel: 'x-ai/grok-4.1-fast',
    testing: false  // true = canned dummy responses, no API calls
};
