import { v4 as uuidv4 } from 'uuid';
import { query } from '@/lib/db/postgres';
import { extractMentions } from './extract';
import type { Mention } from '@/types/mention';
import type { Account } from '@/types/account';
import type { ThemeTaxonomyItem } from './schema';

// Core extraction logic, deliberately plain async functions (not Trigger.dev
// tasks) so they're unit-testable against live Postgres/ClickHouse without the
// Trigger.dev dev server running. trigger/extract-mentions.ts wraps these in
// task()/batchTrigger for fan-out; the business logic lives here.

interface AccountJoin {
  account_id: string;
  arr: number;
  segment: Account['segment'];
}

const nowIso = (): string => new Date().toISOString();

// pg returns timestamptz as Date objects; date columns may arrive as Date or
// string depending on the driver/parser. Normalize to YYYY-MM-DD for ClickHouse.
const toDateStr = (value: string | Date): string => {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};

// ── tickets & transcripts: LLM extraction ────────────────────────────────────
interface TicketJoinRow extends AccountJoin {
  id: string;
  external_id: string;
  subject: string;
  body: string;
  opened_at: string | Date;
}

export const extractMentionsForTicket = async (
  ticketId: string,
  themes: ThemeTaxonomyItem[],
): Promise<Mention[]> => {
  const { data } = await query<TicketJoinRow>(
    `SELECT rt.id, rt.external_id, rt.subject, rt.body, rt.opened_at, a.id AS account_id, a.arr, a.segment
     FROM raw_tickets rt JOIN accounts a ON a.id = rt.account_id
     WHERE rt.id = $1`,
    [ticketId],
  );
  const row = data[0];
  if (!row) throw new Error(`raw_ticket ${ticketId} not found`);

  const sourceText = `${row.subject}\n\n${row.body}`;
  const extracted = await extractMentions(sourceText, themes);
  return extracted.map((m) => ({
    mention_id: uuidv4(),
    theme_id: m.theme_id,
    source_type: 'ticket',
    source_id: row.external_id,
    account_id: row.account_id,
    account_arr: row.arr,
    account_segment: row.segment,
    severity: m.severity as Mention['severity'],
    sentiment: m.sentiment as Mention['sentiment'],
    verbatim_snippet: m.verbatim_snippet,
    char_offset_start: m.char_offset_start,
    char_offset_end: m.char_offset_end,
    extracted_at: nowIso(),
    event_date: toDateStr(row.opened_at),
  }));
};

interface TranscriptJoinRow extends AccountJoin {
  id: string;
  external_id: string;
  transcript: string;
  interview_date: string | Date;
}

export const extractMentionsForTranscript = async (
  transcriptId: string,
  themes: ThemeTaxonomyItem[],
): Promise<Mention[]> => {
  const { data } = await query<TranscriptJoinRow>(
    `SELECT rt.id, rt.external_id, rt.transcript, rt.interview_date, a.id AS account_id, a.arr, a.segment
     FROM raw_transcripts rt JOIN accounts a ON a.id = rt.account_id
     WHERE rt.id = $1`,
    [transcriptId],
  );
  const row = data[0];
  if (!row) throw new Error(`raw_transcript ${transcriptId} not found`);

  const extracted = await extractMentions(row.transcript, themes);
  return extracted.map((m) => ({
    mention_id: uuidv4(),
    theme_id: m.theme_id,
    source_type: 'transcript',
    source_id: row.external_id,
    account_id: row.account_id,
    account_arr: row.arr,
    account_segment: row.segment,
    severity: m.severity as Mention['severity'],
    sentiment: m.sentiment as Mention['sentiment'],
    verbatim_snippet: m.verbatim_snippet,
    char_offset_start: m.char_offset_start,
    char_offset_end: m.char_offset_end,
    extracted_at: nowIso(),
    event_date: toDateStr(row.interview_date),
  }));
};

// ── deal losses: deterministic, no LLM call ──────────────────────────────────
// A lost deal's blocking_theme_id + loss_reason ARE the mention — the theme is
// already known (set at generation time), so there's nothing for an LLM to
// discover. Severity is always 5 (a lost deal is definitionally a blocker).
interface DealJoinRow extends AccountJoin {
  id: string;
  blocking_theme_id: string;
  loss_reason: string;
  close_date: string | Date;
}

export const buildMentionForDealLoss = async (dealId: string): Promise<Mention> => {
  const { data } = await query<DealJoinRow>(
    `SELECT d.id, d.blocking_theme_id, d.loss_reason, d.close_date, a.id AS account_id, a.arr, a.segment
     FROM deals d JOIN accounts a ON a.id = d.account_id
     WHERE d.id = $1 AND d.status = 'lost' AND d.blocking_theme_id IS NOT NULL`,
    [dealId],
  );
  const row = data[0];
  if (!row) throw new Error(`deal ${dealId} not found, not lost, or has no blocking_theme_id`);

  const snippet = row.loss_reason.length > 400 ? `${row.loss_reason.slice(0, 397)}...` : row.loss_reason;
  return {
    mention_id: uuidv4(),
    theme_id: row.blocking_theme_id,
    source_type: 'deal_loss',
    source_id: row.id,
    account_id: row.account_id,
    account_arr: row.arr,
    account_segment: row.segment,
    severity: 5,
    sentiment: -1,
    verbatim_snippet: snippet,
    char_offset_start: 0,
    char_offset_end: snippet.length,
    extracted_at: nowIso(),
    event_date: toDateStr(row.close_date),
  };
};

// ── enumeration: what's left to process ──────────────────────────────────────
export const listPendingTicketIds = async (): Promise<string[]> => {
  const { data } = await query<{ id: string }>('SELECT id FROM raw_tickets ORDER BY opened_at');
  return data.map((r) => r.id);
};

export const listPendingTranscriptIds = async (): Promise<string[]> => {
  const { data } = await query<{ id: string }>('SELECT id FROM raw_transcripts ORDER BY interview_date');
  return data.map((r) => r.id);
};

export const listPendingDealLossIds = async (): Promise<string[]> => {
  const { data } = await query<{ id: string }>(
    "SELECT id FROM deals WHERE status = 'lost' AND blocking_theme_id IS NOT NULL ORDER BY close_date",
  );
  return data.map((r) => r.id);
};
