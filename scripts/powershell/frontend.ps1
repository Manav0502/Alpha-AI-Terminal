# Load environment variables from .env
if (Test-Path ".env") {
    Write-Host "Loading environment variables from .env..."
    Get-Content .env | ForEach-Object {
        if ($_ -match "^\s*([^#][^=]*)=(.*)$") {
            [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2])
        }
    }
}

Write-Host "Starting Next.js Frontend..."

# Navigate to frontend folder and run dev server
Set-Location frontend
npm run dev