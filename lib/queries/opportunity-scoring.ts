import type { OpportunityRow } from '@/types/agent-tools';

// Pure scoring logic — no DB access, unit-testable in isolation. Separated from
// opportunities-ranked.ts (the query orchestration) so the formula itself can
// be reviewed/tuned against real output without touching any SQL.

export interface ThemeRawMetrics {
  theme_id: string;
  theme_name: string;
  n_unique_accounts: number;
  n_enterprise_accounts: number;
  total_arr_of_requesters: number;
  enterprise_arr_weighted: number; // sum of ARR from enterprise-segment requesters only
  mention_counts: { tickets: number; transcripts: number; deal_losses: number };
  avg_severity: number;
  recency_weighted_mentions: number; // sum of per-mention recency weight (linear decay to 0 at 180d)
}

// Min-max normalize to 0-100 across the theme set. A single-theme or
// all-equal set returns 50 for every value (no signal to rank on) rather than
// dividing by zero.
const normalize = (values: number[]): number[] => {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 50);
  return values.map((v) => ((v - min) / (max - min)) * 100);
};

// APPROVED FORMULA (user-reviewed): enterprise ARR heaviest, deal-loss count
// second, severity medium, raw mention volume light-medium, recency lightest.
// Deliberately does NOT weight raw mention_count heavily — that's the whole
// point of the volume-trap wow-moment (loud themes must NOT win on volume alone).
const WEIGHTS = {
  enterpriseArr: 0.35,
  dealLossCount: 0.25,
  avgSeverity: 0.2,
  mentionCount: 0.15,
  recency: 0.05,
};

export const computeSignalStrength = (themes: ThemeRawMetrics[]): Map<string, number> => {
  const enterpriseArrNorm = normalize(themes.map((t) => t.enterprise_arr_weighted));
  const dealLossNorm = normalize(themes.map((t) => t.mention_counts.deal_losses));
  const severityNorm = normalize(themes.map((t) => t.avg_severity));
  const mentionCountNorm = normalize(
    themes.map((t) => t.mention_counts.tickets + t.mention_counts.transcripts + t.mention_counts.deal_losses),
  );
  const recencyNorm = normalize(themes.map((t) => t.recency_weighted_mentions));

  const result = new Map<string, number>();
  themes.forEach((t, i) => {
    const score =
      WEIGHTS.enterpriseArr * enterpriseArrNorm[i] +
      WEIGHTS.dealLossCount * dealLossNorm[i] +
      WEIGHTS.avgSeverity * severityNorm[i] +
      WEIGHTS.mentionCount * mentionCountNorm[i] +
      WEIGHTS.recency * recencyNorm[i];
    result.set(t.theme_id, Math.round(score * 10) / 10);
  });
  return result;
};

// Per-theme competitive rollup from getCompetitivePosition's per-FEATURE output.
export interface FeatureStatus {
  meridian_has_feature: boolean;
  competitors_with_feature: string[];
}

export const deriveCompetitiveStatus = (features: FeatureStatus[]): OpportunityRow['competitive_status'] => {
  if (features.length === 0) return 'parity';
  const meridianHasAll = features.every((f) => f.meridian_has_feature);
  const noCompetitorHasAny = features.every((f) => f.competitors_with_feature.length === 0);
  const meridianHasNone = features.every((f) => !f.meridian_has_feature);
  if (meridianHasAll) return 'ahead';
  if (noCompetitorHasAny && meridianHasNone) return 'greenfield';
  const someCompetitorAhead = features.some((f) => f.competitors_with_feature.length > 0 && !f.meridian_has_feature);
  return someCompetitorAhead ? 'behind' : 'parity';
};

export const competitorsAhead = (features: FeatureStatus[]): string[] => [
  ...new Set(features.flatMap((f) => f.competitors_with_feature)),
];

// Recommendation is a rule set, not a pure score threshold — the demo needs
// specific, defensible outcomes (build_now requires real evidence of urgency,
// not just a high score). hasLostDeal comes from getImpactProjection's
// breakdown (a real 'unblock' contribution — the hardest evidence available).
export const deriveRecommendation = (
  signalStrength: number,
  competitiveStatus: OpportunityRow['competitive_status'],
  nEnterpriseAccounts: number,
  hasLostDeal: boolean,
  isGrowingRecency: boolean,
): OpportunityRow['recommendation'] => {
  if (hasLostDeal && signalStrength >= 70) return 'build_now';
  if (signalStrength >= 55 && (competitiveStatus === 'greenfield' || nEnterpriseAccounts >= 3)) return 'build_next';
  if (signalStrength >= 35 && isGrowingRecency) return 'watch';
  return 'deprioritize';
};

export const buildReasoning = (
  m: ThemeRawMetrics,
  competitiveStatus: OpportunityRow['competitive_status'],
  rivals: string[],
  recommendation: OpportunityRow['recommendation'],
): string => {
  const totalMentions = m.mention_counts.tickets + m.mention_counts.transcripts + m.mention_counts.deal_losses;
  if (recommendation === 'build_now') {
    return `${m.n_enterprise_accounts} enterprise accounts affected, ${m.mention_counts.deal_losses} lost deal(s) cite it${rivals.length ? `, and ${rivals.join('/')} ${rivals.length > 1 ? 'are' : 'is'} ahead` : ''}.`;
  }
  if (recommendation === 'build_next') {
    return competitiveStatus === 'greenfield'
      ? `Only ${totalMentions} mentions but ${m.n_enterprise_accounts} of ${m.n_unique_accounts} requesters are enterprise, and no competitor has it — greenfield.`
      : `${m.n_enterprise_accounts} enterprise accounts want this and we're not yet ahead of the market.`;
  }
  if (recommendation === 'watch') {
    return `Mention volume is rising; not yet blocking a deal, but worth tracking next quarter.`;
  }
  return totalMentions > 100 && m.n_enterprise_accounts <= 1
    ? `Highest raw volume (${totalMentions} mentions) but only ${m.n_enterprise_accounts} enterprise account(s) — mostly SMB, nothing blocked.`
    : `Steady but shallow demand relative to other themes.`;
};
