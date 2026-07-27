/**
 * The history: a page you can open and an endpoint you can poll.
 *
 * This is the always-on half of the template, and it is deliberately tiny - the
 * job itself only exists while it runs.
 */
import express from "express"

import { migrate, pool } from "./db.js"

const port = Number(process.env.PORT ?? 8080)
const token = process.env.HISTORY_TOKEN ?? ""

if (token.length < 16) {
  console.error("HISTORY_TOKEN is missing or shorter than 16 characters. Job output can contain anything; it is not published.")
  process.exit(1)
}

const app = express()
app.disable("x-powered-by")

const escape = (value: string) =>
  value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string)

function authorized(req: express.Request): boolean {
  const header = req.headers.authorization ?? ""
  if (header === `Bearer ${token}`) return true
  // A browser cannot set headers, so the page also accepts ?token=, which is
  // why this service should stay behind a URL you do not hand out.
  return typeof req.query.token === "string" && req.query.token === token
}

async function recentRuns(limit = 50) {
  const { rows } = await pool.query(
    `select id::text, job, started_at, finished_at, duration_ms, exit_code, status, output
     from job_runs order by started_at desc limit $1`,
    [limit],
  )
  return rows
}

app.get("/api/runs", async (req, res) => {
  if (!authorized(req)) {
    res.status(401).json({ error: "unauthorized" })
    return
  }
  res.json({ runs: await recentRuns(Number(req.query.limit ?? 50)) })
})

app.get("/health", async (_req, res) => {
  try {
    await pool.query("select 1")
    res.json({ status: "ok" })
  } catch {
    res.status(503).json({ status: "degraded" })
  }
})

app.get("/", async (req, res) => {
  if (!authorized(req)) {
    res.status(401).type("html").send("<p>Add <code>?token=…</code> to see the run history.</p>")
    return
  }
  const runs = await recentRuns(50)
  const rows = runs
    .map((run) => {
      const colour = { succeeded: "#2ecc71", failed: "#e74c3c", running: "#f39c12", skipped: "#95a5a6", lost: "#8e44ad" }[
        run.status as string
      ]
      const duration = run.duration_ms == null ? "—" : `${(run.duration_ms / 1000).toFixed(1)}s`
      return `<tr>
        <td><span style="color:${colour}">●</span> ${run.status}</td>
        <td>${escape(String(run.job))}</td>
        <td>${new Date(run.started_at).toISOString().replace("T", " ").slice(0, 19)}</td>
        <td>${duration}</td>
        <td>${run.exit_code ?? "—"}</td>
        <td><details><summary>output</summary><pre>${escape(String(run.output ?? ""))}</pre></details></td>
      </tr>`
    })
    .join("")

  res.type("html").send(`<!doctype html>
<meta charset="utf-8"><title>Scheduled jobs</title>
<style>
 body{font:15px/1.5 system-ui,sans-serif;margin:2.5rem auto;max-width:60rem;padding:0 1rem;color-scheme:light dark}
 table{border-collapse:collapse;width:100%} th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #8883;vertical-align:top}
 pre{white-space:pre-wrap;background:#8881;padding:10px;border-radius:6px;max-height:20rem;overflow:auto;margin:6px 0 0}
 summary{cursor:pointer}
</style>
<h1>Scheduled jobs</h1>
<p>${runs.length} most recent runs. This page is the reason the job is worth
scheduling here rather than in a container that never sleeps.</p>
<table><thead><tr><th>status</th><th>job</th><th>started (UTC)</th><th>took</th><th>exit</th><th></th></tr></thead>
<tbody>${rows || `<tr><td colspan="6">Nothing has run yet.</td></tr>`}</tbody></table>`)
})

async function main() {
  await migrate()
  const server = app.listen(port, () => console.log(`history listening on ${port}`))
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => server.close(() => void pool.end().then(() => process.exit(0))))
  }
}

main().catch((error) => {
  console.error("history failed to start", error)
  process.exit(1)
})
