// Starts the agent server on this machine. The key comes from the environment or server/.env.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildApp} from './app.js';
import {createAgentCore} from './core.js';
import {createEventIntake} from './events.js';
import {TASKS} from './envelope.js';
import {createGuard} from './guard/index.js';
import {loadNer} from './guard/ner.js';
import {createOpenRouterProvider} from './models/openrouter.js';
import {createRouting, type RoutingConfig} from './models/router.js';
import {DEFAULT_PROMPT_VERSIONS} from './prompts/index.js';
import {openLogs} from './store/logs.js';
import {createVoiceEngine} from './voice/sidecar.js';
import type {VoiceConfig} from './voice/protocol.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config: RoutingConfig = JSON.parse(fs.readFileSync(path.join(root, 'routing.json'), 'utf8'));
const {version} = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const settings = config.providers.openrouter;
const apiKey = process.env[settings.keyEnv] || '';
if (!apiKey) console.warn(`${settings.keyEnv} is not set: model calls will fail. Put it in server/.env.`);

// No masking, no server: learners' words never leave unmasked.
const nerModel: string = JSON.parse(fs.readFileSync(path.join(root, 'ner_models.json'), 'utf8')).use;
let ner;
try {
  ner = await loadNer(nerModel, path.join(root, 'models'));
} catch (e) {
  console.error(`Not starting: ${(e as Error).message}`);
  process.exit(1);
}

const routing = createRouting(config, {openrouter: createOpenRouterProvider({baseUrl: settings.baseUrl, apiKey})});
const logs = openLogs(path.join(root, 'data', 'agent.db'));
const guard = createGuard({ner});
const core = createAgentCore({routing, log: logs, guard});
const voiceConfig: VoiceConfig = JSON.parse(fs.readFileSync(path.join(root, 'voice.json'), 'utf8'));
if (typeof voiceConfig.enabled !== 'boolean' || voiceConfig.engine !== 'whisper.cpp' || voiceConfig.model !== 'small.en' ||
    !Number.isInteger(voiceConfig.threads) || voiceConfig.threads < 1 || voiceConfig.threads > 16 ||
    !Number.isInteger(voiceConfig.port) || voiceConfig.port < 0 || voiceConfig.port > 65535 ||
    voiceConfig.utteranceMaxMs !== 60000 || typeof voiceConfig.logTranscripts !== 'boolean') throw new Error('Invalid voice.json');
const voiceEngine = createVoiceEngine({root: path.resolve(root, '..'), config: voiceConfig,
  log: (code) => console.warn('Voice engine:', code)});
const app = await buildApp({
  core,
  work: logs,
  voice: {engine: voiceEngine, utteranceMaxMs: voiceConfig.utteranceMaxMs,
    logTranscripts: voiceConfig.logTranscripts, ner, log: (record) => logs.recordVoice(record)},
  events: createEventIntake({store: logs, guard}),
  logger: true,
  health: () => ({
    version,
    models: Object.fromEntries(TASKS.map((t) => [t, routing.model(t)])),
    promptVersions: Object.fromEntries(TASKS.map((t) => [t, routing.promptVersion(t) || DEFAULT_PROMPT_VERSIONS[t]])),
    keySet: !!apiKey,
    nameFinder: nerModel,
  }),
});

const port = Number(process.env.PORT) || 8787;
// Only this machine: learners' words never reach the network through this server except to the model.
await app.listen({host: '127.0.0.1', port});
const stop = async () => {
  await app.close();
  logs.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
