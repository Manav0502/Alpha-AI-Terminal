#!/bin/bash

# Trap SIGINT to gracefully shut down all background processes when the user hits Ctrl+C
trap 'echo -e "\n\e[33mShutting down system...\e[0m"; kill $(jobs -p) 2>/dev/null; /usr/libexec/docker/cli-plugins/docker-compose down; echo -e "\e[32mSystem shutdown complete.\e[0m"; exit' SIGINT

echo -e "\e[36mLoading environment variables from .env...\e[0m"
# Export environment variables for all downstream processes
set -a
[ -f .env ] && source .env
set +a

echo -e "\e[36mStarting infrastructure (Kafka/Redpanda, QuestDB, Redis, Postgres)...\e[0m"
/usr/libexec/docker/cli-plugins/docker-compose up -d

echo -e "\e[36mInfrastructure started. Waiting 15 seconds for initialization...\e[0m"
sleep 15

# ── Pre-create Kafka topics via Redpanda's rpk CLI ──────────────────────
# This eliminates the UnknownTopicOrPartition race condition:
# consumers can subscribe immediately without waiting for producers to
# publish their first message and trigger auto-create.
echo -e "\e[36mPre-creating Kafka topics via rpk...\e[0m"

TOPICS=("market.ticks" "technical_signals" "sentiment_signals" "trade_decisions")
for topic in "${TOPICS[@]}"; do
    docker exec ai-trader-redpanda-1 rpk topic create "$topic" --partitions 3 2>/dev/null
    if [ $? -eq 0 ]; then
        echo -e "  \e[32m[+] Topic '$topic' created\e[0m"
    else
        echo -e "  \e[90m[=] Topic '$topic' already exists (ok)\e[0m"
    fi
done

# Verify topics were created
echo -e "\e[36mVerifying Kafka topics...\e[0m"
docker exec ai-trader-redpanda-1 rpk topic list
echo -e "\e[32mInfrastructure is ready!\e[0m"

# ── Start PRODUCERS first, then CONSUMERS ─────────────────────────────────
# Order matters: ingestion → technical → sentiment → aggregator → frontend
# This ensures data flows downstream before consumers try to read.

echo -e "\e[36mStarting Auth Service...\e[0m"
(cd auth && npm run dev) &

echo -e "\e[36mStarting Rust Ingestion Service (Kite → Kafka)...\e[0m"
(cd ingestion && cargo run --release) &

# Give ingestion a moment to connect to Kite and start publishing ticks
sleep 5

echo -e "\e[36mStarting Rust Technical Agent (Kafka ticks → signals)...\e[0m"
(cd agents/technical && cargo run --release) &

echo -e "\e[36mStarting Node Sentiment Agent (News → Kafka signals)...\e[0m"
(cd agents/sentiment && npm start) &

# Give producers a moment to publish their first messages
sleep 3

echo -e "\e[36mStarting Rust Aggregator (signals → decisions → WebSocket)...\e[0m"
(cd aggregator && cargo run --release) &

# Give aggregator time to start WS server before frontend connects
sleep 3

echo -e "\e[36mStarting Next.js Frontend (Tauri)...\e[0m"
(cd frontend && npm run tauri:dev) &

echo -e "\n\e[32mAll services are running! Power Phase 3.1 FULLY ENGAGED.\e[0m"
echo -e "\e[33mPress Ctrl+C to stop all services and infrastructure.\e[0m"

# Wait for background processes to keep script running
wait
