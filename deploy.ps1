param(
    [switch]$DryRun = $false
)

$ErrorActionPreference = "Stop"

if ($DryRun) {
    Write-Host "Running dry-run build..." -ForegroundColor Cyan
    npm run build
} else {
    Write-Host "Deploying worker to Cloudflare..." -ForegroundColor Green
    npm run deploy
}

Write-Host "Done!" -ForegroundColor Green
