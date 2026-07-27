/**
 * Where the history lives.
 *
 * The point of this template is that a scheduled job leaves a trace. Postgres
 * holds one row per run - when it started, how long it took, what it printed,
 * and whether it worked.
 */
import { Pool } from "pg"

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 4),
  connectionTimeoutMillis: 10_000,
})

const SCHEMA = `
create table if not exists job_runs (
  id            bigserial primary key,
  job           text not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  duration_ms   integer,
  exit_code     integer,
  status        text not null default 'running'
                check (status in ('running', 'succeeded', 'failed', 'skipped', 'lost')),
  output        text,
  created_at    timestamptz not null default now()
);

create index if not exists job_runs_job_started_idx on job_runs (job, started_at desc);
`

export async function migrate(): Promise<void> {
  await pool.query(SCHEMA)
}

/**
 * A run that started and never reported back - the container was replaced, or
 * the platform stopped it - would otherwise sit as "running" forever and block
 * the next execution. Anything older than the timeout is marked lost.
 */
export async function reapLostRuns(job: string, timeoutMinutes: number): Promise<void> {
  await pool.query(
    `update job_runs set status = 'lost', finished_at = now()
     where job = $1 and status = 'running' and started_at < now() - ($2 || ' minutes')::interval`,
    [job, String(timeoutMinutes)],
  )
}
