#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT_VALUE="${1:-8787}"

if ! [[ "$PORT_VALUE" =~ ^[0-9]+$ ]]; then
  echo "Invalid port: $PORT_VALUE"
  echo "Usage: bash scripts/install-run.sh [port]"
  exit 1
fi

if (( PORT_VALUE < 1 || PORT_VALUE > 65535 )); then
  echo "Port out of range: $PORT_VALUE"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but not installed. Install Node 20+ and retry."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but not installed."
  exit 1
fi

cd "$APP_DIR"

echo "[1/5] Installing dependencies"
npm ci

echo "[2/5] Generating Prisma client"
npx prisma generate

if [[ ! -f ".env" ]]; then
  echo "[3/5] Creating .env from .env.example"
  cp .env.example .env
else
  echo "[3/5] .env already exists"
fi

echo "[4/5] Restarting app on port $PORT_VALUE"
./restart.sh "$PORT_VALUE"

echo "[5/5] Done"
echo "UI:    http://localhost:$PORT_VALUE"
echo "Docs:  http://localhost:$PORT_VALUE/api/public/docs"
echo "OpenAPI: http://localhost:$PORT_VALUE/api/public/openapi.json"
