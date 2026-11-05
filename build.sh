#!/usr/bin/env sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

npm run build
# After the plugin build, which empties dist/.
npx webpack --config webpack.runner.config.cjs
cp dist/index.js test/acblock/keyboard-navigation/index.js
cp dist/run_worker.js test/acblock/keyboard-navigation/run_worker.js
