import { query as chQuery } from '@/lib/db/clickhouse';
import { query as pgQuery } from '@/lib/db/postgres';
import type { ListOpportunitiesInput, ListOpportunitiesOutput, OpportunityRow } from '@/types/agent-tools';
import { getCompetitivePosition } from './competitive-position';
import { getImpactProjection } from './impact-projection';
import {
  computeSignalStrength,
  deriveCompetitiveStatus,
  deriveRecommendation,
  buildReasoning,
  competitorsAhead,
  type ThemeRawMetrics,
} from './opportunity-scoring';

interface AccountAggRow {
  theme_id: string;
  account_id: string;
  arr: number;
  segment: 'enterprise' | 'mid_market' | 'smb';
  n_mentions: number;
  avg_severity: number;
}

interface RawCountRow {
  theme_id: string;
  tickets: number;
  transcripts: number;
  deal_losses: number;
  avg_severity: number;
  recency_weighted: number;
}

// Two-level aggregation, same reasoning as theme-evidence.ts: per-(theme,account)
// first (via any()) so ARR sums count each account once, not once per mention.
const fetchAccountAgg = async (windowDays: number): Promise<AccountAggRow[]> => {
  const { data } = await chQuery<AccountAggRow>(
    `SELECT theme_id, account_id, any(account_arr) AS arr, any(account_segment) AS segment,
            count() AS n_mentions, avg(severity) AS avg_severity
     FROM mentions
     WHERE event_date >= today() - {window_days:UInt32}
     GROUP BY theme_id, account_id`,
    { window_days: windowDays },
  );
  return data;
};

// Raw per-theme counts + a linear recency weight (1.0 at today, 0 at
// window_days ago) so recent signal counts more without a hard cutoff.
const fetchRawCounts = async (windowDays: number): Promise<RawCountRow[]> => {
  const { data } = await chQuery<RawCountRow>(
    `SELECT theme_id,
            countIf(source_type = 'ticket') AS tickets,
            countIf(source_type = 'transcript') AS transcripts,
            countIf(source_type = 'deal_loss') AS deal_losses,
            avg(severity) AS avg_severity,
            sum(greatest(0, 1 - dateDiff('day', event_date, today()) / {window_days:UInt32})) AS recency_weighted
     FROM mentions
     WHERE event_date >= today() - {window_days:UInt32}
     GROUP BY theme_id`,
    { window_days: windowDays },
  );
  return data;
};

export const listOpportunitiesRanked = async (input: ListOpportunitiesInput): Promise<ListOpportunitiesOutput> => {
  const windowDays = input.time_window_days ?? 90;

  const { data: themeRows } = await pgQuery<{ id: string; name: string; category: string }>(
    input.category_filter && input.category_filter !== 'all'
      ? 'SELECT id, name, category FROM themes WHERE category = $1'
      : 'SELECT id, name, category FROM themes',
    input.category_filter && input.category_filter !== 'all' ? [input.category_filter] : [],
  );

  const [accountAgg, rawCounts] = await Promise.all([fetchAccountAgg(windowDays), fetchRawCounts(windowDays)]);

  const segmentFilter = input.segment_filter ?? 'all';
  const filteredAccountAgg =
    segmentFilter === 'all' ? accountAgg : accountAgg.filter((r) => r.segment === segmentFilter);

  const metrics: ThemeRawMetrics[] = themeRows.map((theme) => {
    const accts = filteredAccountAgg.filter((r) => r.theme_id === theme.id);
    const counts = rawCounts.find((r) => r.theme_id === theme.id);
    return {
      theme_id: theme.id,
      theme_name: theme.name,
      n_unique_accounts: accts.length,
      n_enterprise_accounts: accts.filter((a) => a.segment === 'enterprise').length,
      total_arr_of_requesters: accts.reduce((s, a) => s + a.arr, 0),
      enterprise_arr_weighted: accts.filter((a) => a.segment === 'enterprise').reduce((s, a) => s + a.arr, 0),
      mention_counts: {
        tickets: counts?.tickets ?? 0,
        transcripts: counts?.transcripts ?? 0,
        deal_losses: counts?.deal_losses ?? 0,
      },
      avg_severity: counts?.avg_severity ?? 0,
      recency_weighted_mentions: counts?.recency_weighted ?? 0,
    };
  });

  const signalStrength = computeSignalStrength(metrics);

  const opportunities: OpportunityRow[] = await Promise.all(
    metrics.map(async (m) => {
      const [competitive, impact] = await Promise.all([
        getCompetitivePosition({ theme_id: m.theme_id }),
        getImpactProjection({ theme_id: m.theme_id }),
      ]);
      const competitiveStatus = deriveCompetitiveStatus(competitive.features);
      const rivals = competitorsAhead(competitive.features);
      const hasLostDeal = impact.breakdown.some((b) => b.contribution_type === 'unblock');
      const totalMentions = m.mention_counts.tickets + m.mention_counts.transcripts + m.mention_counts.deal_losses;
      const isGrowingRecency = totalMentions > 0 && m.recency_weighted_mentions / totalMentions > 0.5;
      const score = signalStrength.get(m.theme_id) ?? 0;
      const recommendation = deriveRecommendation(score, competitiveStatus, m.n_enterprise_accounts, hasLostDeal, isGrowingRecency);

      return {
        theme_id: m.theme_id,
        theme_name: m.theme_name,
        signal_strength: score,
        total_arr_of_requesters: m.total_arr_of_requesters,
        n_unique_accounts: m.n_unique_accounts,
        n_enterprise_accounts: m.n_enterprise_accounts,
        mention_counts: m.mention_counts,
        competitive_status: competitiveStatus,
        competitors_ahead: rivals,
        estimated_impact_usd: impact.total,
        recommendation,
        reasoning: buildReasoning(m, competitiveStatus, rivals, recommendation),
      };
    }),
  );

  opportunities.sort((a, b) => b.signal_strength - a.signal_strength);

  const now = new Date();
  const from = new Date(now.getTime() - windowDays * 86_400_000);
  return {
    opportunities,
    total_mentions_analyzed: metrics.reduce(
      (s, m) => s + m.mention_counts.tickets + m.mention_counts.transcripts + m.mention_counts.deal_losses,
      0,
    ),
    time_window: { from: from.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) },
  };
};
