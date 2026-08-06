#!/usr/bin/env bash
# Build the tern-wasm artifact and copy it next to the demo page.
#
# Requires the wasm32-unknown-unknown target: rustup target add wasm32-unknown-unknown
set -euo pipefail
cd "$(dirname "$0")/../.."

cargo build --target wasm32-unknown-unknown -p tern-wasm --release

cp target/wasm32-unknown-unknown/release/tern_wasm.wasm examples/web/tern_wasm.wasm
echo "examples/web/tern_wasm.wasm ready ($(stat -f%z examples/web/tern_wasm.wasm 2>/dev/null || stat -c%s examples/web/tern_wasm.wasm) bytes)"
