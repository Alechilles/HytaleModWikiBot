import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createPool } from "../src/db/pool.js";

const migrationConfigSchema = z.object({
  DATABASE_URL: z.string().url()
});

async function runMigrations() {
  const config = migrationConfigSchema.parse(process.env);
  const pool = createPool(config.DATABASE_URL);

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const migrationDir = join(process.cwd(), "migrations");
    const files = (await readdir(migrationDir)).filter((file) => file.endsWith(".sql")).sort();

    for (const file of files) {
      const alreadyApplied = await pool.query(`SELECT 1 FROM schema_migrations WHERE id = $1`, [file]);
      if ((alreadyApplied.rowCount ?? 0) > 0) {
        continue;
      }

      const sql = await readFile(join(migrationDir, file), "utf8");
      await pool.query("BEGIN");
      try {
        await pool.query(sql);
        await pool.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [file]);
        await pool.query("COMMIT");
        // eslint-disable-next-line no-console
        console.log(`Applied migration ${file}`);
      } catch (error) {
        await pool.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await pool.end();
  }
}

runMigrations().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
