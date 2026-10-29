#!/usr/bin/env bash
# Builds a sherpa-onnx browser engine (asr, vad, kws or tts) from the pinned versions in engines.json.
# Usage: test/acblock/models/build_engines.sh asr
# Tools (Emscripten, CMake, the sherpa-onnx source) go into the gitignored tools/ folder; delete it to remove them.
set -euo pipefail

ENGINE="${1:?usage: build_engines.sh <engine>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
TOOLS="$ROOT/tools"
MANIFEST="$HERE/engines.json"
# Emscripten needs Python 3.10 or newer; macOS's own python3 is older.
PYTHON=""
for p in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$p" >/dev/null && "$p" -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then PYTHON="$(command -v "$p")"; break; fi
done
[ -n "$PYTHON" ] || { echo "Needs Python 3.10 or newer"; exit 1; }
json() { "$PYTHON" -c "import json,sys; d=json.load(open('$MANIFEST')); print(eval(sys.argv[1]))" "$1"; }

[ "$(json "'$ENGINE' in d['engines']")" = "True" ] || { echo "No engine $ENGINE in engines.json"; exit 1; }
TAG="$(json "d['sherpaOnnx']['tag']")"
EMSDK_VERSION="$(json "d['emsdk']")"
MEMORY="$(json "d['initialMemory']")"
mkdir -p "$TOOLS/downloads"

# CMake and sentencepiece in a local venv.
if [ ! -x "$TOOLS/venv/bin/cmake" ]; then
  "$PYTHON" -m venv "$TOOLS/venv"
  "$TOOLS/venv/bin/pip" install -q --disable-pip-version-check "cmake==$(json "d['python']['cmake']")" "sentencepiece==$(json "d['python']['sentencepiece']")"
fi
export PATH="$TOOLS/venv/bin:$PATH"
PYTHON="$TOOLS/venv/bin/python3"
export EMSDK_PYTHON="$PYTHON"

# Emscripten.
if [ ! -d "$TOOLS/emsdk" ]; then
  git clone -q https://github.com/emscripten-core/emsdk.git "$TOOLS/emsdk"
fi
(cd "$TOOLS/emsdk" && ./emsdk install "$EMSDK_VERSION" >/dev/null && ./emsdk activate "$EMSDK_VERSION" >/dev/null)
# shellcheck disable=SC1091
source "$TOOLS/emsdk/emsdk_env.sh" >/dev/null 2>&1

# sherpa-onnx source at the pinned tag.
SRC="$TOOLS/sherpa-onnx"
if [ ! -d "$SRC" ]; then
  git clone -q --depth 1 --branch "$TAG" "$(json "d['sherpaOnnx']['repo']")" "$SRC"
fi
[ "$(git -C "$SRC" describe --tags)" = "$TAG" ] || { echo "$SRC is not at $TAG"; exit 1; }

# Downloads, checked against their sha256.
WORK="$TOOLS/work/$ENGINE"
rm -rf "$WORK" && mkdir -p "$WORK"
COUNT="$(json "len(d['engines']['$ENGINE']['downloads'])")"
for i in $(seq 0 $((COUNT - 1))); do
  URL="$(json "d['engines']['$ENGINE']['downloads'][$i]['url']")"
  SHA="$(json "d['engines']['$ENGINE']['downloads'][$i]['sha256']")"
  FILE="$TOOLS/downloads/$(basename "$URL")"
  [ -f "$FILE" ] || curl -sSL -o "$FILE" "$URL"
  echo "$SHA  $FILE" | shasum -a 256 -c - >/dev/null || { echo "Checksum mismatch: $FILE"; exit 1; }
  case "$FILE" in
    *.tar.bz2) tar xjf "$FILE" -C "$WORK" ;;
    *.zip) unzip -q -o "$FILE" -d "$WORK" ;;
    *) cp "$FILE" "$WORK/" ;;
  esac
done

# Hotwords on an English model need the BPE vocabulary.
BPE="$(json "d['engines']['$ENGINE'].get('bpeVocabFrom', '')")"
if [ -n "$BPE" ]; then
  (cd "$WORK" && "$PYTHON" "$SRC/scripts/export_bpe_vocab.py" --bpe-model "$BPE" >/dev/null)
fi

# Model files into the build's assets folder, under the names the browser build expects.
ASSETS="$SRC/wasm/$ENGINE/assets"
find "$ASSETS" -mindepth 1 ! -name README.md -exec rm -rf {} +
"$PYTHON" - "$MANIFEST" "$ENGINE" "$WORK" "$ASSETS" <<'PY'
import json, shutil, sys
manifest, engine, work, assets = sys.argv[1:]
for name, src in json.load(open(manifest))['engines'][engine]['assets'].items():
    shutil.copy(f'{work}/{src}', f'{assets}/{name}')
PY
# Prebuilt helpers that sit next to the engine (the voice's phonemizer).
"$PYTHON" - "$MANIFEST" "$ENGINE" "$WORK" "$SRC/wasm/$ENGINE" <<'PY'
import json, shutil, sys
manifest, engine, work, dest = sys.argv[1:]
for name, src in json.load(open(manifest))['engines'][engine].get('folders', {}).items():
    shutil.rmtree(f'{dest}/{name}', ignore_errors=True)
    shutil.copytree(f'{work}/{src}', f'{dest}/{name}')
PY

# A smaller starting memory than the default 512 MB; memory still grows as needed.
sed -i.bak -E "s/INITIAL_MEMORY=[0-9]+MB/INITIAL_MEMORY=$MEMORY/" "$SRC/wasm/$ENGINE/CMakeLists.txt"

# make doesn't see changed assets; removing the linked outputs makes it package the new model.
find "$SRC/build-wasm-simd-$ENGINE" -name "sherpa-onnx-wasm-*$ENGINE*" -not -path "*/CMakeFiles/*" -delete 2>/dev/null || true
(cd "$SRC" && ./build-wasm-simd-"$ENGINE".sh)

OUT="$HERE/$ENGINE"
rm -rf "$OUT" && mkdir -p "$OUT"
# Most engines install into bin/wasm/<engine>; keyword spotting into bin/wasm.
INSTALLED="$SRC/build-wasm-simd-$ENGINE/install/bin/wasm"
[ -d "$INSTALLED/$ENGINE" ] && INSTALLED="$INSTALLED/$ENGINE"
cp -R "$INSTALLED/"* "$OUT/"

# Keyword spotting takes its phrases as the model's BPE tokens, one per line ("▁HE Y ▁NE ON @hey_neon").
"$PYTHON" - "$MANIFEST" "$ENGINE" "$WORK" "$OUT" <<'PY'
import json, sys
manifest, engine, work, out = sys.argv[1:]
spec = json.load(open(manifest))['engines'][engine].get('keywords')
if spec:
    import sentencepiece as spm
    sp = spm.SentencePieceProcessor()
    sp.Load(f"{work}/{spec['bpe']}")
    lines = [' '.join(sp.encode(p, out_type=str)) + ' @' + p.lower().replace(' ', '_') for p in spec['phrases']]
    open(f'{out}/keywords.txt', 'w').write('\n'.join(lines) + '\n')
PY
"$PYTHON" - "$MANIFEST" "$ENGINE" "$OUT" "$TAG" "$EMSDK_VERSION" "$MEMORY" <<'PY'
import json, sys
manifest, engine, out, tag, emsdk, memory = sys.argv[1:]
info = {'engine': engine, 'model': json.load(open(manifest))['engines'][engine]['name'],
        'sherpaOnnx': tag, 'emsdk': emsdk, 'initialMemory': memory}
json.dump(info, open(f'{out}/BUILD_INFO.json', 'w'), indent=1)
PY
echo "Built $ENGINE into $OUT"
ls -lh "$OUT"
