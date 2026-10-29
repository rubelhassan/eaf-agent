// Copy to config.local.js (gitignored) to change where the agent server runs or to test offline.
// Keys and model choices live on the agent server (server/.env and server/routing.json), never here.
export default {
    agentServer: 'http://localhost:8787',
    testing: false  // true = offline canned replies, no server calls
};
