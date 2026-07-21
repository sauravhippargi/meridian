import { task, queue } from '@trigger.dev/sdk';
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

// Cap concurrent LLM extractions so we stay under provider RPM (Anthropic /
// Groq). ~5–8 in-flight is a safe default for Haiku / llama; raise via
// EXTRACT_CONCURRENCY if the provider allows it.
const extractQueue = queue({
  name: 'extract-mentions',
  concurrencyLimit: Number(process.env.EXTRACT_CONCURRENCY ?? 6),
});

type SourcePayload =
  | { source_type: 'ticket'; source_id: string; themes: ThemeTaxonomyItem[] }
  | { source_type: 'transcript'; source_id: string; themes: ThemeTaxonomyItem[] }
  | { source_type: 'deal_loss'; source_id: string };

// Per-source unit of work — the batchTrigger fan-out target. Inserts directly
// to ClickHouse rather than returning mentions, so ~1,000 runs stay independent
// (one failure/retry doesn't hold up an orchestrator collecting results).
export const extractMentionsForSource = task({
  id: 'extract-mentions-for-source',
  queue: extractQueue,
  retry: {
    maxAttempts: 4,
    factor: 2,
    minTimeoutInMs: 2_000,
    maxTimeoutInMs: 60_000,
    randomize: true,
  },
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

// Orchestrator — enumerates every raw source and fans out via batchTrigger.
// Idempotency note: reruns will re-extract and re-insert (mentions has no
// unique constraint on source_id), so truncate mentions before a full rerun.
export const extractAllMentions = task({
  id: 'extract-all-mentions',
  maxDuration: 3_600,
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
      ...transcriptIds.map(
        (id): SourcePayload => ({ source_type: 'transcript', source_id: id, themes }),
      ),
      ...dealLossIds.map((id): SourcePayload => ({ source_type: 'deal_loss', source_id: id })),
    ];

    // batchTrigger accepts chunks; Trigger Cloud caps batch size — chunk at 500.
    const BATCH = 500;
    for (let i = 0; i < payloads.length; i += BATCH) {
      const chunk = payloads.slice(i, i + BATCH);
      await extractMentionsForSource.batchTrigger(chunk.map((payload) => ({ payload })));
    }
    return { triggered: payloads.length };
  },
});
