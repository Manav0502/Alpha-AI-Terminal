Write-Host "Starting infrastructure (Kafka, QuestDB, Redis)..."

# Try standard Docker Compose (works if Docker Desktop is installed properly)
try {
    docker compose up -d
}
catch {
    Write-Host "docker compose failed, trying docker-compose (legacy)..."
    
    # Fallback to legacy docker-compose (if installed separately)
    docker-compose up -d
}

Write-Host "Infrastructure started. Waiting 10 seconds for initialization..."
Start-Sleep -Seconds 10

Write-Host "Infrastructure is ready!"