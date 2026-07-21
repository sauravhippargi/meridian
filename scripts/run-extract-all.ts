/**
 * Truncate ClickHouse mentions, then trigger extract-all-mentions.
 * Usage: npx tsx scripts/run-extract-all.ts
 */
import { config } from 'dotenv';
import { join } from 'path';
import { tasks, runs } from '@trigger.dev/sdk';

config({ path: join(process.cwd(), '.env.local') });

const main = async (): Promise<void> => {
  const { clickhouse, query: chQuery } = await import('../lib/db/clickhouse');

  const before = await chQuery<{ c: string }>('SELECT count() AS c FROM mentions');
  console.log(`mentions before truncate: ${before.data[0]?.c}`);

  await clickhouse().command({ query: 'TRUNCATE TABLE IF EXISTS mentions' });
  // Also clear the MV target so daily scores don't double-count on re-extract.
  await clickhouse().command({ query: 'TRUNCATE TABLE IF EXISTS theme_scores_daily' }).catch(() => {
    // MV target table name may differ; non-fatal.
  });

  const after = await chQuery<{ c: string }>('SELECT count() AS c FROM mentions');
  console.log(`mentions after truncate: ${after.data[0]?.c}`);

  console.log('Triggering extract-all-mentions…');
  const handle = await tasks.trigger('extract-all-mentions', {});
  console.log(`run id: ${handle.id}`);
  console.log('Polling orchestrator (child tasks continue after it returns)…');

  const run = await runs.poll(handle.id, { pollIntervalMs: 3_000 });
  console.log(`orchestrator status=${run.status} output=${JSON.stringify(run.output)}`);
  if (run.status !== 'COMPLETED') {
    console.error(JSON.stringify(run.error, null, 2));
    process.exit(1);
  }
  console.log(
    'Orchestrator done — child extract-mentions-for-source runs are still draining.',
  );
  console.log('Monitor with: npx tsx scripts/monitor-extract.ts');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
