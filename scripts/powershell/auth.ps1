# Load environment variables from .env
if (Test-Path ".env") {
    Write-Host "Loading environment variables from .env..."
    Get-Content .env | ForEach-Object {
        if ($_ -match "^\s*([^#][^=]*)=(.*)$") {
            [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2])
        }
    }
}

Write-Host "Starting Auth Service..."

# Move into auth folder
Set-Location auth

# Install deps if needed
if (!(Test-Path "node_modules")) {
    Write-Host "Installing dependencies..."
    npm install
}

# Run service in SAME terminal (no new window)
npm run dev