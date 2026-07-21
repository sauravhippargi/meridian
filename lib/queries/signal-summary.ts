import { query as chQuery } from '@/lib/db/clickhouse';
import { query as pgQuery } from '@/lib/db/postgres';
import type { SignalSummary, ThemeVolumeStat, ThemeTrend } from './transforms';

// Aggregate shapes for Person B's FE-shaped transforms (toStatRow/toVolumeTrap/
// toTrendLines in lib/queries/transforms.ts). Kept as lightweight standalone
// queries rather than reusing listOpportunitiesRanked — a stat-row/volume-trap
// chapter doesn't need the N+1 competitive-position/impact-projection calls
// that ranking does, so this stays cheap even at 5,000 mentions.

export const getSignalSummary = async (windowDays = 180): Promise<SignalSummary> => {
  const [{ data: current }, { data: prior }, { data: byAccount }, { data: bookArr }] = await Promise.all([
    chQuery<{ n: number; tickets: number; transcripts: number; deals: number; themes: number }>(
      `SELECT count() AS n, countIf(source_type = 'ticket') AS tickets,
              countIf(source_type = 'transcript') AS transcripts, countIf(source_type = 'deal_loss') AS deals,
              uniqExact(theme_id) AS themes
       FROM mentions WHERE event_date >= today() - {window_days:UInt32}`,
      { window_days: windowDays },
    ),
    chQuery<{ n: number }>(
      `SELECT count() AS n FROM mentions
       WHERE event_date >= today() - {two_window:UInt32} AND event_date < today() - {window_days:UInt32}`,
      { window_days: windowDays, two_window: windowDays * 2 },
    ),
    chQuery<{ arr: number }>(
      `SELECT sum(arr) AS arr FROM (
         SELECT account_id, any(account_arr) AS arr FROM mentions
         WHERE event_date >= today() - {window_days:UInt32}
         GROUP BY account_id
       )`,
      { window_days: windowDays },
    ),
    pgQuery<{ total: number }>('SELECT COALESCE(SUM(arr), 0) AS total FROM accounts'),
  ]);

  const n = current[0]?.n ?? 0;
  const priorN = prior[0]?.n ?? 0;
  const delta = priorN === 0 ? 0 : Math.round(((n - priorN) / priorN) * 100);

  return {
    mentions_analyzed: n,
    mentions_delta_pct: delta,
    window_days: windowDays,
    n_tickets: current[0]?.tickets ?? 0,
    n_transcripts: current[0]?.transcripts ?? 0,
    n_deals: current[0]?.deals ?? 0,
    distinct_themes: current[0]?.themes ?? 0,
    arr_represented: byAccount[0]?.arr ?? 0,
    total_book_arr: bookArr[0]?.total ?? 0,
  };
};

export const getThemeVolumeStats = async (windowDays = 180): Promise<ThemeVolumeStat[]> => {
  const { data: themes } = await pgQuery<{ id: string; name: string }>('SELECT id, name FROM themes');
  const { data: perAccount } = await chQuery<{
    theme_id: string;
    account_id: string;
    arr: number;
    segment: string;
  }>(
    `SELECT theme_id, account_id, any(account_arr) AS arr, any(account_segment) AS segment
     FROM mentions WHERE event_date >= today() - {window_days:UInt32}
     GROUP BY theme_id, account_id`,
    { window_days: windowDays },
  );
  const { data: counts } = await chQuery<{ theme_id: string; n: number }>(
    `SELECT theme_id, count() AS n FROM mentions
     WHERE event_date >= today() - {window_days:UInt32} GROUP BY theme_id`,
    { window_days: windowDays },
  );

  return themes.map((t) => {
    const accts = perAccount.filter((a) => a.theme_id === t.id);
    return {
      theme_id: t.id,
      theme_name: t.name,
      mention_count: counts.find((c) => c.theme_id === t.id)?.n ?? 0,
      weighted_arr: accts.reduce((s, a) => s + a.arr, 0),
      n_enterprise_accounts: accts.filter((a) => a.segment === 'enterprise').length,
    };
  });
};

// Returns the transform's INPUT shape (no `emphasized` — toTrendLines derives
// that from acceleration; this layer only supplies raw weekly counts).
export const getThemeTrends = async (weeks = 24): Promise<ThemeTrend[]> => {
  const windowDays = weeks * 7;
  const { data: themes } = await pgQuery<{ id: string; name: string }>('SELECT id, name FROM themes');
  const { data: rows } = await chQuery<{ theme_id: string; week: string; n: number }>(
    `SELECT theme_id, toStartOfWeek(event_date) AS week, count() AS n
     FROM mentions WHERE event_date >= today() - {window_days:UInt32}
     GROUP BY theme_id, week ORDER BY week`,
    { window_days: windowDays },
  );

  return themes.map((t) => ({
    theme_id: t.id,
    theme_name: t.name,
    points: rows.filter((r) => r.theme_id === t.id).map((r) => ({ date: r.week, mentions: r.n })),
  }));
};
