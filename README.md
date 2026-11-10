# BlockTutr

**An accessible AI tutor for blind and low-vision (BLV) learners, with equal support for sighted learners.**

> **Disclaimer:** Research findings, prompts, and model training and evaluation sets are withheld during the ongoing study and will be published later.

| Part | Where | What it is |
|---|---|---|
| The plugin | `src/` | Keyboard navigation, speech, question blocks, output manager, voice. |
| The app | `test/acblock/` | The web page: Blockly, the plugin, the assistant panel, settings. |
| The agent server | `server/` | A local Node server on `localhost:8787` that model calls go through. |

## Requirements

- Node.js 22.9+ and npm
- An LLM API key (only for real AI answers)
- Python 3.10+ (only for voice)

## App setup

From the repository root:

```sh
npm install
./build.sh                                              # builds the plugin into the app
cp test/acblock/config.example.js test/acblock/config.local.js   # set testing: true for offline replies
npx http-server test/acblock -p 8080 -c-1
```

Open http://localhost:8080 in browser.

## Server setup

```sh
cd server
npm install
npm run models          # local name-finding model
cp .env.example .env    # add LLM API Key, models and configurations
npm run dev
```

In `config.local.js` set `testing: false` and `agentServer: 'http://localhost:8787'`. Check http://localhost:8787/v1/health.

### Model settings

Any OpenAI-compatible endpoint works, hosted or local (e.g. Ollama). Set these in `server/.env`:

```dotenv
LLM_BASE_URL=http://localhost:11434/v1   # endpoint URL
LLM_API_KEY=                             # leave empty if the server needs no key
LLM_MODEL=                               # model 
```

The endpoint must support JSON mode (`response_format: json_object`).

## Keyboard

| Keys | Action |
|---|---|
| Shift+K | All shortcuts |
| Shift+P | Assistant panel |
| Shift+R / Shift+O | Run / go to output |
| Alt+Shift+Y / A / N / U / R | Yes / all / stop / undo / repeat |
| Ctrl+Shift+V | Voice conversation |

Teacher mode: http://localhost:8080/?teacher=1

## Voice (optional)

```sh
test/acblock/models/build_engines.sh asr   # speech recognition
test/acblock/models/build_engines.sh tts   # AI voice
```

## Tests

```sh
npm test
cd server && npm test
```


## Plugin integration

Build the plugin (`npm run build`), take the files from `dist/`, and start a `NavigationController` on your workspace:

```js
const nav = new NavigationController();
nav.init();
nav.addWorkspace(workspace);
```

The plugin needs Blockly 11.2.2. `test/acblock/index.html` and `test/acblock/js/main.js` show the full integration.

## Copyright

Copyright (c) 2026 Rubel Hassan Mollik and the DiscoverABILITY Lab, University of North Texas.

**This repository is shared for viewing only.**
