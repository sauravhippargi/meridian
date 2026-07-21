/**
 * Smoke-test extractMentionsForSource against one real id per source type.
 * Verifies schema, account joins, and ClickHouse insert via the Trigger task
 * (or direct pipeline fallback with --direct).
 *
 * Usage:
 *   npx tsx scripts/smoke-extract.ts
 *   npx tsx scripts/smoke-extract.ts --direct
 */
import { config } from 'dotenv';
import { resolve, join } from 'node:path';
import { tasks, runs } from '@trigger.dev/sdk';

const repoRoot = resolve(__dirname, '..');
config({ path: join(repoRoot, '.env.local') });

const useDirect = process.argv.includes('--direct');

const main = async (): Promise<void> => {
  // Dynamic imports after dotenv so POSTGRES_URL / CLICKHOUSE_* are set.
  const { query: pgQuery } = await import('../lib/db/postgres');
  const { query: chQuery } = await import('../lib/db/clickhouse');

  const [{ data: tickets }, { data: transcripts }, { data: deals }, { data: themes }] =
    await Promise.all([
      pgQuery<{ id: string }>('SELECT id FROM raw_tickets ORDER BY opened_at LIMIT 1'),
      pgQuery<{ id: string }>('SELECT id FROM raw_transcripts ORDER BY interview_date LIMIT 1'),
      pgQuery<{ id: string }>(
        "SELECT id FROM deals WHERE status = 'lost' AND blocking_theme_id IS NOT NULL ORDER BY close_date LIMIT 1",
      ),
      pgQuery<{ id: string; name: string; short_description: string }>(
        'SELECT id, name, short_description FROM themes',
      ),
    ]);

  const ticketId = tickets[0]?.id;
  const transcriptId = transcripts[0]?.id;
  const dealId = deals[0]?.id;
  if (!ticketId || !transcriptId || !dealId) {
    throw new Error(
      `Missing smoke sources — tickets=${tickets.length} transcripts=${transcripts.length} deals=${deals.length}`,
    );
  }

  console.log('Smoke sources:');
  console.log(`  ticket:     ${ticketId}`);
  console.log(`  transcript: ${transcriptId}`);
  console.log(`  deal_loss:  ${dealId}`);
  console.log(`  themes:     ${themes.length}`);

  const before = await chQuery<{ c: string }>('SELECT count() AS c FROM mentions');
  const beforeCount = Number(before.data[0]?.c ?? 0);
  console.log(`\nClickHouse mentions before: ${beforeCount}`);

  if (useDirect) {
    const {
      extractMentionsForTicket,
      extractMentionsForTranscript,
      buildMentionForDealLoss,
    } = await import('../lib/extraction/pipeline');
    const { insertBatch } = await import('../lib/db/clickhouse');

    console.log('\n[--direct] Running pipeline functions locally…');
    const ticketMentions = await extractMentionsForTicket(ticketId, themes);
    console.log(`  ticket → ${ticketMentions.length} mentions`);
    const transcriptMentions = await extractMentionsForTranscript(transcriptId, themes);
    console.log(`  transcript → ${transcriptMentions.length} mentions`);
    const dealMention = await buildMentionForDealLoss(dealId);
    console.log(`  deal_loss → 1 mention (theme=${dealMention.theme_id})`);

    const all = [...ticketMentions, ...transcriptMentions, dealMention];
    const result = await insertBatch('mentions', all);
    console.log(`  inserted: ${result.inserted}`);
  } else {
    if (!process.env.TRIGGER_SECRET_KEY) {
      throw new Error('TRIGGER_SECRET_KEY missing — cannot trigger via SDK');
    }
    console.log('\nTriggering extract-mentions-for-source via Trigger.dev…');

    const payloads = [
      { source_type: 'ticket' as const, source_id: ticketId, themes },
      { source_type: 'transcript' as const, source_id: transcriptId, themes },
      { source_type: 'deal_loss' as const, source_id: dealId },
    ];

    for (const payload of payloads) {
      console.log(`  → ${payload.source_type} ${payload.source_id}`);
      const handle = await tasks.trigger('extract-mentions-for-source', payload);
      const run = await runs.poll(handle.id, { pollIntervalMs: 1_500 });
      if (run.status !== 'COMPLETED') {
        console.error('  FAILED:', JSON.stringify(run, null, 2));
        throw new Error(`Task ${run.status} for ${payload.source_type}`);
      }
      const output = run.output as { inserted: number } | undefined;
      console.log(`  ✓ inserted=${output?.inserted ?? '?'}`);
    }
  }

  const after = await chQuery<{ c: string }>('SELECT count() AS c FROM mentions');
  const afterCount = Number(after.data[0]?.c ?? 0);
  console.log(`\nClickHouse mentions after: ${afterCount} (delta=${afterCount - beforeCount})`);

  const sample = await chQuery<{
    mention_id: string;
    theme_id: string;
    source_type: string;
    source_id: string;
    account_segment: string;
    account_arr: number;
    severity: number;
    verbatim_snippet: string;
  }>(
    `SELECT mention_id, theme_id, source_type, source_id, account_segment, account_arr, severity, verbatim_snippet
     FROM mentions
     ORDER BY extracted_at DESC
     LIMIT 20`,
  );

  console.log('\nLatest mentions (spot-check):');
  for (const row of sample.data) {
    console.log(
      `  [${row.source_type}] ${row.theme_id} sev=${row.severity} arr=${row.account_arr} seg=${row.account_segment}`,
    );
    console.log(`    snippet: ${row.verbatim_snippet.slice(0, 120)}`);
  }

  if (afterCount <= beforeCount) {
    throw new Error('No new mentions landed in ClickHouse — smoke test FAILED');
  }
  console.log('\nSMOKE TEST PASSED');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
