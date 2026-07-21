/**
 * Poll ClickHouse mention counts + theme distribution until extraction settles.
 * Usage: npx tsx scripts/monitor-extract.ts
 */
import { config } from 'dotenv';
import { join } from 'path';

config({ path: join(process.cwd(), '.env.local') });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const main = async (): Promise<void> => {
  const { query: chQuery } = await import('../lib/db/clickhouse');

  let prev = -1;
  let stableRounds = 0;
  for (let i = 0; i < 240; i++) {
    const total = await chQuery<{ c: string }>('SELECT count() AS c FROM mentions');
    const byTheme = await chQuery<{ theme_id: string; c: string; arr: number }>(
      `SELECT theme_id, count() AS c, sum(account_arr) AS arr
       FROM mentions
       GROUP BY theme_id
       ORDER BY c DESC`,
    );
    const bySource = await chQuery<{ source_type: string; c: string }>(
      `SELECT source_type, count() AS c FROM mentions GROUP BY source_type ORDER BY c DESC`,
    );
    const count = Number(total.data[0]?.c ?? 0);
    const ts = new Date().toISOString().slice(11, 19);
    console.log(
      `\n[${ts}] mentions=${count}  sources=${bySource.data.map((r) => `${r.source_type}:${r.c}`).join(' ')}`,
    );
    for (const row of byTheme.data) {
      console.log(`  ${row.theme_id.padEnd(28)} n=${String(row.c).padStart(5)}  arr_sum=${Math.round(row.arr)}`);
    }

    if (count === prev && count > 0) {
      stableRounds += 1;
      if (stableRounds >= 4) {
        console.log('\nCount stable for 4 polls — extraction appears complete.');
        break;
      }
    } else {
      stableRounds = 0;
    }
    prev = count;
    await sleep(15_000);
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
