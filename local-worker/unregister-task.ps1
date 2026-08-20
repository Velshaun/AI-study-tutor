<#
.SYNOPSIS
    Remove the local worker's scheduled task, and stop it if it's running.

.DESCRIPTION
    Leaves the repo and backend\.env untouched — this only undoes what
    register-task.ps1 did to Task Scheduler. Nothing in the queue is affected:
    YouTube jobs simply stay pending until some worker that takes that kind
    comes back online.
#>
$ErrorActionPreference = 'SilentlyContinue'
$TaskName = 'ConverseAI Local Worker'

& (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'stop-worker.ps1')

schtasks /Delete /TN $TaskName /F | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Removed the '$TaskName' task." -ForegroundColor Green
} else {
    Write-Host "No such task was registered." -ForegroundColor Gray
}
