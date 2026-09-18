# Attendance Task Scheduler Setup

This project uses one PHP CLI entry point for localhost testing and cPanel
website deployment:

- `cpanel-attendance-cron.php` - the only script registered in the scheduler
- `cron_worker_lib.php` - shared attendance logic used by the entry point
- `../config/database.php` - database connection and `Asia/Manila` timezone

Do not configure a `.ps1` file on cPanel. PowerShell task installers are for a
Windows server and are not required by this scheduler.

## What runs and when

Configure the entry point once per minute. It decides internally which work is
due, so only one scheduled task is required.

| Work | Schedule |
| --- | --- |
| Pending/Absent attendance transitions | Every cron invocation (normally every minute) |
| Attendance-record generation/reconciliation | Every 5 minutes |
| School-year and semester status synchronization | Every 5 minutes |
| Daily academic safety pass | Once per day after 12:05 AM |

The script uses a lock to prevent overlapping executions. Successful run times
are stored in a state file. If five-minute work fails, it remains due and is
retried on the next invocation.

Class-schedule create/import requests still generate attendance immediately.
Schedule edits still rebuild only untouched current/future placeholders.
Scanned attendance and historical records are preserved.

Standard cPanel cron has one-minute resolution. It cannot guarantee the former
Windows worker's 10-second interval without a continuously running process,
which shared hosting commonly prohibits.

## Localhost setup (Windows and XAMPP)

### Requirements

1. Start MySQL in XAMPP.
2. Confirm `api/config/database.php` points to the local database.
3. Open PowerShell. Administrator access is not required for a manual test.

### Safe configuration check

This verifies PHP CLI, the database connection, timezone, lock path and due-task
calculation. It does not update attendance records or save scheduler state.

```powershell
C:\xampp\php\php.exe C:\xampp\htdocs\3D1.3xxsc\api\scripts\cpanel-attendance-cron.php --check
```

A successful check returns JSON containing:

```json
{
  "ok": true,
  "mode": "check",
  "timezone": "Asia/Manila"
}
```

### Run one real invocation

The following command processes the configured local database once:

```powershell
C:\xampp\php\php.exe C:\xampp\htdocs\3D1.3xxsc\api\scripts\cpanel-attendance-cron.php
```

This is not a dry run. It may generate missing attendance records and change
attendance flags to Pending or Absent when their schedule times require it.

### Simulate cPanel every minute

Use this temporary PowerShell loop. After its first execution, later executions
are aligned to the beginning of each minute (`:00` seconds):

```powershell
while ($true) {
    C:\xampp\php\php.exe C:\xampp\htdocs\3D1.3xxsc\api\scripts\cpanel-attendance-cron.php

    $now = Get-Date
    $millisecondsUntilNextMinute = 60000 - (($now.Second * 1000) + $now.Millisecond)
    Start-Sleep -Milliseconds $millisecondsUntilNextMinute
}
```

Example execution times:

```text
7:04:03 PM  initial execution
7:05:00 PM
7:06:00 PM
7:07:00 PM
```

Keep the PowerShell window open while testing. Press `Ctrl+C` to stop the loop.
This local loop is only a test; cPanel performs the production scheduling.

### Force five-minute work during a manual test

```powershell
C:\xampp\php\php.exe C:\xampp\htdocs\3D1.3xxsc\api\scripts\cpanel-attendance-cron.php --force-five-minute
```

## cPanel website deployment

### 1. Upload the backend

Upload the updated backend, including these files:

```text
scripts/cpanel-attendance-cron.php
scripts/cron_worker_lib.php
config/database.php
```

The full backend should be deployed at the server location routed to:

```text
https://coc-studentinfo.net/tams/api
```

The cron command uses the absolute server filesystem path, not the website URL.
For example, the filesystem path might look like:

```text
/home/CPANEL_USER/public_html/tams/api/scripts/cpanel-attendance-cron.php
```

### 2. Confirm PHP CLI and permissions

Use the PHP CLI path provided by the hosting provider. Common paths include:

```text
/usr/local/bin/php
/usr/bin/php
```

The hosting account must be able to read the backend files and write to:

```text
api/logs/
```

Use normal secure permissions first (commonly `755` for directories and `644`
for files). Do not use `777` unless the hosting provider specifically requires
and approves it.

### 3. Test through cPanel Terminal

Replace the example paths with the real hosting paths.

Safe check:

```bash
/usr/local/bin/php /home/CPANEL_USER/public_html/tams/api/scripts/cpanel-attendance-cron.php --check
```

One real invocation:

```bash
/usr/local/bin/php /home/CPANEL_USER/public_html/tams/api/scripts/cpanel-attendance-cron.php
```

Do not continue to scheduling until the command finishes with `exit_code=0`.

### 4. Create one cPanel Cron Job

Open **cPanel > Cron Jobs** and select **Once Per Minute**, or enter:

```cron
* * * * *
```

Command:

```bash
/usr/local/bin/php /home/CPANEL_USER/public_html/tams/api/scripts/cpanel-attendance-cron.php
```

The five asterisks mean every minute, every hour, every day, every month and
every weekday. Cron targets the beginning of each minute (`:00` seconds). A busy
server may start the process a few seconds late, but the schedule remains fixed
to each minute rather than waiting 60 seconds after the previous run.

After successful verification, cron email/output can be suppressed because the
script already writes its own log:

```bash
/usr/local/bin/php /home/CPANEL_USER/public_html/tams/api/scripts/cpanel-attendance-cron.php >/dev/null 2>&1
```

### 5. Verify automatic execution

Wait at least six minutes, then inspect:

```text
api/logs/academic-attendance-worker.log
api/logs/cpanel-attendance-cron-state.json
```

Successful output includes:

```text
[cPanelCron][AttendanceStatuses] success
[cPanelCron][AttendanceGeneration] success
[cPanelCron][AcademicStatusSync] success
[cPanelCron] stopped exit_code=0
```

Expected behavior:

- `AttendanceStatuses` appears every minute.
- `AttendanceGeneration` appears approximately every five minutes.
- `AcademicStatusSync` appears approximately every five minutes.
- `generated_rows=0` is normal when no attendance records are missing.
- `pending_rows=0` and `auto_absent_rows=0` are normal when no flags are due.

The frontend and website do not need to be open for cron to run.

## Runtime files

The scheduler manages these files under `api/logs/`:

- `academic-attendance-worker.log` - execution results
- `cpanel-attendance-cron.lock` - prevents overlapping runs
- `cpanel-attendance-cron-state.json` - remembers successful task times

Do not manually edit these files while the scheduler is running.

## Troubleshooting

### `Could not open input file`

The PHP script path in the cron command is incorrect. Use the absolute cPanel
filesystem path, not `https://coc-studentinfo.net/...`.

### Database connection error

Verify the production database name, host, username and password in the backend
configuration. Confirm the cPanel database user has access to the database.

### Permission error for lock, state or log file

Make sure the hosting account can write to `api/logs/`.

### Cron runs but attendance does not change

Check `academic-attendance-worker.log`, confirm the active semester dates and
class schedule times, and run the command manually to see its output.

### Duplicate or overlapping executions

Keep only one cPanel Cron Job for `cpanel-attendance-cron.php`. The lock safely
skips a new invocation if the previous one is still running.

## Legacy local utilities

`academic-attendance-worker.php` and `daily-academic-update.php` remain available
for local diagnostics. They are not configured in cPanel and are not required
by the single production Cron Job.
