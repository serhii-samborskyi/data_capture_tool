#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$APP_DIR/.app.pid"
LOG_FILE="$APP_DIR/app.log"

PORT_VALUE="${1:-8787}"

if ! [[ "$PORT_VALUE" =~ ^[0-9]+$ ]]; then
  echo "Invalid port: $PORT_VALUE"
  echo "Usage: ./restart.sh [port]"
  exit 1
fi

if (( PORT_VALUE < 1 || PORT_VALUE > 65535 )); then
  echo "Port out of range: $PORT_VALUE"
  exit 1
fi

echo "Restarting Data_Capture_Tool on port $PORT_VALUE"

# Stop previous process tracked by PID file
if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${OLD_PID:-}" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping previous process (PID $OLD_PID)"
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
    if kill -0 "$OLD_PID" 2>/dev/null; then
      echo "Force stopping PID $OLD_PID"
      kill -9 "$OLD_PID" 2>/dev/null || true
    fi
  fi
  rm -f "$PID_FILE"
fi

# If port is busy, stop the listener (best effort)
if command -v lsof >/dev/null 2>&1; then
  PORT_PIDS="$(lsof -ti tcp:"$PORT_VALUE" -sTCP:LISTEN || true)"
  if [[ -n "$PORT_PIDS" ]]; then
    echo "Port $PORT_VALUE is busy. Stopping listener PID(s): $PORT_PIDS"
    # shellcheck disable=SC2086
    kill $PORT_PIDS 2>/dev/null || true
    sleep 1
    PORT_PIDS="$(lsof -ti tcp:"$PORT_VALUE" -sTCP:LISTEN || true)"
    if [[ -n "$PORT_PIDS" ]]; then
      echo "Force stopping lingering listener PID(s): $PORT_PIDS"
      # shellcheck disable=SC2086
      kill -9 $PORT_PIDS 2>/dev/null || true
    fi
  fi
fi

cd "$APP_DIR"

echo "Starting app... logs: $LOG_FILE"
nohup env PORT="$PORT_VALUE" node src/index.js >>"$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"

sleep 1
if kill -0 "$NEW_PID" 2>/dev/null; then
  echo "Started. PID=$NEW_PID PORT=$PORT_VALUE"
else
  echo "Failed to start. Check log: $LOG_FILE"
  exit 1
fi
