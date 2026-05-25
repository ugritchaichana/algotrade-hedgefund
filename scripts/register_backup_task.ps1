# Register the daily Postgres backup as a Windows Scheduled Task.
# Must be run with elevation (Admin PowerShell). Idempotent — re-running overwrites.
#
# Usage:
#   Right-click PowerShell -> Run as Administrator
#   cd C:\Users\Booth\Desktop\MyProjects\AlgoTrade\scripts
#   .\register_backup_task.ps1

param(
    [string]$TaskName = "AlgoTradePostgresBackup",
    [string]$ScriptPath = "C:\Users\Booth\Desktop\MyProjects\AlgoTrade\scripts\backup_postgres.ps1",
    [string]$RunTime = "03:00",
    [string]$BackupDir = "C:\Users\Booth\backups\algotrade",
    [string]$DbName = "hedgefund_cfd"
)

$ErrorActionPreference = "Stop"

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Write-Error "This script must be run as Administrator (right-click -> Run as Administrator)."
    exit 1
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`" -BackupDir `"$BackupDir`" -DbName `"$DbName`""
$trigger = New-ScheduledTaskTrigger -Daily -At $RunTime
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable:$false -DontStopOnIdleEnd
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName' (daily $RunTime). Script: $ScriptPath"
Write-Host "Test now with: Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "View status:   Get-ScheduledTaskInfo -TaskName '$TaskName'"
