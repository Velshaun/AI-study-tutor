<#
.SYNOPSIS
    Register the ConverseAI local transcript worker with Task Scheduler.

.DESCRIPTION
    Fills the paths and your account name into ConverseAI-LocalWorker.xml and
    registers it via schtasks. Re-running replaces the existing task, so this is
    also how you apply a change to the XML.

    Checks the things that silently produce a task which registers cleanly and
    then never does any work: a missing pythonw.exe, a missing .env, and a
    WORKER_KINDS line that isn't there.

    No administrator rights needed, and no password is stored — the task runs as
    you, under an interactive token.

.PARAMETER Force
    Replace an existing task without asking.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\register-task.ps1
#>
[CmdletBinding()]
param([switch]$Force)

$ErrorActionPreference = 'Stop'

$TaskName = 'ConverseAI Local Worker'
$here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo     = Split-Path -Parent $here
$backend  = Join-Path $repo 'backend'
$pythonw  = Join-Path $repo 'venv\Scripts\pythonw.exe'
$envFile  = Join-Path $backend '.env'
$template = Join-Path $here 'ConverseAI-LocalWorker.xml'

function Fail($message) { Write-Host "  x $message" -ForegroundColor Red; exit 1 }
function Ok($message)   { Write-Host "  + $message" -ForegroundColor Green }

Write-Host "`nChecking this machine can actually run the worker" -ForegroundColor Cyan

if (-not (Test-Path $pythonw)) {
    Fail "No pythonw.exe at $pythonw. Create the venv first, then re-run this."
}
Ok "pythonw.exe found"

if (-not (Test-Path $envFile)) {
    Fail "No backend\.env. The worker needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
}

# Read as raw text rather than parsing: this is a check, not a config loader,
# and a half-written .env parser is its own source of confusing failures.
$envText = Get-Content $envFile -Raw

foreach ($key in 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'YOUTUBE_API_KEY', 'GEMINI_API_KEY') {
    if ($envText -notmatch "(?m)^\s*$key\s*=\s*\S") {
        Fail "backend\.env has no $key. See local-worker\README.md for what each is for."
    }
}
Ok "backend\.env has the keys the worker needs"

# The one line that decides whether this worker competes with Railway for work
# it cannot do. Without it the worker claims every kind, including the pastes
# Railway should be handling.
if ($envText -notmatch '(?m)^\s*WORKER_KINDS\s*=\s*\S') {
    Write-Host ""
    Write-Host "  ! backend\.env has no WORKER_KINDS line." -ForegroundColor Yellow
    Write-Host "    Without it this worker claims every kind of job, including" -ForegroundColor Yellow
    Write-Host "    the pasted imports Railway should be handling." -ForegroundColor Yellow
    Write-Host "    Add this line to backend\.env:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "        WORKER_KINDS=import_youtube" -ForegroundColor White
    Write-Host ""
    Fail "Add that line, then re-run this script."
}
if ($envText -notmatch '(?m)^\s*WORKER_KINDS\s*=.*import_youtube') {
    Fail "WORKER_KINDS is set but doesn't include import_youtube, so this worker would fetch no transcripts."
}
Ok "WORKER_KINDS claims import_youtube"

# --- build the task definition ---------------------------------------------
$account = "$env:USERDOMAIN\$env:USERNAME"
$logFile = Join-Path $here 'worker.log'

$xml = (Get-Content $template -Raw).
    Replace('__USER__',     $account).
    Replace('__PYTHONW__',  $pythonw).
    Replace('__BACKEND__',  $backend).
    Replace('encoding="UTF-8"', 'encoding="UTF-16"')

# Task Scheduler requires UTF-16 for /XML, and rejects the file outright if the
# declared encoding and the actual bytes disagree — hence rewriting the
# declaration just above, while the template stays honest UTF-8 on disk.
$built = Join-Path $env:TEMP 'ConverseAI-LocalWorker.built.xml'
[System.IO.File]::WriteAllText($built, $xml, [System.Text.Encoding]::Unicode)

Write-Host "`nRegistering the task" -ForegroundColor Cyan
Write-Host "  account : $account"
Write-Host "  runs    : $pythonw worker.py"
Write-Host "  in      : $backend"
Write-Host "  log     : $logFile"

$existing = schtasks /Query /TN $TaskName 2>$null
if ($LASTEXITCODE -eq 0 -and -not $Force) {
    $reply = Read-Host "`n  A task called '$TaskName' already exists. Replace it? [y/N]"
    if ($reply -notmatch '^[Yy]') { Write-Host "  Left alone."; exit 0 }
}

# /F replaces an existing definition rather than erroring.
schtasks /Create /TN $TaskName /XML $built /F | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "schtasks refused the task definition (exit $LASTEXITCODE)." }
Ok "Task registered"

Remove-Item $built -ErrorAction SilentlyContinue

Write-Host "`nStarting it now so you don't have to log out and back in" -ForegroundColor Cyan
schtasks /Run /TN $TaskName | Out-Null
Start-Sleep -Seconds 4

$running = @(Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" |
             Where-Object { $_.CommandLine -like '*worker.py*' })
if ($running.Count -gt 0) {
    Ok "Worker is running (pid $($running[0].ProcessId))"
} else {
    Write-Host "  ! No pythonw.exe running worker.py yet." -ForegroundColor Yellow
    Write-Host "    Check $logFile, or run this to see the error in a console:" -ForegroundColor Yellow
    Write-Host "      cd `"$backend`"; ..\venv\Scripts\python.exe worker.py" -ForegroundColor White
}

Write-Host @"

Done. From here:

  Watch it      Get-Content "$logFile" -Wait -Tail 20
  Stop it       .\stop-worker.ps1
  Start it      schtasks /Run /TN "$TaskName"
  Remove it     .\unregister-task.ps1

It starts again at every logon, and restarts within 10 minutes if it dies.
Jobs queued while this machine is off just sit and wait.

"@ -ForegroundColor Gray
