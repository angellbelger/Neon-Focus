#!/bin/bash
# Linux launcher.
cd "$(dirname "$0")" || exit 1
command -v npm >/dev/null 2>&1 || { echo "Install Node.js LTS from https://nodejs.org first."; exit 1; }
[ -d node_modules/electron ] || npm install || exit 1
npm start
