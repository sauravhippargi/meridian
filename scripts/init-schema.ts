import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from '@clickhouse/client';
import { postgres, ping as pgPing } from '../lib/db/postgres';
import { clickhouse } from '../lib/db/clickhouse';

// Standalone tsx script — load .env.local explicitly so POSTGRES_URL and the
// ClickHouse credentials are picked up (tsx does not auto-load env files).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
config({ path: join(repoRoot, '.env.local') });

const readSql = (name: string): string => readFileSync(join(repoRoot, 'lib', 'db', name), 'utf8');
const countMatches = (text: string, re: RegExp): number => (text.match(re) ?? []).length;

// Close every client best-effort; each getter throws if its env var is unset,
// so guard the teardown to keep it from masking the real error.
const closeAll = async (): Promise<void> => {
  try {
    await postgres().end();
  } catch {
    /* pool never initialized */
  }
  try {
    await clickhouse().close();
  } catch {
    /* client never initialized */
  }
};

const main = async (): Promise<void> => {
  const pgSql = readSql('schema.postgres.sql');
  const chSql = readSql('schema.clickhouse.sql');

  // ── Connectivity: ping both before touching anything. ──────────────────────
  console.log('Pinging Postgres…');
  if (!(await pgPing())) {
    throw new Error('Postgres ping failed — check POSTGRES_URL in .env.local');
  }

  const chUrl = process.env.CLICKHOUSE_URL;
  if (!chUrl) throw new Error('CLICKHOUSE_URL is not set — copy .env.example to .env.local');
  const chDatabase = process.env.CLICKHOUSE_DATABASE ?? 'meridian';

  // Bootstrap client scoped to the always-present `default` DB, so we can create
  // the target DB before the meridian-scoped singleton ever connects to it.
  const bootstrap = createClient({
    url: chUrl,
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
    database: 'default',
  });
  console.log('Pinging ClickHouse…');
  const chPing = await bootstrap.ping();
  if (!chPing.success) {
    await bootstrap.close();
    throw new Error('ClickHouse ping failed — check CLICKHOUSE_URL / credentials in .env.local');
  }

  // ── Postgres: whole-file execution (handles $$-quoted DO/function blocks). ──
  console.log('Applying schema.postgres.sql…');
  await postgres().query(pgSql);

  // ── ClickHouse: ensure DB exists, then apply statement-by-statement. ───────
  console.log(`Ensuring ClickHouse database "${chDatabase}"…`);
  await bootstrap.command({ query: `CREATE DATABASE IF NOT EXISTS ${chDatabase}` });
  await bootstrap.close();

  console.log('Applying schema.clickhouse.sql…');
  // Strip `--` line comments BEFORE splitting on ';' — comment prose can contain
  // semicolons, which would otherwise split mid-comment and yield comment-only
  // chunks that ClickHouse rejects as "Empty query". DDL here never uses `--`
  // inside a string literal, so line-wise stripping is safe.
  const statements = chSql
    .split('\n')
    .map((line) => {
      const i = line.indexOf('--');
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const statement of statements) {
    await clickhouse().command({ query: statement });
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const pgTables = countMatches(pgSql, /CREATE TABLE IF NOT EXISTS/gi);
  const pgTriggers = countMatches(pgSql, /CREATE TRIGGER/gi);
  const pgEnums = countMatches(pgSql, /CREATE TYPE/gi);
  const chTables = countMatches(chSql, /CREATE TABLE IF NOT EXISTS/gi);
  const chViews = countMatches(chSql, /CREATE MATERIALIZED VIEW/gi);

  console.log('\n✅ Schema applied.');
  console.log(`   Postgres:   ${pgTables} tables + ${pgTriggers} triggers + ${pgEnums} enums applied.`);
  console.log(
    `   ClickHouse: ${chTables} table${chTables === 1 ? '' : 's'} + ${chViews} materialized view${chViews === 1 ? '' : 's'} applied.`,
  );
};

main()
  .then(async () => {
    await closeAll();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('❌ Schema init failed:', err instanceof Error ? err.message : err);
    await closeAll();
    process.exit(1);
  });
