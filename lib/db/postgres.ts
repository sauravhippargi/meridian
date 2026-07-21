import { Pool, types, type PoolClient, type QueryResultRow } from 'pg';

// ── Person A: OLTP layer (accounts, deals, themes taxonomy, raw sources). ─────
// Lazy singleton + typed helper layer mirroring clickhouse.ts. Reads from
// POSTGRES_URL (see .env.example — matches Person B's committed env contract,
// NOT DATABASE_URL).

// pg returns NUMERIC (type OID 1700) as a string to preserve arbitrary
// precision. Our money columns (accounts.arr, deals.amount) are typed `number`
// and get denormalized into ClickHouse as numbers, so parse them once here at
// module load — otherwise ARRs surface as strings and silently break sums.
types.setTypeParser(1700, (value) => parseFloat(value));

let pool: Pool | null = null;

export const postgres = (): Pool => {
  if (!pool) {
    const raw = process.env.POSTGRES_URL;
    if (!raw) {
      throw new Error('POSTGRES_URL is not set — copy .env.example to .env.local');
    }
    // ClickHouse-managed Postgres (like most hosted PG) serves a TLS cert that
    // doesn't chain to a public CA. Newer `pg` treats sslmode=require as
    // verify-full AND that URL param overrides an explicit ssl option — so it
    // rejects the cert no matter what. Strip sslmode from the URL and set TLS
    // behavior ourselves: require TLS but skip CA verification (sslmode=disable
    // opts back into local plaintext).
    const u = new URL(raw);
    const sslmode = u.searchParams.get('sslmode');
    u.searchParams.delete('sslmode');
    const ssl = sslmode === 'disable' ? false : { rejectUnauthorized: false };
    pool = new Pool({ connectionString: u.toString(), ssl });
  }
  return pool;
};

// ── Typed helpers ────────────────────────────────────────────────────────────
// Mirrors the ClickHouse helper layer (same QueryResult shape + context-carrying
// error) so both databases share one mental model. Postgres has no per-query
// stats endpoint, so elapsedMs here is measured wall-clock, not server time.

export interface QueryResult<T> {
  data: T[];
  rows: number;
  elapsedMs: number;
}

export class PostgresError extends Error {
  constructor(
    message: string,
    readonly context: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PostgresError';
  }
}

// Count distinct $1..$n placeholders. A reused placeholder ($1 twice) counts once.
const placeholderCount = (sql: string): number => {
  const matches = sql.match(/\$\d+/g);
  return matches ? new Set(matches).size : 0;
};

// Read/write path. Values are ALWAYS bound positionally by pg ($1..$n), never
// string-concatenated. The guard rejects the classic footgun of passing values
// against SQL that has no placeholders — i.e. the value was interpolated
// directly into the string, which is a SQL-injection hole.
export const query = async <T extends QueryResultRow>(
  sql: string,
  values?: unknown[],
): Promise<QueryResult<T>> => {
  if (values && values.length > 0 && placeholderCount(sql) === 0) {
    throw new PostgresError(
      'query() received values but the SQL has no $1..$n placeholders — the ' +
        'value was likely interpolated directly. Parameterize it, e.g. ' +
        'query("... WHERE id = $1", [id]).',
      { sql: sql.slice(0, 200), valueCount: values.length },
    );
  }
  const start = performance.now();
  try {
    const result = await postgres().query<T>(sql, values);
    return {
      data: result.rows,
      rows: result.rowCount ?? result.rows.length,
      elapsedMs: Math.round(performance.now() - start),
    };
  } catch (err) {
    throw new PostgresError(
      'Postgres query failed',
      { sql: sql.slice(0, 200), values },
      { cause: err },
    );
  }
};

// Single-row reads (lookup by PK/unique key). Returns null when there is no row
// so callers branch on null instead of indexing [0] into an empty array.
export const queryOne = async <T extends QueryResultRow>(
  sql: string,
  values?: unknown[],
): Promise<T | null> => {
  const { data } = await query<T>(sql, values);
  return data[0] ?? null;
};

// Runs fn inside BEGIN/COMMIT, rolling back on any throw. For seed writes that
// must land atomically (e.g. an account plus its deals). The callback gets the
// checked-out client — issue statements with client.query("... $1", [...]).
export const withTransaction = async <T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await postgres().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw new PostgresError('Transaction rolled back', {}, { cause: err });
  } finally {
    client.release();
  }
};

// Health check for schema-init and task startup. Returns false rather than
// throwing — mirrors clickhouse.ping().
export const ping = async (): Promise<boolean> => {
  try {
    await postgres().query('SELECT 1');
    return true;
  } catch {
    return false;
  }
};
