<#
.SYNOPSIS
    Stop the local worker without unregistering its scheduled task.

.DESCRIPTION
    Ends the task, then any pythonw.exe still running worker.py. Both, because
    ending the task alone can leave the process behind if Task Scheduler has
    lost track of it, and killing the process alone lets the 10-minute
    repetition start it again a few minutes later.

    Targets only pythonw processes whose command line mentions worker.py, so
    other Python you have running is left alone.

    It will start again at your next logon. To stop that too, run
    unregister-task.ps1.
#>
$ErrorActionPreference = 'SilentlyContinue'
$TaskName = 'ConverseAI Local Worker'

schtasks /End /TN $TaskName | Out-Null

$procs = @(Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" |
           Where-Object { $_.CommandLine -like '*worker.py*' })

if ($procs.Count -gt 0) {
    $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Write-Host "Stopped $($procs.Count) worker process(es)." -ForegroundColor Green
} else {
    Write-Host "No local worker was running." -ForegroundColor Gray
}

Write-Host "It will start again at your next logon (unregister-task.ps1 stops that too)." -ForegroundColor Gray
