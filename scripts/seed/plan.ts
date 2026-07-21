import type { OpportunityTruth } from './artifacts';

export type Segment = 'enterprise' | 'mid_market' | 'smb';
export type SegmentSkew = Segment | 'mixed';
export type PlanSource = 'tickets' | 'transcripts' | 'deals';

// Read models — populated from Postgres after --load-seeds, so IDs are real.
export interface SeedAccount {
  id: string;
  name: string;
  segment: Segment;
  arr: number;
  industry: string;
  primary_contact_name: string;
  primary_contact_role: string;
}
export interface SeedTheme {
  id: string;
  name: string;
  short_description: string;
  category: string;
}

// One unit of generation work.
export interface PlanItem {
  source: PlanSource;
  account: SeedAccount;
  theme: SeedTheme;
  severity: number; // 1–5
  sentiment: number; // -1 | 0 | 1
  dealStatus?: 'lost' | 'in_progress'; // deals only
  role?: 'blocked_deal' | 'top_requester' | 'passing_mention'; // set for planted items
}

// How strongly each segment is favored when filling remaining quota.
const SEGMENT_WEIGHTS: Record<SegmentSkew, Record<Segment, number>> = {
  enterprise: { enterprise: 6, mid_market: 3, smb: 1 },
  mid_market: { enterprise: 2, mid_market: 6, smb: 2 },
  smb: { enterprise: 1, mid_market: 3, smb: 6 },
  mixed: { enterprise: 1, mid_market: 1, smb: 1 },
};

const clampSeverity = (n: number): number => Math.max(1, Math.min(5, n));
// Bias ± 1, clamped — spreads generated severity around the theme's center.
const jitterSeverity = (bias: number): number => clampSeverity(bias + (Math.floor(Math.random() * 3) - 1));

const pickWeighted = (accounts: SeedAccount[], skew: SegmentSkew): SeedAccount => {
  const weights = accounts.map((a) => SEGMENT_WEIGHTS[skew][a.segment]);
  const total = weights.reduce((s, w) => s + w, 0);
  let r = Math.random() * total;
  for (let i = 0; i < accounts.length; i++) {
    r -= weights[i];
    if (r <= 0) return accounts[i];
  }
  return accounts[accounts.length - 1];
};

// Planted accounts are placed FIRST with their exact role+severity, so specific
// demo moments ("Retool is a blocked deal") are guaranteed, not probabilistic.
// Remaining target_volume is then filled by segment_skew-weighted sampling.
export const buildPlan = (
  truth: OpportunityTruth,
  accounts: SeedAccount[],
  themesById: Map<string, SeedTheme>,
): PlanItem[] => {
  const accountsByName = new Map(accounts.map((a) => [a.name, a]));
  const items: PlanItem[] = [];

  for (const t of truth.themes) {
    const theme = themesById.get(t.theme_id);
    if (!theme) {
      throw new Error(`opportunity-truth references unknown theme_id "${t.theme_id}" (not in themes table)`);
    }
    const consumed: Record<PlanSource, number> = { tickets: 0, transcripts: 0, deals: 0 };

    // 1. Planted accounts — guaranteed appearances.
    for (const p of truth.planted_accounts.filter((pa) => pa.theme_id === t.theme_id)) {
      const account = accountsByName.get(p.account_name);
      if (!account) {
        throw new Error(`planted account "${p.account_name}" (theme ${t.theme_id}) not found in accounts table`);
      }
      if (p.role === 'blocked_deal') {
        // A blocked deal ALWAYS pairs with a discovery-interview trail (sev 5),
        // so the drill-down from "blocked deal" → "customer will churn" works.
        items.push({ source: 'deals', account, theme, severity: p.severity, sentiment: -1, dealStatus: 'lost', role: p.role });
        items.push({ source: 'transcripts', account, theme, severity: 5, sentiment: -1, role: p.role });
        consumed.deals += 1;
        consumed.transcripts += 1;
      } else if (p.role === 'top_requester') {
        items.push({ source: 'tickets', account, theme, severity: p.severity, sentiment: -1, role: p.role });
        consumed.tickets += 1;
      } else {
        items.push({ source: 'tickets', account, theme, severity: p.severity, sentiment: 0, role: p.role });
        consumed.tickets += 1;
      }
    }

    // 2. Fill remaining quota via segment_skew weighting.
    const fill = (source: PlanSource, quota: number): void => {
      for (let i = 0; i < Math.max(0, quota - consumed[source]); i++) {
        items.push({
          source,
          account: pickWeighted(accounts, t.segment_skew),
          theme,
          severity: jitterSeverity(t.severity_bias),
          sentiment: t.sentiment_bias,
          dealStatus: source === 'deals' ? (Math.random() < 0.7 ? 'lost' : 'in_progress') : undefined,
        });
      }
    };
    fill('tickets', t.target_volume.tickets);
    fill('transcripts', t.target_volume.transcripts);
    fill('deals', t.target_volume.deal_losses); // deal_losses quota → 'deals' source
  }

  return items;
};
