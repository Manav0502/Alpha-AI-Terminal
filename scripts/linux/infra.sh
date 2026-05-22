#!/bin/bash
echo "Starting infrastructure (Kafka, QuestDB, Redis)..."

# Using the absolute path to the compose plugin since the 'docker compose' alias 
# is not working properly with the apt-installed docker on your system
/usr/libexec/docker/cli-plugins/docker-compose up -d

echo "Infrastructure started. Waiting 10 seconds for initialization..."
sleep 10
echo "Infrastructure is ready!"
