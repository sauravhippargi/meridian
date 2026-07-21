import { schedules, task } from '@trigger.dev/sdk';
import { query as pgQuery } from '@/lib/db/postgres';
import { clickhouse, query as chQuery } from '@/lib/db/clickhouse';

/**
 * OLTP → OLAP sync: propagate mutable account fields (ARR, segment) from
 * Postgres into denormalized columns on ClickHouse `mentions`. Keeps
 * ARR-weighted aggregations current without re-extracting.
 */

interface AccountRow {
  id: string;
  arr: number;
  segment: 'enterprise' | 'mid_market' | 'smb';
}

const syncAccounts = async (
  sinceHours: number,
): Promise<{ accounts_checked: number; mentions_touched: number }> => {
  const { data: accounts } = await pgQuery<AccountRow>(
    `SELECT id, arr, segment
     FROM accounts
     WHERE updated_at >= NOW() - make_interval(hours => $1::int)`,
    [sinceHours],
  );

  if (accounts.length === 0) {
    return { accounts_checked: 0, mentions_touched: 0 };
  }

  let mentionsTouched = 0;
  for (const acct of accounts) {
    const before = await chQuery<{ c: string }>(
      `SELECT count() AS c FROM mentions WHERE account_id = {id:UUID}`,
      { id: acct.id },
    );
    const n = Number(before.data[0]?.c ?? 0);
    if (n === 0) continue;

    await clickhouse().command({
      query: `
        ALTER TABLE mentions
        UPDATE
          account_arr = {arr:Float64},
          account_segment = {segment:String}
        WHERE account_id = {id:UUID}
      `,
      query_params: {
        arr: acct.arr,
        segment: acct.segment,
        id: acct.id,
      },
    });
    mentionsTouched += n;
  }

  return { accounts_checked: accounts.length, mentions_touched: mentionsTouched };
};

export const syncOltpToOlap = task({
  id: 'sync-oltp-to-olap',
  maxDuration: 300,
  run: async (payload: { sinceHours?: number } = {}) =>
    syncAccounts(payload.sinceHours ?? 24),
});

/** Hourly cron — keeps ClickHouse ARR/segment aligned with Postgres. */
export const syncOltpToOlapHourly = schedules.task({
  id: 'sync-oltp-to-olap-hourly',
  cron: '0 * * * *',
  run: async () => syncAccounts(2),
});
