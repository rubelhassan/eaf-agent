# Blockly AI Tutor

An accessible Blockly plugin with an AI tutor.

> **Disclaimer:** Parts of the code and data are redacted from this repository due to ongoing research and data privacy.

| Part | Where | What it is |
|---|---|---|
| The plugin | `src/` | Keyboard navigation, speech, question blocks, output manager, voice. |
| The app | `test/acblock/` | The web page: Blockly, the plugin, the assistant panel, settings. |
| The agent server | `server/` | A local Node server on `localhost:8787` that model calls go through. |

## Requirements

- Node.js 22.9 or newer, npm, Git.
- Chrome (recommended).

## App setup

From the repository root:

```sh
npm install
./build.sh                                              # builds the plugin into the app
cp test/acblock/config.example.js test/acblock/config.local.js
npx http-server test/acblock -p 8080 -c-1
```

Open http://localhost:8080 to explore.

## Server setup

```sh
cd server
npm install
cp .env.example .env                                    # models and configurations
npm run dev                                             # http://localhost:8787
```

Check it at http://localhost:8787/v1/health. 

## Plugin integration

Build the plugin (`npm run build`), take the files from `dist/`, and start a `NavigationController` on your workspace:

```js
const nav = new NavigationController();
nav.init();
nav.addWorkspace(workspace);
```

The plugin needs Blockly 11.2.2. `test/acblock/index.html` and `test/acblock/js/main.js` show the full integration.

In the app, Shift+K lists every shortcut and Shift+P opens the assistant panel.

## Copyright and license

Copyright (c) 2026 Rubel Hassan Mollik and the DiscoverABILITY Lab, University of North Texas. All rights reserved.

This repository is shared for viewing only. 
