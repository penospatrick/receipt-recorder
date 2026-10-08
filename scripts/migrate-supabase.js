require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { Pool } = require("pg");

async function main() {
  if (!process.env.SUPABASE_DB_URL) {
    throw new Error("Set SUPABASE_DB_URL in .env to your Supabase PostgreSQL connection string.");
  }

  const dataDirectory = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data"));
  const sqlitePath = path.join(dataDirectory, "receipts.sqlite");
  if (!fs.existsSync(sqlitePath)) throw new Error(`Local SQLite database not found: ${sqlitePath}`);

  const sqlite = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  const postgres = new Pool({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 10000
  });

  try {
    await postgres.query(fs.readFileSync(path.join(__dirname, "..", "supabase-schema.sql"), "utf8"));
    const existing = await postgres.query(`
      SELECT
        (SELECT COUNT(*) FROM public.groups) AS groups,
        (SELECT COUNT(*) FROM public.users) AS users,
        (SELECT COUNT(*) FROM public.receipts) AS receipts,
        (SELECT COUNT(*) FROM public.receipt_fields) AS receipt_fields
    `);
    const populatedTables = Object.entries(existing.rows[0])
      .filter(([, count]) => Number(count) > 0)
      .map(([table]) => table);
    if (populatedTables.length) {
      throw new Error(
        `Supabase already contains data in: ${populatedTables.join(", ")}. ` +
        "For safety, migration only imports into an empty Supabase database."
      );
    }

    const data = {
      groups: sqlite.prepare("SELECT * FROM groups ORDER BY id").all(),
      users: sqlite.prepare("SELECT * FROM users ORDER BY id").all(),
      receipts: sqlite.prepare("SELECT * FROM receipts ORDER BY id").all(),
      receipt_fields: sqlite.prepare("SELECT * FROM receipt_fields ORDER BY id").all()
    };
    await postgres.query("BEGIN");
    try {
      for (const [table, rows] of Object.entries(data)) {
        if (!rows.length) continue;
        const columns = Object.keys(rows[0]);
        const columnSql = columns.map((column) => `"${column}"`).join(", ");
        const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
        const insert = `INSERT INTO public."${table}" (${columnSql}) VALUES (${placeholders})`;
        for (const row of rows) {
          await postgres.query(insert, columns.map((column) => row[column]));
        }
        await postgres.query(
          `SELECT setval(pg_get_serial_sequence('public.${table}', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM public."${table}"), 1), 1), EXISTS (SELECT 1 FROM public."${table}"))`
        );
        console.log(`Migrated ${rows.length} ${table} row(s).`);
      }
      await postgres.query("COMMIT");
    } catch (error) {
      await postgres.query("ROLLBACK");
      throw error;
    }

    console.log("Supabase migration completed. Verify the app and data before removing the local backup.");
  } finally {
    sqlite.close();
    await postgres.end();
  }
}

main().catch((error) => {
  console.error("Supabase migration failed:", error.message);
  process.exitCode = 1;
});
