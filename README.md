# Scheduled jobs starter for Railway

A cron job that runs only when it is supposed to, keeps a history of every run,
and tells you when one fails.

## Why this exists

The scheduling templates in the catalogue are long-running containers with a
cron library inside them: Node Cron at 524 installs and 60% health, rail-nest at
219 and 32%. They work by staying awake around the clock so that, once a night,
they can do thirty seconds of work — and you pay for all twenty-four hours.

Railway has its own scheduler. It starts the container on your schedule and
expects it to exit. That is cheaper and simpler, and it is what this template
uses. What it does not give you is any of the operational part: no history, no
output kept, no alert when a run fails. So this adds those.

## What you get

- **The job service** runs on a schedule and exits. It is not running — and not
  costing anything — between executions.
- **Every run is recorded**: start, duration, exit code, and the output, in
  Postgres.
- **A history page** you can open, with the output of each run.
- **An alert when a run fails** — to a webhook, to Telegram, or both.
- **An overlap lock**, so two copies of a job that moves money never run at once.

## After deploying

Set `JOB_COMMAND` on the job service to whatever you want run. It is executed
with `/bin/sh -c`, so a pipeline or a script path both work:

```
JOB_COMMAND=node scripts/send-digest.js
JOB_COMMAND=curl -fsS https://example.com/api/rebuild-index
JOB_COMMAND=pg_dump "$DATABASE_URL" | gzip | aws s3 cp - s3://backups/db.sql.gz
```

Set the schedule under **Settings → Cron Schedule** on the job service. The
template ships with `*/5 * * * *` so that the first run is quick to see; change
it to what you actually need.

Open the history page with `?token=…` — the value of `HISTORY_TOKEN`.

## Prove it works

```bash
scripts/verify-schedule.sh https://your-history.up.railway.app 'the-token'
```

It waits for the platform's scheduler to fire, then confirms the run was
recorded with its output and exit code. The wait is the point: anything faster
would prove the code runs, not that the schedule does.

## What the platform's scheduler does and does not do

Worth knowing before you rely on it:

- **The shortest interval is five minutes.** Anything more frequent belongs in a
  process that stays up.
- **Schedules are UTC.** "Three in the morning" is three in the morning in
  London in winter and somewhere else in summer.
- **Start times are approximate** — a few minutes of drift is normal.
- **If the previous run is still going, the next one is skipped.** Good default;
  it also means a job that hangs quietly stops running. The wrapper marks a run
  `lost` after an hour so the next one is not blocked forever.
- **The service must exit.** A start command that keeps running turns your cron
  job into a service you pay for continuously — which is exactly the problem
  this template exists to avoid.
- **A failing job would be restarted ten times** under the platform's default
  restart policy. So the wrapper always exits 0: the failure is in the history
  and in the alert, not in the exit code. The trade is deliberate — the
  platform's own execution list will say the run finished, while the history
  page tells you the truth.

## Configuration

| Variable | Where | Purpose |
|----------|-------|---------|
| `JOB_COMMAND` | job | The command to run. Required |
| `JOB_NAME` | job | Label in the history; use one per job if you add more |
| `JOB_TIMEOUT_MS` | job | Killed with `SIGKILL` after this, default 15 minutes |
| `MAX_OUTPUT_BYTES` | job | Output kept per run, default 64 KB |
| `ALERT_WEBHOOK_URL` | job | POSTed a JSON body with `text` on failure — Slack and Mattermost accept it as is |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | job | Failure alerts to Telegram |
| `HISTORY_TOKEN` | history | Protects the page and the API. At least 16 characters |

## Adding a second job

Duplicate the job service, give it its own `JOB_NAME`, `JOB_COMMAND` and
schedule. They share the history and the lock namespace, so two jobs with
different names never block each other.

## License

MIT
