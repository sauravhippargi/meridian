import { query as chQuery } from '@/lib/db/clickhouse';
import { query as pgQuery } from '@/lib/db/postgres';
import type { GetImpactProjectionInput, GetImpactProjectionOutput } from '@/types/agent-tools';

// Impact definitions (judgment calls — same "implement now, review real output
// before finalizing" approach approved for the opportunity-ranking formula):
//   unblock (pipeline_unblocked): deals ALREADY LOST to this theme. Hardest
//     evidence — a concrete deal record, not an inference.
//   risk (arr_at_risk): deals IN PROGRESS but blocked by this theme — live
//     pipeline that could still be lost if the gap isn't closed. (Existing-
//     customer churn risk isn't separately modeled — no signal in this schema
//     distinguishes "renewing customer unhappy" from "prospect mid-deal".)
//   expansion (expansion_potential): accounts with NO deal record for this
//     theme (so not already counted above) but repeated, meaningful mention
//     volume (>=2 mentions, avg severity >=3) — latent upsell demand that
//     hasn't become a deal yet.
interface DealRow {
  account_id: string;
  account_name: string;
  amount: number;
  loss_reason: string | null;
  status: 'lost' | 'in_progress';
}

interface AccountMentionRow {
  account_id: string;
  account_arr: number;
  n_mentions: number;
  avg_severity: number;
}

export const getImpactProjection = async (input: GetImpactProjectionInput): Promise<GetImpactProjectionOutput> => {
  const { data: deals } = await pgQuery<DealRow>(
    `SELECT d.account_id, a.name AS account_name, d.amount, d.loss_reason, d.status
     FROM deals d JOIN accounts a ON a.id = d.account_id
     WHERE d.blocking_theme_id = $1 AND d.status IN ('lost', 'in_progress')`,
    [input.theme_id],
  );

  const dealAccountIds = new Set(deals.map((d) => d.account_id));

  const { data: mentionRollup } = await chQuery<AccountMentionRow>(
    `SELECT account_id, any(account_arr) AS account_arr, count() AS n_mentions, avg(severity) AS avg_severity
     FROM mentions
     WHERE theme_id = {theme_id:String}
     GROUP BY account_id
     HAVING n_mentions >= 2 AND avg_severity >= 3`,
    { theme_id: input.theme_id },
  );

  const expansionCandidates = mentionRollup.filter((r) => !dealAccountIds.has(r.account_id));
  const { data: expansionNames } = expansionCandidates.length
    ? await pgQuery<{ id: string; name: string }>('SELECT id, name FROM accounts WHERE id = ANY($1)', [
        expansionCandidates.map((r) => r.account_id),
      ])
    : { data: [] as { id: string; name: string }[] };
  const nameById = new Map(expansionNames.map((r) => [r.id, r.name]));

  const breakdown: GetImpactProjectionOutput['breakdown'] = [];

  for (const d of deals.filter((d) => d.status === 'lost')) {
    breakdown.push({
      account_id: d.account_id,
      account_name: d.account_name,
      contribution_type: 'unblock',
      contribution_usd: d.amount,
      reason: d.loss_reason ?? 'Deal lost; theme recorded as the blocking reason.',
    });
  }
  for (const d of deals.filter((d) => d.status === 'in_progress')) {
    breakdown.push({
      account_id: d.account_id,
      account_name: d.account_name,
      contribution_type: 'risk',
      contribution_usd: d.amount,
      reason: 'Deal in progress; blocked on this theme — at risk of stalling or being lost.',
    });
  }
  for (const r of expansionCandidates) {
    breakdown.push({
      account_id: r.account_id,
      account_name: nameById.get(r.account_id) ?? '(unknown account)',
      contribution_type: 'expansion',
      contribution_usd: r.account_arr,
      reason: `${r.n_mentions} mentions at avg severity ${r.avg_severity.toFixed(1)}, no deal on record — latent upsell demand.`,
    });
  }

  const sum = (type: (typeof breakdown)[number]['contribution_type']): number =>
    breakdown.filter((b) => b.contribution_type === type).reduce((s, b) => s + b.contribution_usd, 0);

  const pipeline_unblocked = sum('unblock');
  const arr_at_risk = sum('risk');
  const expansion_potential = sum('expansion');

  const confidence: GetImpactProjectionOutput['confidence'] =
    pipeline_unblocked > 0 ? 'high' : arr_at_risk > 0 ? 'medium' : 'low';

  return {
    theme_id: input.theme_id,
    arr_at_risk,
    pipeline_unblocked,
    expansion_potential,
    total: arr_at_risk + pipeline_unblocked + expansion_potential,
    confidence,
    breakdown,
  };
};
