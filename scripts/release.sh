#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OUTPUT="${OUTPUT:-affon-vscode-notebook-ts.vsix}"

npm run build
npx @vscode/vsce package -o "$OUTPUT"

echo "Packaged $OUTPUT"
