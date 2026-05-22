#!/bin/bash
echo "Stopping infrastructure (Kafka, QuestDB, Redis)..."
/usr/libexec/docker/cli-plugins/docker-compose down
echo "Infrastructure stopped."
