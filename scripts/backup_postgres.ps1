param(
    [string]$BackupDir = "C:\Users\Booth\backups\algotrade",
    [string]$DbName    = "hedgefund_cfd",
    [string]$DbUser    = "postgres",
    [string]$Container = "algotrade-postgres",
    [int]$RetentionDays = 14
)

# Daily Postgres dump for AlgoTrade. Designed to run from Windows Task Scheduler.
# Approach: shell into the docker container so we use the container's pg_dump version —
# avoids "server version mismatch" if host has different psql installed.
# Output: <BackupDir>\algotrade_<yyyy-MM-dd_HHmm>.dump (custom format, compressed)

$ErrorActionPreference = "Stop"
$timestamp = Get-Date -Format "yyyy-MM-dd_HHmm"
$outFile = Join-Path $BackupDir "algotrade_${timestamp}.dump"

if (-not (Test-Path $BackupDir)) {
    New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
}

Write-Host "[$(Get-Date -Format o)] Starting backup -> $outFile"

# Stream pg_dump from the container directly to a local file
$dumpCmd = "docker exec $Container pg_dump -U $DbUser -F c $DbName"
try {
    Invoke-Expression $dumpCmd | Set-Content -Path $outFile -Encoding Byte -NoNewline
    $size = (Get-Item $outFile).Length
    Write-Host "[$(Get-Date -Format o)] Backup ok: $outFile ($([math]::Round($size/1MB,2)) MB)"
} catch {
    Write-Host "[$(Get-Date -Format o)] Backup FAILED: $_" -ForegroundColor Red
    exit 1
}

# Retention: delete dumps older than RetentionDays
$cutoff = (Get-Date).AddDays(-$RetentionDays)
Get-ChildItem -Path $BackupDir -Filter "algotrade_*.dump" -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt $cutoff } |
    ForEach-Object {
        Write-Host "[$(Get-Date -Format o)] Pruning old backup: $($_.Name)"
        Remove-Item $_.FullName -Force
    }

Write-Host "[$(Get-Date -Format o)] Backup complete."
