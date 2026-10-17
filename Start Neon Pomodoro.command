#!/bin/bash
# macOS launcher: double-click to start Neon Pomodoro.
cd "$(dirname "$0")" || exit 1

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js is not installed."
  echo "Download the LTS version from https://nodejs.org, install it, then double-click this file again."
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

if [ ! -d "node_modules/electron" ]; then
  echo "First run: installing Neon Pomodoro (this takes a minute)..."
  if ! npm install; then
    echo
    echo "Installation failed. See the messages above."
    read -n 1 -s -r -p "Press any key to close..."
    exit 1
  fi
fi

npm start
