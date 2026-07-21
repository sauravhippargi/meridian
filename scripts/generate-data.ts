import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pLimit from 'p-limit';
import { postgres, withTransaction } from '../lib/db/postgres';
import { loadArtifacts } from './seed/artifacts';
import { loadSeeds } from './seed/load-seeds';
import { buildPlan, type PlanItem, type PlanSource, type SeedAccount, type SeedTheme, type Segment } from './seed/plan';
import { getModel, getModelName, CostTracker } from './seed/llm';
import {
  generateTicket,
  generateTranscript,
  generateDeal,
  type GenContext,
  type TicketRow,
  type TranscriptRow,
  type DealRow,
} from './seed/generators';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
config({ path: join(repoRoot, '.env.local') });
const seedDir = join(repoRoot, 'data', 'seed');

interface Flags {
  loadSeeds: boolean;
  generate: boolean;
  dryRun: boolean;
  limit: number | null;
  source: PlanSource | 'all';
}

const USAGE = `Usage:
  npm run seed:load                       Load accounts/themes/competitors JSON into Postgres
  npm run seed:generate [-- options]      Generate tickets/transcripts/deals via LLM
  npm run seed:dry                        Generate 5 samples per source as JSON (no writes)

Options (pass after --):
  --source tickets|transcripts|deals|all  Limit to one source type (default: all)
  --limit N                               Cap total generated items (testing)
  --dry-run                               5 samples per source, printed as JSON, no DB writes

Run order: db:init → seed:load → seed:generate`;

const parseArgs = (argv: string[]): Flags => {
  const flags: Flags = { loadSeeds: false, generate: false, dryRun: false, limit: null, source: 'all' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--load-seeds') flags.loadSeeds = true;
    else if (arg === '--generate') flags.generate = true;
    else if (arg === '--dry-run') {
      flags.dryRun = true;
      flags.generate = true;
    } else if (arg === '--limit') {
      flags.limit = Number(argv[++i]);
      if (Number.isNaN(flags.limit)) throw new Error('--limit requires a number');
    } else if (arg === '--source') {
      const v = argv[++i];
      if (v !== 'tickets' && v !== 'transcripts' && v !== 'deals' && v !== 'all') {
        throw new Error('--source must be tickets|transcripts|deals|all');
      }
      flags.source = v;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return flags;
};

// Read reference data back from Postgres (real IDs, post --load-seeds).
const readAccounts = async (): Promise<SeedAccount[]> => {
  const { rows } = await postgres().query<SeedAccount>(
    'SELECT id, name, segment, arr, industry, primary_contact_name, primary_contact_role FROM accounts',
  );
  return rows;
};
const readThemes = async (): Promise<SeedTheme[]> => {
  const { rows } = await postgres().query<{ id: string; name: string; short_description: string; category: string }>(
    'SELECT id, name, short_description, category FROM themes',
  );
  return rows;
};
const readCompetitorIds = async (): Promise<string[]> => {
  const { rows } = await postgres().query<{ id: string }>('SELECT id FROM competitors WHERE is_self = false');
  return rows.map((r) => r.id);
};

// In-flight LLM calls. Kept low (default 2) for the Gemini free-tier 30 RPM wall;
// the global pace-gate in llm.ts is what actually caps the request rate.
const CONCURRENCY = Number(process.env.GEN_CONCURRENCY ?? 2);

// Fan out generation at p-limit(CONCURRENCY), logging progress + running cost.
const generateGroup = async <T>(
  label: string,
  items: PlanItem[],
  gen: (item: PlanItem, seq: number) => Promise<T>,
  cost: CostTracker,
): Promise<T[]> => {
  const limit = pLimit(CONCURRENCY);
  const total = items.length;
  let done = 0;
  return Promise.all(
    items.map((item, i) =>
      limit(async () => {
        const row = await gen(item, i + 1);
        done += 1;
        if (done % 10 === 0 || done === total) {
          const pct = total === 0 ? 100 : (done / total) * 100;
          const spent = cost.spent;
          const est = done === 0 ? 0 : (spent / done) * total;
          console.log(
            `Generated ${done}/${total} ${label} (${pct.toFixed(1)}%) — $${spent.toFixed(2)} spent so far (est. total $${est.toFixed(2)})…`,
          );
        }
        return row;
      }),
    ),
  );
};

const persist = async (tickets: TicketRow[], transcripts: TranscriptRow[], deals: DealRow[]): Promise<void> => {
  await withTransaction(async (client) => {
    for (const t of tickets) {
      await client.query(
        `INSERT INTO raw_tickets (id, external_id, account_id, subject, body, status, priority, opened_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (external_id) DO NOTHING`,
        [t.id, t.external_id, t.account_id, t.subject, t.body, t.status, t.priority, t.opened_at],
      );
    }
    for (const tr of transcripts) {
      await client.query(
        `INSERT INTO raw_transcripts
           (id, external_id, account_id, title, interviewee_name, interviewee_role, interview_date, duration_minutes, transcript)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (external_id) DO NOTHING`,
        [tr.id, tr.external_id, tr.account_id, tr.title, tr.interviewee_name, tr.interviewee_role, tr.interview_date, tr.duration_minutes, tr.transcript],
      );
    }
    for (const d of deals) {
      await client.query(
        `INSERT INTO deals (id, account_id, name, status, amount, close_date, loss_reason, blocking_theme_id, competitor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [d.id, d.account_id, d.name, d.status, d.amount, d.close_date, d.loss_reason, d.blocking_theme_id, d.competitor_id],
      );
    }
  });
};

const runDryRun = async (plan: PlanItem[], ctx: GenContext, competitorIds: string[]): Promise<void> => {
  // Sample ACROSS themes (one item per theme, capped) rather than the first-N of
  // a theme-ordered plan — otherwise every sample is the same (loudest) theme and
  // the quality gate can't see dunning/multi-entity/latam output.
  const take = (source: PlanSource, cap: number): PlanItem[] => {
    const byTheme = new Map<string, PlanItem>();
    for (const p of plan) {
      if (p.source === source && !byTheme.has(p.theme.id)) byTheme.set(p.theme.id, p);
      if (byTheme.size >= cap) break;
    }
    return [...byTheme.values()];
  };
  // Serialize samples (limit 1) so that against a tight free-tier window a single
  // 429 backs off and recovers on its own, instead of many concurrent calls all
  // exhausting their retry budgets at once.
  const dryLimit = pLimit(1);
  const run = <T>(items: PlanItem[], gen: (item: PlanItem, seq: number) => Promise<T>): Promise<T[]> =>
    Promise.all(items.map((item, i) => dryLimit(() => gen(item, i + 1))));
  const tickets = await run(take('tickets', 6), (item, seq) => generateTicket(ctx, item, seq));
  const transcripts = await run(take('transcripts', 6), (item, seq) => generateTranscript(ctx, item, seq));
  const deals = await run(take('deals', 5), (item, seq) => generateDeal(ctx, item, seq, competitorIds));

  console.log('=== DRY RUN — sample raw_tickets rows ===');
  console.log(JSON.stringify(tickets, null, 2));
  console.log('=== DRY RUN — sample raw_transcripts rows ===');
  console.log(JSON.stringify(transcripts, null, 2));
  console.log('=== DRY RUN — sample deals rows ===');
  console.log(JSON.stringify(deals, null, 2));
  console.log(`\n(no DB writes) Cost of samples ≈ $${ctx.cost.spent.toFixed(2)}.`);
};

const runGenerate = async (flags: Flags): Promise<void> => {
  const artifacts = loadArtifacts(seedDir);
  const [accounts, themes, competitorIds] = await Promise.all([readAccounts(), readThemes(), readCompetitorIds()]);
  if (accounts.length === 0 || themes.length === 0) {
    throw new Error('No accounts/themes found in Postgres — run `npm run seed:load` first.');
  }
  const themesById = new Map(themes.map((t) => [t.id, t]));

  let plan = buildPlan(artifacts.truth, accounts, themesById);
  if (flags.source !== 'all') plan = plan.filter((p) => p.source === flags.source);

  const ctx: GenContext = { model: getModel(), cost: new CostTracker(getModelName()) };

  if (flags.dryRun) {
    await runDryRun(plan, ctx, competitorIds);
    return;
  }

  if (flags.limit !== null) plan = plan.slice(0, flags.limit);

  const tickets = await generateGroup(
    'tickets',
    plan.filter((p) => p.source === 'tickets'),
    (item, seq) => generateTicket(ctx, item, seq),
    ctx.cost,
  );
  const transcripts = await generateGroup(
    'transcripts',
    plan.filter((p) => p.source === 'transcripts'),
    (item, seq) => generateTranscript(ctx, item, seq),
    ctx.cost,
  );
  const deals = await generateGroup(
    'deals',
    plan.filter((p) => p.source === 'deals'),
    (item, seq) => generateDeal(ctx, item, seq, competitorIds),
    ctx.cost,
  );

  await persist(tickets, transcripts, deals);
  console.log(
    `\n✅ Generated & wrote: ${tickets.length} tickets, ${transcripts.length} transcripts, ${deals.length} deals. Total cost ≈ $${ctx.cost.spent.toFixed(2)}.`,
  );
};

const closePg = async (): Promise<void> => {
  try {
    await postgres().end();
  } catch {
    /* pool never initialized */
  }
};

const main = async (): Promise<void> => {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.loadSeeds) {
    const counts = await loadSeeds(loadArtifacts(seedDir));
    console.log(`✅ Loaded seeds: ${counts.accounts} accounts, ${counts.themes} themes, ${counts.competitors} competitors.`);
  }
  if (flags.generate) {
    await runGenerate(flags);
  }
  if (!flags.loadSeeds && !flags.generate) {
    console.log(USAGE);
  }
};

main()
  .then(async () => {
    await closePg();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('❌ generate-data failed:', err instanceof Error ? err.message : err);
    await closePg();
    process.exit(1);
  });
