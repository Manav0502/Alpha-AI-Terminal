Write-Host "Stopping infrastructure (Kafka, QuestDB, Redis, postgres)..."

# Try modern Docker Compose first
try {
    docker compose down
}
catch {
    Write-Host "docker compose failed, trying docker-compose (legacy)..."
    
    # Fallback to legacy docker-compose
    docker-compose down
}

Write-Host "Infrastructure stopped."