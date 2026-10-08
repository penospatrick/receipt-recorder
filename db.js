const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { Pool, types } = require("pg");

types.setTypeParser(20, (value) => Number(value));

const sqliteSchema = `
  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    permissions_json TEXT NOT NULL,
    is_system INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    group_id INTEGER NOT NULL REFERENCES groups(id),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_date TEXT NOT NULL,
    si_or_number TEXT NOT NULL,
    particulars TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    custom_values TEXT NOT NULL DEFAULT '{}',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by_name TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS receipt_fields (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    field_type TEXT NOT NULL,
    required INTEGER NOT NULL DEFAULT 0,
    options_json TEXT NOT NULL DEFAULT '[]',
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS receipts_date_idx ON receipts(receipt_date DESC, id DESC);
  CREATE INDEX IF NOT EXISTS receipts_created_by_idx ON receipts(created_by, receipt_date DESC);
`;

function translatePostgresQuery(sql, parameters) {
  let query = sql;
  let values;
  if (Array.isArray(parameters)) {
    values = parameters;
    let index = 0;
    query = query.replace(/\?/g, () => `$${++index}`);
  } else {
    const names = [];
    query = query.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name) => {
      names.push(name);
      return `$${names.length}`;
    });
    values = names.map((name) => {
      if (!Object.hasOwn(parameters || {}, name)) {
        throw new Error(`Missing database parameter "${name}".`);
      }
      return parameters[name];
    });
  }

  query = query.replace(
    /\b([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(\$\d+)\s+COLLATE NOCASE\b/gi,
    "LOWER($1) = LOWER($2)"
  );
  query = query.replace(
    /(\b[A-Za-z_][A-Za-z0-9_.]*\b|CAST\([A-Za-z_][A-Za-z0-9_.]*\s+AS\s+TEXT\))\s+LIKE\s+(\$\d+)\s+ESCAPE char\(92\)\s+COLLATE NOCASE/gi,
    "LOWER($1) LIKE LOWER($2) ESCAPE E'\\\\'"
  );
  query = query.replace(
    /\b([A-Za-z_][A-Za-z0-9_.]*)\s+COLLATE NOCASE\b/gi,
    "LOWER($1)"
  );
  query = query.replace(
    /json_each\(r\.custom_values\)/gi,
    "jsonb_each_text(r.custom_values::jsonb)"
  );
  query = query.replace(/\bgroups\b/gi, '"groups"');

  const ignoreConflict = /^\s*INSERT\s+OR\s+IGNORE\b/i.test(query);
  query = query.replace(/^\s*INSERT\s+OR\s+IGNORE\b/i, "INSERT");
  if (ignoreConflict) query = `${query.trimEnd()} ON CONFLICT DO NOTHING`;
  return { query, values };
}

class ReceiptDatabase {
  constructor() {
    this.connectionString = process.env.SUPABASE_DB_URL;
    this.remote = Boolean(this.connectionString);
    if (this.remote) {
      this.pool = new Pool({
        connectionString: this.connectionString,
        ssl: { rejectUnauthorized: true },
        max: Number(process.env.DB_POOL_MAX || 10),
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000
      });
      this.pool.on("error", (error) => {
        console.error("Unexpected Supabase database connection error:", error);
      });
      this.database = this.pool;
    } else {
      const dataDirectory = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
      fs.mkdirSync(dataDirectory, { recursive: true });
      this.sqlitePath = path.join(dataDirectory, "receipts.sqlite");
      this.database = new Database(this.sqlitePath);
      this.database.pragma("journal_mode = WAL");
      this.database.pragma("foreign_keys = ON");
    }
  }

  async initialize() {
    if (this.remote) {
      const schema = fs.readFileSync(path.join(__dirname, "supabase-schema.sql"), "utf8");
      await this.pool.query(schema);
    } else {
      this.database.exec(sqliteSchema);
      const existingColumns = this.database.pragma("table_info(receipts)");
      const migrations = [
        ["custom_values", "TEXT NOT NULL DEFAULT '{}'"],
        ["created_by", "INTEGER REFERENCES users(id) ON DELETE SET NULL"],
        ["created_by_name", "TEXT"],
        ["updated_at", "TEXT"]
      ];
      for (const [name, declaration] of migrations) {
        if (!existingColumns.some((column) => column.name === name)) {
          this.database.exec(`ALTER TABLE receipts ADD COLUMN ${name} ${declaration}`);
        }
      }
    }
  }

  pragma() {
    if (!this.remote) return this.database.pragma(...arguments);
    return [];
  }

  exec(sql) {
    if (!this.remote) return this.database.exec(sql);
    return this.pool.query(sql);
  }

  prepare(sql) {
    if (!this.remote) return this.database.prepare(sql);
    const parametersForQuery = (parameters) => {
      if (parameters.length === 1 && Array.isArray(parameters[0])) return parameters[0];
      if (parameters.length === 1 && parameters[0] && typeof parameters[0] === "object") {
        return parameters[0];
      }
      return parameters;
    };
    return {
      get: async (...parameters) => {
        const { query, values } = translatePostgresQuery(sql, parametersForQuery(parameters));
        const result = await this.pool.query(query, values);
        return result.rows[0];
      },
      all: async (...parameters) => {
        const { query, values } = translatePostgresQuery(sql, parametersForQuery(parameters));
        const result = await this.pool.query(query, values);
        return result.rows;
      },
      run: async (...parameters) => {
        const { query, values } = translatePostgresQuery(sql, parametersForQuery(parameters));
        const statement = query.trimEnd();
        const isInsert = /^\s*INSERT\b/i.test(statement);
        const insertHasReturning = /\bRETURNING\b/i.test(statement);
        const result = await this.pool.query(
          isInsert && !insertHasReturning ? `${statement} RETURNING id` : statement,
          values
        );
        return {
          changes: result.rowCount,
          lastInsertRowid: result.rows[0]?.id
        };
      }
    };
  }

  async transaction(operation) {
    if (!this.remote) {
      return this.database.transaction(operation)();
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation({
        query: (sql, parameters = []) => {
          const translated = translatePostgresQuery(sql, parameters);
          return client.query(translated.query, translated.values);
        }
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    if (this.remote) await this.pool.end();
    else this.database.close();
  }
}

module.exports = { ReceiptDatabase, translatePostgresQuery };
