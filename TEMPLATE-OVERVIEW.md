# Deploy and Host Scheduled Jobs on Railway

A cron job that runs only when it is supposed to, keeps a record of every run — start, duration, exit code, output — and tells you when one fails.

Three services: the job itself, which exists only while it runs; a small page showing the history; and Postgres holding it.

## About Hosting Scheduled Jobs

The scheduling templates already in the catalogue are long-running containers with a cron library inside: one at 524 installs and 60% health, another at 219 and 32%. They stay awake around the clock so that, once a night, they can do thirty seconds of work — and the bill covers all twenty-four hours.

Railway has its own scheduler. It starts the container on your schedule and expects it to exit, which is both cheaper and simpler. What it does not give you is the operational half: no history of what ran, no output kept after the container is gone, and no alert when a run fails. A scheduled task that fails quietly is worse than no scheduled task at all, because you go on believing the work is happening.

This template uses the platform's scheduler and adds the missing half.

## Common Use Cases

- **Nightly maintenance** — a database dump to object storage, expired rows swept, a cache rebuilt.
- **Recurring digests** — the weekly summary email, the daily report, the reminder nobody should have to remember.
- **Pulling from somewhere else** — a feed, an exchange rate, a partner's export, on a schedule rather than on request.

## Dependencies for Scheduled Job Hosting

### Deployment Dependencies

- Node 24 — the wrapper that runs your command and records the result
- Postgres — the run history
- Railway's own cron scheduling; no scheduling library, no always-on container
- [Template source](https://github.com/ak40u/scheduled-jobs-railway-starter)

### Implementation Details

- **The job service exits.** That is what makes it a scheduled job rather than a service you pay for continuously — and a start command that keeps running would silently turn it back into one.
- **Every run is a row** — started, finished, duration, exit code and output, capped at 64 KB so a job printing in a loop cannot produce a row too large to store.
- **The exit code is passed through**, so the platform's own run history and this one agree about whether the job worked.
- **A timeout ends in `SIGKILL`**, because a job that ignores signals is the job a timeout exists for.
- **An advisory lock keyed on the job name.** The platform already skips a scheduled start while the previous one runs, but a manual redeploy does not go through the scheduler — and two copies of a job that sends invoices is the failure worth preventing.
- **A run that never reported back is marked `lost`** after an hour. Otherwise a container the platform replaced mid-run leaves a row stuck at "running", and every later execution is skipped as an overlap.
- **Failure alerts go to a webhook, to Telegram, or both**, and are best-effort: a notification that throws must not turn a failed job into a failed wrapper with no record.
- **The history page is behind a token.** Job output contains whatever your command prints — connection strings, customer names — and is not published.

The repository carries `scripts/verify-schedule.sh`, which waits for the platform's scheduler to fire and then confirms the run was recorded with its output and exit code. This template was published only after that script passed against a deployment created from the template itself.

**Worth knowing about the platform's scheduler:** the shortest interval is five minutes, schedules are UTC, start times drift by a few minutes, and an execution is skipped if the previous one is still running.

## Why Deploy Scheduled Jobs on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying scheduled jobs on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.
