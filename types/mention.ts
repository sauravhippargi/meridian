import type { ThemeId } from './theme';

export interface Mention {
  mention_id: string;              // UUID
  theme_id: ThemeId;
  source_type: 'ticket' | 'transcript' | 'deal_loss';
  source_id: string;               // ticket_id / transcript_id / deal_id
  account_id: string;
  account_arr: number;             // denormalized for query speed
  severity: 1 | 2 | 3 | 4 | 5;     // 5 = blocking, 1 = passing mention
  sentiment: -1 | 0 | 1;           // negative / neutral / positive
  verbatim_snippet: string;        // the actual quote (~200 char max)
  char_offset_start: number;       // for provenance-back-to-source
  char_offset_end: number;
  extracted_at: string;            // ISO datetime
  event_date: string;              // date of the underlying source
}