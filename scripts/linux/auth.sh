#!/bin/bash

# Trap Ctrl+C (SIGINT) to gracefully shut down
trap 'echo -e "\nShutting down Auth Service..."; kill $(jobs -p) 2>/dev/null; exit' SIGINT

# Export environment variables from .env
if [ -f .env ]; then
  echo "Loading environment variables from .env..."
  set -a
  source .env
  set +a
fi

echo "Starting Auth Service..."

# Start auth service in background
(cd auth && npm install && npm run dev) &

echo "Auth service is running. Press Ctrl+C to stop."

# Keep script running
wait