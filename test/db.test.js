const assert = require("node:assert/strict");
const { test } = require("node:test");
const { translatePostgresQuery } = require("../db");

test("translates SQLite named filters and case-insensitive search for PostgreSQL", () => {
  const result = translatePostgresQuery(`
    SELECT r.id FROM receipts r
    WHERE r.receipt_date >= @from_date
      AND r.si_or_number LIKE @filter_siOrNumber ESCAPE char(92) COLLATE NOCASE
      AND EXISTS (
        SELECT 1 FROM json_each(r.custom_values) custom
        WHERE custom.key = @field_id_9
          AND CAST(custom.value AS TEXT) LIKE @field_value_9 ESCAPE char(92) COLLATE NOCASE
      )
  `, {
    from_date: "2026-01-01",
    filter_siOrNumber: "%or-1%",
    field_id_9: "9",
    field_value_9: "%finance%"
  });

  assert.deepEqual(result.values, ["2026-01-01", "%or-1%", "9", "%finance%"]);
  assert.match(result.query, /LOWER\(r\.si_or_number\) LIKE LOWER\(\$2\) ESCAPE E'\\\\'/);
  assert.match(result.query, /jsonb_each_text\(r\.custom_values::jsonb\)/);
  assert.match(result.query, /LOWER\(CAST\(custom\.value AS TEXT\)\) LIKE LOWER\(\$4\)/);
});

test("translates SQLite positional, insert-ignore, and identity-returning statements", () => {
  const positional = translatePostgresQuery("SELECT id FROM users WHERE id = ? AND username = ? COLLATE NOCASE", [4, "staff"]);
  assert.deepEqual(positional.values, [4, "staff"]);
  assert.equal(positional.query, "SELECT id FROM users WHERE id = $1 AND LOWER(username) = LOWER($2)");

  const ignore = translatePostgresQuery("INSERT OR IGNORE INTO groups (name) VALUES (@name)", { name: "Field Officer" });
  assert.equal(ignore.query, `INSERT INTO "groups" (name) VALUES ($1) ON CONFLICT DO NOTHING`);
  assert.deepEqual(ignore.values, ["Field Officer"]);

  const groups = translatePostgresQuery("SELECT id FROM groups WHERE name = 'System Admin'");
  assert.equal(groups.query, `SELECT id FROM "groups" WHERE name = 'System Admin'`);
});
