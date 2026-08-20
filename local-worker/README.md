# Local worker

Fetches YouTube transcripts from **this machine's residential IP**, because
YouTube refuses them from datacentre IPs. Everything else stays on Railway.

```
Your machine ──> YouTube ──┐
                           ├──> Supabase <── Railway API <── Frontend
Railway worker ────────────┘     (jobs)
   (pastes, ping)
```

Measured on 20 Aug 2026: 0 of 21 videos from a playlist succeeded from the
Railway worker; 4 of 4 of the same videos succeeded from a laptop in the same
minute. The library names the reason — cloud provider IPs are blocked wholesale.

## It is not a separate program

Unlike the Pro Clubs collector, there is no bespoke script here. This runs
`backend/worker.py` — the same worker Railway runs — with a narrower remit set
by one environment variable:

| Where | `WORKER_KINDS` | Takes |
|---|---|---|
| Railway | `import_paste,ping` | Pasted material, health checks |
| This machine | `import_youtube` | Video and playlist transcripts |

Which means resume, checkpoints, heartbeat reclaim and **Retry Failed** all
already work here. A YouTube import queued while this machine is off simply sits
`queued` — no worker takes it, nothing times out, and it drains when this
machine next comes online. That is the existing durable queue, not something
added for this.

The filter lives in the `claim_job` database function rather than in the
worker's handler registry, because a worker that claims a job it has no handler
for *fails* the job outright rather than putting it back. "Not my kind" has to
mean "never claimed".

## Setup

One line in `backend/.env` (which is gitignored, so it stays on this machine):

```
WORKER_KINDS=import_youtube
```

The rest of what it needs is already there:

| Key | Why the local worker needs it |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Claiming jobs and writing results |
| `YOUTUBE_API_KEY` | Listing playlists (transcripts themselves need no key) |
| `GEMINI_API_KEY` | It runs the finaliser, so it rebuilds the study plan |

> The service-role key bypasses RLS. It is only safe while `backend/.env` stays
> untracked — check with `git check-ignore backend/.env` before copying this
> setup anywhere.

Then:

```powershell
powershell -ExecutionPolicy Bypass -File .\register-task.ps1
```

It refuses to register a task that would not work: no `pythonw.exe`, no `.env`,
a missing key, or a `WORKER_KINDS` that does not include `import_youtube`.

## Running it

| | |
|---|---|
| Watch the log | `Get-Content .\worker.log -Wait -Tail 20` |
| Stop it | `.\stop-worker.ps1` |
| Start it | `schtasks /Run /TN "ConverseAI Local Worker"` |
| Remove it | `.\unregister-task.ps1` |
| Run it in a console instead | `cd ..\backend; ..\venv\Scripts\python.exe worker.py` |

That last one is the first thing to try when something looks wrong — the
scheduled task runs `pythonw.exe`, which has no console, so a crash on startup
is silent apart from the log.

## Why no window appears

`pythonw.exe` creates no console at all, so there is nothing to hide — no VBS
wrapper, no `shell:startup` shortcut, no window flashing at logon.

The task also runs under an **interactive token**, which means it needs no
stored password. The trade is that it starts when you log in rather than at
boot. Making it start at boot means "run whether user is logged on or not",
which requires saving your Windows password into Task Scheduler.

## The settings that matter

Four defaults in Task Scheduler will each quietly break a long-running worker on
a laptop, which is why the task is defined in XML rather than assembled from
`schtasks` flags:

| Setting | Default | Why it is overridden |
|---|---|---|
| `StopIfGoingOnBatteries` | true | Worker dies the moment you unplug |
| `DisallowStartIfOnBatteries` | true | And refuses to start again until plugged in |
| `ExecutionTimeLimit` | 3 days | Windows kills the task; this loop should run for months |
| `MultipleInstancesPolicy` | ignore new | Set explicitly so the 10-minute repetition is a no-op while healthy, and a restart when not |

The 10-minute repetition plus `IgnoreNew` is the self-heal: nothing happens
while the worker is alive, and it comes back within ten minutes if it dies.

## Checking it is actually working

```powershell
Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" |
  Where-Object { $_.CommandLine -like '*worker.py*' }
```

The log's first line names what it claims, so a typo in `WORKER_KINDS` is
visible immediately rather than presenting as a worker that polls forever and
never picks anything up:

```
Worker Macs-Computer:65676 started. Taking import_youtube. Item concurrency 5, polling 2s busy / 45s idle.
```
