/**
 * Re-trigger extract-mentions-for-source for any Postgres source whose
 * external_id / deal id is not yet present in ClickHouse mentions.
 *
 * Usage: npx tsx scripts/backfill-extract.ts
 */
import { config } from 'dotenv';
import { join } from 'path';
import { tasks } from '@trigger.dev/sdk';

config({ path: join(process.cwd(), '.env.local') });

const main = async (): Promise<void> => {
  const { query: pg } = await import('../lib/db/postgres');
  const { query: ch } = await import('../lib/db/clickhouse');

  const { data: themes } = await pg<{ id: string; name: string; short_description: string }>(
    'SELECT id, name, short_description FROM themes',
  );

  const covered = await ch<{ source_type: string; source_id: string }>(
    'SELECT DISTINCT source_type, source_id FROM mentions',
  );
  const coveredSet = new Set(covered.data.map((r) => `${r.source_type}:${r.source_id}`));

  const tickets = await pg<{ id: string; external_id: string }>('SELECT id, external_id FROM raw_tickets');
  const transcripts = await pg<{ id: string; external_id: string }>(
    'SELECT id, external_id FROM raw_transcripts',
  );
  const deals = await pg<{ id: string }>(
    "SELECT id FROM deals WHERE status = 'lost' AND blocking_theme_id IS NOT NULL",
  );

  type Payload =
    | { source_type: 'ticket'; source_id: string; themes: typeof themes }
    | { source_type: 'transcript'; source_id: string; themes: typeof themes }
    | { source_type: 'deal_loss'; source_id: string };

  const missing: Payload[] = [];
  for (const t of tickets.data) {
    if (!coveredSet.has(`ticket:${t.external_id}`)) {
      missing.push({ source_type: 'ticket', source_id: t.id, themes });
    }
  }
  for (const t of transcripts.data) {
    if (!coveredSet.has(`transcript:${t.external_id}`)) {
      missing.push({ source_type: 'transcript', source_id: t.id, themes });
    }
  }
  for (const d of deals.data) {
    if (!coveredSet.has(`deal_loss:${d.id}`)) {
      missing.push({ source_type: 'deal_loss', source_id: d.id });
    }
  }

  const byType = missing.reduce<Record<string, number>>((acc, p) => {
    acc[p.source_type] = (acc[p.source_type] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Missing sources to backfill: ${missing.length}`, byType);
  if (missing.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // Longer TTL so queued items don't expire mid-drain.
  const BATCH = 100;
  let triggered = 0;
  for (let i = 0; i < missing.length; i += BATCH) {
    const chunk = missing.slice(i, i + BATCH);
    await tasks.batchTrigger(
      'extract-mentions-for-source',
      chunk.map((payload) => ({
        payload,
        options: { ttl: '1h' },
      })),
    );
    triggered += chunk.length;
    console.log(`  triggered ${triggered}/${missing.length}`);
  }
  console.log(`Done triggering ${triggered}. Monitor with: npx tsx scripts/monitor-extract.ts`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
