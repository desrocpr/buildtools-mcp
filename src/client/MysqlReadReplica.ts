/**
 * Read-only MySQL replica access for fields the BuildTools dashboard
 * HTML doesn't render.
 *
 * Background: the public-facing /selections grid only carries status,
 * category, location, item, price (no dates). The underlying
 * `selections` table on the AWS RDS read replica DOES have
 * `created_at`, `updated_at`, `approved_date`, `rejected_date`,
 * `due_date`. Power BI already consumes this replica via the same
 * credentials, so this is well-trodden ground.
 *
 * Scope: STRICTLY READ-ONLY. The replica is fronted by RDS in
 * read-replica mode, but we additionally guard the connection by
 * exposing only narrow query helpers (no raw .query() pass-through)
 * so the surface can't drift into DML.
 *
 * Lifecycle: lazy singleton pool. Created on first call from any
 * tool dispatcher; reused across requests. Pool is small (5
 * connections) because BuildTools tool calls fan out shallow.
 */

import mysql from "mysql2/promise";

let pool: mysql.Pool | null = null;
let loadAttempted = false;
let loadError: Error | null = null;

function loadPool(): mysql.Pool | null {
  if (loadAttempted) {
    return pool;
  }
  loadAttempted = true;
  const env = process.env;
  if (!env.MYSQL_HOST || !env.MYSQL_USER || !env.MYSQL_PASSWORD || !env.MYSQL_DATABASE) {
    loadError = new Error(
      "MySQL replica unavailable: set MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE",
    );
    return null;
  }
  try {
    pool = mysql.createPool({
      host: env.MYSQL_HOST,
      port: Number(env.MYSQL_PORT ?? 3306),
      user: env.MYSQL_USER,
      password: env.MYSQL_PASSWORD,
      database: env.MYSQL_DATABASE,
      connectionLimit: 5,
      waitForConnections: true,
      // We never write — but assert anyway.
      multipleStatements: false,
      // 10 second cap on slow queries; tool calls timeout faster than that.
      connectTimeout: 5_000,
    });
  } catch (err) {
    loadError = err as Error;
  }
  return pool;
}

/**
 * Lifecycle dates for selections on a project. Field names are
 * normalised to camelCase strings (ISO-style `YYYY-MM-DD`) or null.
 */
export interface SelectionDates {
  createdAt: string | null;
  updatedAt: string | null;
  approvedDate: string | null;
  rejectedDate: string | null;
  dueDate: string | null;
}

function toIsoDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "string" && value.length >= 10) {
    return value.slice(0, 10);
  }
  return null;
}

/**
 * Fetch lifecycle dates for every selection on a project. Returns a
 * Map keyed by selection id (string for caller convenience — the
 * BuildTools HTML parser also yields ids as strings). Returns an
 * empty map (not null) when the replica is unavailable — callers
 * should treat absence as "dates not available" and continue.
 */
export async function getSelectionDates(
  projectId: number | string,
): Promise<Map<string, SelectionDates>> {
  const p = loadPool();
  if (!p) return new Map();
  try {
    const [rows] = await p.execute(
      `SELECT id, created_at, updated_at, approved_date, rejected_date, due_date
       FROM selections
       WHERE project_id = ?`,
      [Number(projectId)],
    );
    const out = new Map<string, SelectionDates>();
    for (const row of rows as Array<{
      id: number;
      created_at: unknown;
      updated_at: unknown;
      approved_date: unknown;
      rejected_date: unknown;
      due_date: unknown;
    }>) {
      out.set(String(row.id), {
        createdAt: toIsoDate(row.created_at),
        updatedAt: toIsoDate(row.updated_at),
        approvedDate: toIsoDate(row.approved_date),
        rejectedDate: toIsoDate(row.rejected_date),
        dueDate: toIsoDate(row.due_date),
      });
    }
    return out;
  } catch (err) {
    process.stderr.write(
      `[mysql-replica] getSelectionDates failed: ${(err as Error)?.message ?? err}\n`,
    );
    return new Map();
  }
}

/**
 * Test the connection. Returns true on success; logs and returns false
 * otherwise. For health checks / startup smoke.
 */
export async function pingReplica(): Promise<boolean> {
  const p = loadPool();
  if (!p) {
    process.stderr.write(
      `[mysql-replica] not configured: ${loadError?.message ?? "unknown"}\n`,
    );
    return false;
  }
  try {
    const [rows] = await p.execute("SELECT 1 AS ok");
    return Array.isArray(rows) && rows.length > 0;
  } catch (err) {
    process.stderr.write(
      `[mysql-replica] ping failed: ${(err as Error)?.message ?? err}\n`,
    );
    return false;
  }
}
