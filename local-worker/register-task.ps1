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

# pythonw.exe has no console, so without a log file this worker runs completely
# unobservably — a crash on startup would look identical to a quiet queue.
$logFile = Join-Path $here 'worker.log'
if ($envText -notmatch '(?m)^\s*WORKER_LOG_FILE\s*=\s*\S') {
    Write-Host ""
    Write-Host "  ! backend\.env has no WORKER_LOG_FILE line." -ForegroundColor Yellow
    Write-Host "    The task runs pythonw.exe, which has no console, so without" -ForegroundColor Yellow
    Write-Host "    this the worker leaves no trace at all. Add to backend\.env:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "        WORKER_LOG_FILE=$logFile" -ForegroundColor White
    Write-Host ""
    Fail "Add that line, then re-run this script."
}
Ok "WORKER_LOG_FILE is set"

# --- build the task definition ---------------------------------------------
$account = "$env:USERDOMAIN\$env:USERNAME"

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

# Get-ScheduledTask rather than `schtasks /Query 2>$null`: in Windows
# PowerShell 5.1, redirecting a native command's stderr wraps each line in an
# ErrorRecord, which under ErrorActionPreference='Stop' terminates the script —
# so asking whether a task exists would abort whenever it did not.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and -not $Force) {
    $reply = Read-Host "`n  A task called '$TaskName' already exists. Replace it? [y/N]"
    if ($reply -notmatch '^[Yy]') { Write-Host "  Left alone."; exit 0 }
}

# /F replaces an existing definition rather than erroring. Native stderr is left
# alone for the reason above; the exit code is what decides.
$ErrorActionPreference = 'Continue'
schtasks /Create /TN $TaskName /XML $built /F | Out-Null
$created = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($created -ne 0) { Fail "schtasks refused the task definition (exit $created)." }
Ok "Task registered"

Remove-Item $built -ErrorAction SilentlyContinue

Write-Host "`nStarting it now so you don't have to log out and back in" -ForegroundColor Cyan
$ErrorActionPreference = 'Continue'
schtasks /Run /TN $TaskName | Out-Null
$ErrorActionPreference = 'Stop'
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
