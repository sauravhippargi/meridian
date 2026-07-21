import { config } from 'dotenv';
import { join } from 'path';

config({ path: join(process.cwd(), '.env.local') });

const main = async (): Promise<void> => {
  const { query } = await import('../lib/db/postgres');
  const { query: ch } = await import('../lib/db/clickhouse');
  const t = await query<{ c: number }>('SELECT count(*)::int AS c FROM raw_tickets');
  const tr = await query<{ c: number }>('SELECT count(*)::int AS c FROM raw_transcripts');
  const d = await query<{ c: number }>(
    "SELECT count(*)::int AS c FROM deals WHERE status = 'lost'",
  );
  const m = await ch<{ c: string }>('SELECT count() AS c FROM mentions');
  console.log(
    JSON.stringify(
      {
        tickets: t.data[0]?.c,
        transcripts: tr.data[0]?.c,
        lost_deals: d.data[0]?.c,
        mentions: m.data[0]?.c,
      },
      null,
      2,
    ),
  );
};

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
