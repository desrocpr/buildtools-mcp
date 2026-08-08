// Ad-hoc BuildTools replica probe. Usage: doppler run -p moss-pipeline -c prd -- npx tsx bt-probe.ts <file-with-queries.json>
import mysql from 'mysql2/promise'
import { readFileSync } from 'fs'

const queries: { name: string; sql: string }[] = JSON.parse(readFileSync(process.argv[2], 'utf8'))

const conn = await mysql.createConnection({
  host: process.env.BUILDTOOLS_DB_HOST,
  port: Number(process.env.BUILDTOOLS_DB_PORT || 3306),
  user: process.env.BUILDTOOLS_DB_USER,
  password: process.env.BUILDTOOLS_DB_PASSWORD,
  database: process.env.BUILDTOOLS_DB_NAME,
})

for (const q of queries) {
  console.log(`\n===== ${q.name} =====`)
  try {
    const [rows] = await conn.query(q.sql)
    console.log(JSON.stringify(rows, null, 1))
  } catch (e) {
    console.log(`ERROR: ${(e as Error).message}`)
  }
}
await conn.end()
