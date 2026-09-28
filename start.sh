#!/usr/bin/env bash
# Ptolemy launcher for macOS and Linux: ./start.sh
#  1. Uses Node.js if it's installed (18.11 or newer); otherwise downloads a private copy into .node/
#     (only this folder uses it, nothing is installed on the system).
#  2. Installs Ptolemy's packages the first time, and again when package.json changes.
#  3. Starts Ptolemy and opens the WebUI in the browser. Ctrl+C stops it.
set -euo pipefail
cd "$(dirname "$0")"
NODE_DIR="$PWD/.node"
CHECK_VERSION="const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>18||(a===18&&b>=11)?0:1)"

if command -v node >/dev/null 2>&1 && node -e "$CHECK_VERSION" >/dev/null 2>&1; then
  NODE=node
else
  if [ ! -x "$NODE_DIR/bin/node" ]; then
    echo "Node.js 18.11 or newer wasn't found, so a private copy is being downloaded into .node/ (once)."
    case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) echo "Unsupported system: install Node.js from https://nodejs.org"; exit 1 ;; esac
    case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo "Unsupported CPU: install Node.js from https://nodejs.org"; exit 1 ;; esac
    base="https://nodejs.org/dist/latest-v22.x"
    line="$(curl -fsSL "$base/SHASUMS256.txt" | grep -E "node-v[0-9.]+-$os-$arch\.tar\.gz$" | head -n 1)"
    [ -n "$line" ] || { echo "No Node.js download for $os-$arch."; exit 1; }
    hash="${line%% *}"; file="${line##* }"
    tmp="$(mktemp -d)"
    echo "Downloading $file..."
    curl -fL --progress-bar -o "$tmp/$file" "$base/$file"
    if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/$file" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$tmp/$file" | cut -d' ' -f1)"; fi
    [ "$got" = "$hash" ] || { echo "The download is damaged (checksum mismatch)."; rm -rf "$tmp"; exit 1; }
    rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
    tar -xzf "$tmp/$file" -C "$NODE_DIR" --strip-components=1
    rm -rf "$tmp"
  fi
  NODE="$NODE_DIR/bin/node"
  export PATH="$NODE_DIR/bin:$PATH"
fi

if ! "$NODE" scripts/needs-install.js; then
  echo "Installing Ptolemy's packages..."
  npm install --no-audit --no-fund
fi

exec "$NODE" --watch src/index.js --watched --open
