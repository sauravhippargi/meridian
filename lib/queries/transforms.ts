import type { StatTile, TrendSeries, VolumeTrapPoint } from '@/types/chapter';
import type { ThemeId } from '@/types/theme';

// ─────────────────────────────────────────────────────────────────────────────
// FE-shaped visual transforms (Person B owns these three shapes + emphasis logic)
//
// The other four visuals pass tool output through verbatim. These three are
// derived: they take plain aggregate rows (Person A's query outputs) and shape
// them into the exact payloads stat-row / volume-trap / trend-lines render.
// Emphasis classification (trap|gem, emphasized) is a *visual* decision and
// lives here, not in the agent — it drives coloring and direct labels.
// ─────────────────────────────────────────────────────────────────────────────

// ── small formatters (kept local so lib doesn't depend on component code) ────
const withCommas = (n: number): string => Math.round(n).toLocaleString('en-US');

const usdCompact = (n: number): string => {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
};

const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
};

// ── stat_row ─────────────────────────────────────────────────────────────────
export interface SignalSummary {
  mentions_analyzed: number;
  mentions_delta_pct: number; // vs the prior equal-length window, e.g. 22 => +22%
  window_days: number;
  n_tickets: number;
  n_transcripts: number;
  n_deals: number;
  distinct_themes: number;
  arr_represented: number; // ARR of accounts with >=1 mention in the window
  total_book_arr: number; // whole-book ARR, for the "of $X" caption
}

export const toStatRow = (s: SignalSummary): StatTile[] => {
  const pct = Math.round((s.arr_represented / Math.max(1, s.total_book_arr)) * 100);
  const sign = s.mentions_delta_pct >= 0 ? '+' : '';
  return [
    {
      label: 'Mentions analyzed',
      value: withCommas(s.mentions_analyzed),
      sub: `last ${s.window_days} days`,
      delta: {
        value: `${sign}${s.mentions_delta_pct}%`,
        direction: s.mentions_delta_pct > 0 ? 'up' : s.mentions_delta_pct < 0 ? 'down' : 'flat',
        good: s.mentions_delta_pct >= 0,
      },
    },
    {
      label: 'Sources read',
      value: withCommas(s.n_tickets + s.n_transcripts + s.n_deals),
      sub: `${withCommas(s.n_tickets)} tickets · ${s.n_transcripts} interviews · ${s.n_deals} deals`,
    },
    { label: 'Distinct themes', value: String(s.distinct_themes), sub: 'after dedup & clustering' },
    {
      label: 'ARR represented',
      value: usdCompact(s.arr_represented),
      sub: `of ${usdCompact(s.total_book_arr)} total book`,
      delta: { value: `${pct}%`, direction: 'flat', good: true },
    },
  ];
};

// ── volume_trap ───────────────────────────────────────────────────────────────
export interface ThemeVolumeStat {
  theme_id: ThemeId;
  theme_name: string;
  mention_count: number; // raw loudness (x-axis)
  weighted_arr: number; // sum of requesting accounts' ARR (y-axis)
  n_enterprise_accounts: number;
}

// Classify at most one trap (loud but cheap, no enterprise pull) and one gem
// (quiet but ARR-rich and enterprise-dense). Data-relative thresholds, so this
// holds up when the real numbers replace the mock — not hard-coded theme ids.
export const toVolumeTrap = (themes: ThemeVolumeStat[]): VolumeTrapPoint[] => {
  if (themes.length === 0) return [];

  const mentions = themes.map((t) => t.mention_count);
  const arrs = themes.map((t) => t.weighted_arr);
  const arrPerMention = themes.map((t) => t.weighted_arr / Math.max(1, t.mention_count));

  const loud = quantile(mentions, 0.75); // top quartile of loudness
  const quiet = median(mentions); // below the median = quiet
  const rich = quantile(arrs, 0.66); // top third of ARR
  const cheap = quantile(arrPerMention, 0.34); // bottom third of $/mention

  const trapCandidates = themes.filter(
    (t, i) => t.mention_count >= loud && arrPerMention[i] <= cheap && t.n_enterprise_accounts <= 1,
  );
  const gemCandidates = themes.filter(
    (t) => t.mention_count <= quiet && t.weighted_arr >= rich && t.n_enterprise_accounts >= 3,
  );

  // one of each keeps the scatter's direct labels readable
  const trap = [...trapCandidates].sort((a, b) => b.mention_count - a.mention_count)[0];
  const gem = [...gemCandidates].sort((a, b) => b.weighted_arr - a.weighted_arr)[0];

  return themes.map((t) => ({
    theme_id: t.theme_id,
    theme_name: t.theme_name,
    mention_count: t.mention_count,
    weighted_arr: t.weighted_arr,
    n_enterprise_accounts: t.n_enterprise_accounts,
    emphasis: t === trap ? 'trap' : t === gem ? 'gem' : null,
  }));
};

// ── trend_lines ───────────────────────────────────────────────────────────────
export interface ThemeTrend {
  theme_id: ThemeId;
  theme_name: string;
  points: { date: string; mentions: number }[]; // weekly, chronological (ISO week-start)
}

// Emphasize the fastest-accelerating themes that still carry recent signal;
// everything else renders as context gray. Cap keeps the chart legible.
export const toTrendLines = (trends: ThemeTrend[], maxEmphasis = 2): TrendSeries[] => {
  const scored = trends.map((t) => {
    const pts = t.points.map((p) => p.mentions);
    const third = Math.max(1, Math.floor(pts.length / 3));
    const early = avg(pts.slice(0, third));
    const late = avg(pts.slice(-third));
    return { theme_id: t.theme_id, ratio: late / Math.max(0.5, early), late };
  });

  const emphasized = new Set(
    scored
      .filter((s) => s.ratio >= 1.4 && s.late >= 1)
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, maxEmphasis)
      .map((s) => s.theme_id),
  );

  return trends.map((t) => ({
    theme_id: t.theme_id,
    theme_name: t.theme_name,
    emphasized: emphasized.has(t.theme_id),
    points: t.points,
  }));
};
