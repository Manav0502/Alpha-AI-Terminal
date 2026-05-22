#!/bin/bash

# Trap SIGINT to gracefully shut down all background processes when the user hits Ctrl+C
trap 'echo "Shutting down backend services..."; kill $(jobs -p); exit' SIGINT

# Export environment variables for all downstream processes
set -a
[ -f .env ] && source .env
set +a

echo "Starting Rust Ingestion Service..."
(cd ingestion && cargo run --release) &

echo "Starting Rust Technical Agent..."
(cd agents/technical && cargo run --release) &

echo "Starting Node Sentiment Agent..."
(cd agents/sentiment && npm start) &

echo "Starting Rust Aggregator..."
(cd aggregator && cargo run --release) &

echo "Backend services are running. Press Ctrl+C to stop."

# Wait for background processes to keep script running
wait
