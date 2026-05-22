# Ensure cargo and cmake are on PATH for this session
$env:PATH = "$env:USERPROFILE\.cargo\bin;C:\Program Files\CMake\bin;" + $env:PATH

# Store process objects to kill them later
$script:processes = @()

# Wait until a TCP port is open (polls every second up to $TimeoutSec)
# Uses async BeginConnect to avoid nested try/catch which breaks PowerShell's outer try/finally
function Wait-ForPort {
    param([int]$Port, [int]$TimeoutSec = 60, [string]$Label = "")
    $name = if ($Label) { $Label } else { "port $Port" }
    Write-Host "  Waiting for $name to be ready..." -ForegroundColor DarkCyan
    $deadline = [DateTime]::Now.AddSeconds($TimeoutSec)
    while ([DateTime]::Now -lt $deadline) {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $async = $tcp.BeginConnect('127.0.0.1', $Port, $null, $null)
        $waited = $async.AsyncWaitHandle.WaitOne(1000, $false)
        if ($waited -and $tcp.Connected) {
            $tcp.Close()
            Write-Host "  [$name] is ready!" -ForegroundColor Green
            return
        }
        $tcp.Close()
        Start-Sleep -Milliseconds 500
    }
    Write-Host "  WARNING: $name did not become ready within ${TimeoutSec}s - continuing anyway." -ForegroundColor Yellow
}

# Clean up function when script exits or is interrupted
function Cleanup {
    Write-Host "`nShutting down system..." -ForegroundColor Yellow
    foreach ($p in $script:processes) {
        if ($null -ne $p -and -not $p.HasExited) {
            taskkill /T /F /PID $p.Id 2>$null
        }
    }
    Write-Host "Stopping Docker infrastructure..." -ForegroundColor Yellow
    docker-compose down
    Write-Host "System shutdown complete." -ForegroundColor Green
}

try {
    # ── Pre-flight: Kill anything occupying our ports ────────────────────────
    # Ports: 3000=Next.js, 8080-8083=WS agents,
    #        9000/9009=QuestDB, 5432=PG, 6379=Redis, 19092=Kafka
    Write-Host "==> Cleaning up stale processes and ports..." -ForegroundColor Magenta

    $portsToKill = @(3000, 8080, 8081, 8082, 8083, 9000, 9009, 5432, 6379, 19092)
    foreach ($port in $portsToKill) {
        $matched = $netstatOut | Select-String (":$port\s")
        foreach ($line in $matched) {
            $parts = ("$line".Trim() -split "\s+")
            $procId = $parts[-1]
            if ($procId -match "^\d+$" -and [int]$procId -gt 4) {
                taskkill /PID $procId /T /F 2>$null | Out-Null
                Write-Host "  [killed] PID $procId on port $port" -ForegroundColor DarkGray
            }
        }
    }

    Write-Host "  Pre-flight cleanup done." -ForegroundColor Green
    Start-Sleep -Seconds 2

    # ── Load environment variables ───────────────────────────────────────────
    Write-Host "Loading environment variables from .env..." -ForegroundColor Cyan
    if (Test-Path .env) {
        $envLines = Get-Content .env | Where-Object { $_ -match "=" -and $_ -notmatch "^#" }
        foreach ($line in $envLines) {
            $parts = $line -split "=", 2
            $varName = $parts[0].Trim()
            $varValue = $parts[1].Trim().Trim([char]34).Trim([char]39)
            Set-Item -Path "Env:\$varName" -Value $varValue
        }
    }

    # ── Start infrastructure ─────────────────────────────────────────────────
    Write-Host "Starting infrastructure (Kafka/Redpanda, QuestDB, Redis, Postgres)..." -ForegroundColor Cyan
    docker-compose up -d redpanda questdb postgres redis

    # Wait for each infra service to be reachable before proceeding
    Wait-ForPort -Port 6379  -TimeoutSec 60 -Label "Redis (:6379)"
    Wait-ForPort -Port 5890  -TimeoutSec 90 -Label "Postgres (:5890)"
    Wait-ForPort -Port 9000  -TimeoutSec 90 -Label "QuestDB (:9000)"
    Wait-ForPort -Port 19092 -TimeoutSec 90 -Label "Redpanda/Kafka (:19092)"

    # ── Pre-create Kafka topics via rpk ─────────────────────────────────────
    Write-Host "Pre-creating Kafka topics via rpk..." -ForegroundColor Cyan
    $topics = @("market.ticks", "market.ohlc.10m", "technical_signals", "sentiment_signals", "trade_decisions", "signals.predictive", "signals.insights")
    foreach ($topic in $topics) {
        docker exec alphasuite-redpanda rpk topic create $topic --partitions 3 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  [+] Topic created: $topic" -ForegroundColor Green
        } else {
            Write-Host "  [=] Topic already exists: $topic" -ForegroundColor DarkGray
        }
    }
    docker exec alphasuite-redpanda rpk topic list
    Write-Host "All infrastructure is ready!" -ForegroundColor Green

    # ── Start PRODUCERS first, then CONSUMERS ───────────────────────────────
    # Order: ingestion -> technical -> sentiment -> aggregator -> frontend
    # NOTE: The standalone auth/profile service has been removed from the app.
    # The dashboard at "/" is now directly accessible — no JWT keys, no /api/auth.

    Write-Host "Starting Rust Ingestion Service (Kite -> Kafka)..." -ForegroundColor Cyan
    Push-Location ingestion
    $script:processes += Start-Process -NoNewWindow -PassThru -FilePath "cargo" -ArgumentList "run --release"
    Pop-Location

    Start-Sleep -Seconds 5

    Write-Host "Starting Rust Technical Agent (Kafka ticks -> signals)..." -ForegroundColor Cyan
    Push-Location agents/technical
    $script:processes += Start-Process -NoNewWindow -PassThru -FilePath "cargo" -ArgumentList "run --release"
    Pop-Location

    Write-Host "Starting Node Sentiment Agent (News -> Kafka signals)..." -ForegroundColor Cyan
    Push-Location agents/sentiment
    $script:processes += Start-Process -NoNewWindow -PassThru -FilePath "cmd.exe" -ArgumentList "/c npm start"
    Pop-Location

    Start-Sleep -Seconds 3

    Write-Host "Starting Rust Aggregator (signals -> WS 8080 + OHLC -> WS 8081)..." -ForegroundColor Cyan
    Push-Location aggregator
    $script:processes += Start-Process -NoNewWindow -PassThru -FilePath "cargo" -ArgumentList "run --release"
    Pop-Location

    Start-Sleep -Seconds 3

    Write-Host "Starting Predictive Agent (OHLC -> LinReg -> WS 8082)..." -ForegroundColor Cyan
    Push-Location agents/predictive
    $script:processes += Start-Process -NoNewWindow -PassThru -FilePath "cargo" -ArgumentList "run --release"
    Pop-Location

    Write-Host "Starting Quant-RAG Agent (anomalies -> DeepSeek -> WS 8083)..." -ForegroundColor Cyan
    Push-Location agents/quant-rag
    $script:processes += Start-Process -NoNewWindow -PassThru -FilePath "cargo" -ArgumentList "run --release"
    Pop-Location

    Start-Sleep -Seconds 3

    Write-Host "Starting Next.js Frontend (Tauri)..." -ForegroundColor Cyan
    Push-Location frontend
    $script:processes += Start-Process -NoNewWindow -PassThru -FilePath "cmd.exe" -ArgumentList "/c npm run tauri:dev"
    Pop-Location

    Write-Host "`nAll services are running! Power Phase 3.1 FULLY ENGAGED." -ForegroundColor Green
    Write-Host "Press Ctrl+C to stop all services and infrastructure." -ForegroundColor Yellow

    while ($true) {
        Start-Sleep -Seconds 1
    }
}
finally {
    Cleanup
}