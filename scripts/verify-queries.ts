/**
 * Print listOpportunitiesRanked for scoring review.
 * Usage: npx tsx scripts/verify-queries.ts
 */
import { config } from 'dotenv';
import { join } from 'path';

config({ path: join(process.cwd(), '.env.local') });

const main = async (): Promise<void> => {
  const { listOpportunitiesRanked } = await import('../lib/queries/opportunities-ranked');
  const ranked = await listOpportunitiesRanked({ time_window_days: 180 });

  console.log('rank | theme                        | signal | reco          | ent | deals | mentions | comp');
  console.log('-'.repeat(110));
  ranked.opportunities.forEach((row, i) => {
    const m =
      row.mention_counts.tickets + row.mention_counts.transcripts + row.mention_counts.deal_losses;
    console.log(
      `${String(i + 1).padStart(4)} | ${row.theme_id.padEnd(28)} | ${String(row.signal_strength).padStart(6)} | ${row.recommendation.padEnd(13)} | ${String(row.n_enterprise_accounts).padStart(3)} | ${String(row.mention_counts.deal_losses).padStart(5)} | ${String(m).padStart(8)} | ${row.competitive_status}`,
    );
  });

  const byId = Object.fromEntries(ranked.opportunities.map((o) => [o.theme_id, o]));
  const usage = byId['usage_based_billing'];
  const multi = byId['multi_entity_invoicing'];
  const dunning = byId['dunning_customization'];
  const latam = byId['latam_tax'];

  console.log('\nNarrative check:');
  console.log(
    `  usage #1 build_now?     rank=${ranked.opportunities.indexOf(usage!) + 1} reco=${usage?.recommendation} signal=${usage?.signal_strength}`,
  );
  console.log(
    `  multi build_next gem?   rank=${ranked.opportunities.indexOf(multi!) + 1} reco=${multi?.recommendation} signal=${multi?.signal_strength} comp=${multi?.competitive_status}`,
  );
  console.log(
    `  dunning deprioritized?  rank=${ranked.opportunities.indexOf(dunning!) + 1} reco=${dunning?.recommendation} mentions=${(dunning?.mention_counts.tickets ?? 0) + (dunning?.mention_counts.transcripts ?? 0)}`,
  );
  console.log(
    `  latam watch?            rank=${ranked.opportunities.indexOf(latam!) + 1} reco=${latam?.recommendation} signal=${latam?.signal_strength}`,
  );
};

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
