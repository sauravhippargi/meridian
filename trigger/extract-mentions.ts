import { task } from '@trigger.dev/sdk/v3';
import { query } from '@/lib/db/postgres';
import { insertBatch } from '@/lib/db/clickhouse';
import {
  extractMentionsForTicket,
  extractMentionsForTranscript,
  buildMentionForDealLoss,
  listPendingTicketIds,
  listPendingTranscriptIds,
  listPendingDealLossIds,
} from '@/lib/extraction/pipeline';
import type { ThemeTaxonomyItem } from '@/lib/extraction/schema';
import type { Mention } from '@/types/mention';

// NOTE: written against the @trigger.dev/sdk v3 task()/batchTrigger API from
// trigger.config.ts + package.json (^3.3.0). Not yet run against a live
// Trigger.dev dev server (TRIGGER_PROJECT_REF is still a placeholder) — the
// underlying lib/extraction/pipeline.ts logic IS verified against live
// Postgres, but this orchestration layer itself is unverified. Run
// `npx trigger.dev@latest dev` once TRIGGER_PROJECT_REF/SECRET_KEY are set and
// smoke-test extractMentionsForSource on a single id before the full batch.

type SourcePayload =
  | { source_type: 'ticket'; source_id: string; themes: ThemeTaxonomyItem[] }
  | { source_type: 'transcript'; source_id: string; themes: ThemeTaxonomyItem[] }
  | { source_type: 'deal_loss'; source_id: string };

// Per-source unit of work — the batchTrigger fan-out target. Inserts directly
// to ClickHouse rather than returning mentions, so 5,000 runs stay independent
// (one failure/retry doesn't hold up an orchestrator collecting results).
export const extractMentionsForSource = task({
  id: 'extract-mentions-for-source',
  run: async (payload: SourcePayload): Promise<{ inserted: number }> => {
    let mentions: Mention[];
    if (payload.source_type === 'deal_loss') {
      mentions = [await buildMentionForDealLoss(payload.source_id)];
    } else if (payload.source_type === 'ticket') {
      mentions = await extractMentionsForTicket(payload.source_id, payload.themes);
    } else {
      mentions = await extractMentionsForTranscript(payload.source_id, payload.themes);
    }
    return insertBatch('mentions', mentions);
  },
});

// Orchestrator — enumerates every raw source not yet processed and fans out via
// batchTrigger. Idempotency note: reruns will re-extract and re-insert (mentions
// has no unique constraint on source_id), so this is safe to run once per fresh
// generation but NOT safe to blindly rerun on top of existing mentions without
// a dedup/truncate step first.
export const extractAllMentions = task({
  id: 'extract-all-mentions',
  run: async (): Promise<{ triggered: number }> => {
    const { data: themes } = await query<ThemeTaxonomyItem>(
      'SELECT id, name, short_description FROM themes',
    );
    const [ticketIds, transcriptIds, dealLossIds] = await Promise.all([
      listPendingTicketIds(),
      listPendingTranscriptIds(),
      listPendingDealLossIds(),
    ]);

    const payloads: SourcePayload[] = [
      ...ticketIds.map((id): SourcePayload => ({ source_type: 'ticket', source_id: id, themes })),
      ...transcriptIds.map((id): SourcePayload => ({ source_type: 'transcript', source_id: id, themes })),
      ...dealLossIds.map((id): SourcePayload => ({ source_type: 'deal_loss', source_id: id })),
    ];

    await extractMentionsForSource.batchTrigger(payloads.map((payload) => ({ payload })));
    return { triggered: payloads.length };
  },
});
