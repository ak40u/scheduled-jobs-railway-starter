/**
 * The wrapper the scheduler starts.
 *
 * It runs your command, records what happened, tells you if it broke, and
 * exits - because a cron service that keeps running is a cron service the
 * platform will not start again, and one you pay for around the clock.
 */
import { spawn } from "node:child_process"

import { migrate, pool, reapLostRuns } from "./db.js"
import { notifyFailure } from "./notify.js"

const JOB = process.env.JOB_NAME ?? "job"
const COMMAND = process.env.JOB_COMMAND ?? ""
const TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 15 * 60 * 1000)
const MAX_OUTPUT = Number(process.env.MAX_OUTPUT_BYTES ?? 64 * 1024)
/** A run still marked running after this long was killed without reporting. */
const LOST_AFTER_MINUTES = Number(process.env.LOST_AFTER_MINUTES ?? 60)

if (!COMMAND) {
  console.error("JOB_COMMAND is not set. There is nothing to run.")
  process.exit(1)
}

/**
 * Advisory lock keyed on the job name. The platform already skips a scheduled
 * start while the previous one is running, but a manual redeploy or a second
 * environment does not go through the scheduler - and two copies of a job that
 * moves money or sends mail is the failure worth preventing.
 */
async function withLock<T>(fn: () => Promise<T>): Promise<T | "busy"> {
  const client = await pool.connect()
  try {
    const key = [...JOB].reduce((hash, ch) => (hash * 31 + ch.charCodeAt(0)) | 0, 7)
    const { rows } = await client.query<{ locked: boolean }>(`select pg_try_advisory_lock($1) as locked`, [key])
    if (!rows[0].locked) return "busy"
    try {
      return await fn()
    } finally {
      await client.query(`select pg_advisory_unlock($1)`, [key])
    }
  } finally {
    client.release()
  }
}

function execute(): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", COMMAND], { stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    let timedOut = false

    const append = (chunk: Buffer) => {
      // Kept to a ceiling: a job that prints in a loop must not turn into a
      // row too large to store or a page too large to open.
      if (output.length < MAX_OUTPUT) output += chunk.toString().slice(0, MAX_OUTPUT - output.length)
    }
    child.stdout.on("data", append)
    child.stderr.on("data", append)

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, TIMEOUT_MS)

    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, output, timedOut })
    })
  })
}

async function main() {
  await migrate()
  await reapLostRuns(JOB, LOST_AFTER_MINUTES)

  const outcome = await withLock(async () => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into job_runs (job) values ($1) returning id::text`,
      [JOB],
    )
    const runId = rows[0].id
    const started = Date.now()
    console.log(`[${JOB}] run ${runId} started`)

    const { code, output, timedOut } = await execute()
    const durationMs = Date.now() - started
    const status = timedOut ? "failed" : code === 0 ? "succeeded" : "failed"

    await pool.query(
      `update job_runs set finished_at = now(), duration_ms = $2, exit_code = $3, status = $4, output = $5 where id = $1`,
      [runId, durationMs, code, status, timedOut ? `${output}\n\n[killed after ${TIMEOUT_MS}ms]` : output],
    )

    console.log(`[${JOB}] run ${runId} ${status} in ${durationMs}ms (exit ${code})`)
    if (status === "failed") {
      await notifyFailure({ job: JOB, runId, exitCode: code, durationMs, output, timedOut })
    }
    return { status, code }
  })

  if (outcome === "busy") {
    await pool.query(`insert into job_runs (job, status, finished_at) values ($1, 'skipped', now())`, [JOB])
    console.log(`[${JOB}] previous run still going; this one is skipped`)
    await pool.end()
    process.exit(0)
  }

  await pool.end()
  // The wrapper exits 0 even when the job failed. A cron service carries the
  // platform's default restart policy - on failure, ten times - and passing the
  // job's exit code up would turn one failed run into ten immediate reruns and
  // ten alerts. The real outcome is the row in the history and the message you
  // just received.
  process.exit(0)
}

main().catch(async (error) => {
  console.error("the wrapper itself failed", error)
  await pool.end().catch(() => {})
  process.exit(1)
})
