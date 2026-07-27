/**
 * Telling someone the job broke.
 *
 * A scheduled task that fails quietly is worse than no scheduled task: you
 * believe the work is happening. Configure a webhook and you find out the same
 * minute instead of the same quarter.
 */
const WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL ?? ""
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? ""
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? ""

export interface Failure {
  job: string
  runId: string
  exitCode: number | null
  durationMs: number
  output: string
  timedOut: boolean
}

function summarize(failure: Failure): string {
  const reason = failure.timedOut ? "timed out" : `exited with ${failure.exitCode}`
  const tail = failure.output.trim().split("\n").slice(-12).join("\n")
  return `Job "${failure.job}" ${reason} after ${Math.round(failure.durationMs / 1000)}s (run ${failure.runId})` +
    (tail ? `\n\n${tail}` : "")
}

export async function notifyFailure(failure: Failure): Promise<void> {
  const text = summarize(failure)

  // Two channels, both optional, both best-effort: a notification that throws
  // must not turn a failed job into a failed wrapper with no record at all.
  const attempts: Promise<unknown>[] = []

  if (WEBHOOK_URL) {
    attempts.push(
      fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // `text` suits Slack and Mattermost; the rest is there for anything else.
        body: JSON.stringify({ text, job: failure.job, run_id: failure.runId, exit_code: failure.exitCode }),
      }),
    )
  }

  if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    attempts.push(
      fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
      }),
    )
  }

  if (attempts.length === 0) {
    console.warn("job failed and no alert channel is configured")
    return
  }

  const results = await Promise.allSettled(attempts)
  for (const result of results) {
    if (result.status === "rejected") console.error("alert delivery failed", result.reason)
  }
}
