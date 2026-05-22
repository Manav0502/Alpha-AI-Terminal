#!/bin/bash

# Export environment variables
set -a
[ -f .env ] && source .env
set +a

echo "Starting Next.js Frontend..."
cd frontend && npm run dev
