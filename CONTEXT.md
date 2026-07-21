# Meridian — Project Context & Handoff

**ClickHouse & Trigger.dev Virtual Summer Hackathon 2026**
**Team of 2 · Person A (Saurav, backend/data/agent) + Person B (frontend/streaming)**
**Repo:** github.com/sauravhippargi/meridian
**Deadline:** submissions close midnight AoE, July 23, 2026

This document is the single source of truth for where the project stands. Read it top to bottom before doing any work.

---

## 1. What Meridian is

A chat agent for PMs at a fictional B2B SaaS company ("Meridian Payments," a Stripe-style payments company). The user is a PM on the Billing team preparing for Q4 planning. They ask questions like "what should we prioritize next quarter?" and the agent answers by reading across support tickets, customer interview transcripts, CRM deal data, and competitive intelligence.

**Responses are visual-first** — charts, matrices, evidence cards — not walls of text. This is the hackathon theme: "Beyond the Wall of Text." The judging lens is "ratio of insight to words."

### The demo narrative (the "opportunity truth")
The agent must correctly identify, from the seeded data:
1. **Usage-based billing enhancements** — #1 recommendation (`build_now`). Enterprise ARR, competitive urgency (Metronome/Orb ahead), blocked deals.
2. **Multi-entity consolidated invoicing** — #2 hidden gem (`build_next`). Small footprint but top-15 enterprise accounts, greenfield (no competitor has it).
3. **Dunning email customization** — correctly **deprioritized** despite highest raw ticket volume (mostly SMB accounts, no enterprise deals blocked). This is the "volume trap."
4. **LATAM tax handling** — `watch` (Q1, growing but not urgent).
5. Hybrid RevRec, webhook reliability, Salesforce sync, custom invoice PDFs — backlog.

### Three "wow" moments the demo must land
1. **Volume-trap detection** — dunning has the most tickets but the agent correctly does NOT rank it #1 (it's SMB-driven, low ARR).
2. **Hidden-gem surfacing** — multi-entity invoicing ranks #2 despite low volume because requesters are high-ARR enterprise.
3. **Provenance drill-down** — every claim traces back to exact source quotes (tickets, transcripts, deals).

---

## 2. Architecture

### Data layer (OLTP + OLAP — targeting the €1000 bonus prize)
- **Postgres (OLTP)** — mutable business records. Provisioned as a **ClickHouse-managed Postgres service** (not Neon — we switched to ClickHouse's managed Postgres so both databases live in one platform, which strengthens the OLTP+OLAP integration story). Holds: `accounts`, `deals`, `themes`, `competitors`, `raw_tickets`, `raw_transcripts`.
- **ClickHouse (OLAP)** — analytical store. Holds: `mentions` (the big append-only table, ~5,000 rows after extraction), `theme_scores_daily` (materialized view). Every agent query is an aggregation over this.

**Why both:** Postgres answers "current state of this account/deal" (transactional lookups on mutable data); ClickHouse answers "across all signal, what matters most?" (analytical aggregation). The Phase A4 sync task propagates changed fields (e.g. account ARR) from Postgres → ClickHouse to keep aggregations current. This is the textbook OLTP+OLAP pattern the bonus prize rewards.

### Agent layer
- **Trigger.dev `chat.agent()`** — REQUIRED by the hackathon. The agent orchestration must use this primitive, not a raw Next.js route or bare Vercel AI SDK. Background jobs (ingestion, extraction, sync) also run as Trigger.dev tasks with `batchTrigger` for fan-out.
- **Orchestration decision: HYBRID** — scripted chapter sequence for the main "what should we prioritize?" flow (for demo reliability), LLM-driven for follow-up questions. LLM reasoning goes into synthesis WITHIN each chapter (verdict text, callouts), not the sequencing between chapters.

### Frontend + streaming (Person B, DONE)
- Next.js 14 App Router + TypeScript strict + Tailwind + Recharts + framer-motion.
- The frontend consumes an **NDJSON stream of typed `StreamEvent`s** (defined in `types/chapter.ts`), NOT raw Trigger.dev tool-call events.
- **The integration seam is one interface:** `createAgentStream(body: ChatRequest): AsyncGenerator<StreamEvent>`, stubbed at `lib/agent-stream.ts` (compiles, throws until Person A implements). Person A yields typed StreamEvents; Person B owns NDJSON encoding (`app/api/chat/ndjson.ts`) + route wiring (`route.ts`).
- Reference for exact event ordering/pacing: `app/api/chat/mock/stream.ts` and `app/api/chat/mock/scenarios.ts`.

### LLM provider: Google Gemini (free tier)
- We switched from OpenAI to **Google Gemini** via `@ai-sdk/google` to use the free tier (no funded OpenAI key needed).
- Free tier: Gemini 2.5 Flash = 1,500 requests/day, 15 RPM, 1M TPM. Flash-Lite = 30 RPM. Pro models are NOT free (moved to paid April 2026).
- **Use Flash-Lite for generation, Flash for extraction and agent synthesis.**
- **Critical constraint:** the 15 RPM limit means the generator's concurrency must be LOWERED (from 5 to ~2-3) with 429-retry backoff, or it will hit the rate wall mid-run. You effectively get ONE full generation run per day on the free tier — so get the dry-run right before the full run.
- Env var: `GOOGLE_GENERATIVE_AI_API_KEY`.

---

## 3. THE STREAMEVENT CONTRACT (critical for Person A's agent work)

The frontend and agent communicate over a stream of typed `StreamEvent`s. Full types in `types/chapter.ts`. The union:

```ts
type StreamEvent =
  | { type: 'message_start'; message_id: string }
  | { type: 'status'; status: StatusUpdate }
  | { type: 'chapter_start'; chapter_id: string; title: string; icon: ChapterIcon }
  | { type: 'chapter_intro_delta'; chapter_id: string; delta: string }
  | { type: 'chapter_visual'; chapter_id: string; visual: ChapterVisual }
  | { type: 'chapter_callout'; chapter_id: string; callout: Callout }
  | { type: 'message_end'; message_id: string; headline: string }
  | { type: 'error'; message: string };
```

**Per-chapter event order (must honor):** `chapter_start` → `chapter_intro_delta`* → `chapter_visual` → `chapter_callout`*. Bracketed by `message_start` / `message_end{headline}`, with `status` events interleaved per query.

### The 7 visuals (ChapterVisual discriminated union)
Four are **pass-through** — their `data` is literally Person A's tool output from `types/agent-tools.ts`, no reshaping:
- `opportunity_ranking` ← `ListOpportunitiesOutput`
- `evidence_cards` ← `GetThemeEvidenceOutput`
- `competitor_matrix` ← `GetCompetitivePositionOutput`
- `impact_waterfall` ← `GetImpactProjectionOutput`

Three are **frontend-shaped** — Person B built the transforms (`lib/queries/transforms.ts`: `toStatRow` / `toVolumeTrap` / `toTrendLines`). Person A must produce these aggregate input shapes for them:
- `stat_row` ← needs `SignalSummary`
- `volume_trap` ← needs `ThemeVolumeStat[]`
- `trend_lines` ← needs `ThemeTrend[]`

**ACTION:** Person A must define `SignalSummary`, `ThemeVolumeStat[]`, `ThemeTrend[]` types (or get exact shapes from Person B) and produce them from the query functions. Person B's transforms handle the trap/gem/emphasis classification from raw numbers — no re-hardcoding needed for real data.

---

## 4. What is DONE

### Person A (backend) — Phase A1 code complete, committed, pushed
All Phase A1 files written and typecheck clean. NOT YET RUN against live services (that's the immediate next step).

**Committed files:**
- `CLAUDE.md` — project context (read it)
- `types/` — `theme.ts`, `mention.ts`, `account.ts`, `agent-tools.ts`, `deal.ts`, `competitor.ts`, `raw-ticket.ts`, `raw-transcript.ts`
- `lib/db/clickhouse.ts` — client with `query<T>()` (returns `{data, rows, elapsedMs}`), `insertBatch<T>()` (chunks at 1000), `ping()`, `ClickHouseError`
- `lib/db/postgres.ts` — client with `query<T>()`, `queryOne<T>()`, `withTransaction()`, `ping()`, `PostgresError`, injection guard, `pg.types.setTypeParser(1700, parseFloat)` for NUMERIC→number
- `lib/db/schema.postgres.sql` — accounts, deals, themes, competitors, raw_tickets, raw_transcripts. UUID PKs (uuid-ossp), updated_at triggers on mutable tables, enums for segment + theme category, FK cascade rules
- `lib/db/schema.clickhouse.sql` — `mentions` (MergeTree, ORDER BY (theme_id, event_date), PARTITION BY toYYYYMM(event_date), skip index on account_id, account_segment as Enum8) + `theme_scores_daily` materialized view (SummingMergeTree)
- `scripts/init-schema.ts` — idempotent schema applier (Postgres whole-file, ClickHouse statement-split). npm script: `db:init`
- `scripts/generate-data.ts` + `scripts/seed/*` (artifacts.ts, generators.ts, llm.ts, load-seeds.ts, plan.ts) — LLM data generator. npm scripts: `seed:load`, `seed:dry`, `seed:generate`

**Seed artifacts (committed, validated — all zod + cross-ref checks pass):**
- `data/seed/accounts.json` — 123 accounts (13 enterprise, 30 mid_market, 80 SMB), ~$11M total ARR, ALL REAL company names (Notion, Vercel, Retool, Linear, Airtable, Zapier, Miro, etc.)
- `data/seed/themes.json` — 8 themes with slugs (usage_based_billing, multi_entity_invoicing, dunning_customization, latam_tax, hybrid_revrec, webhook_reliability, salesforce_sync, custom_invoice_pdf)
- `data/seed/competitors.json` — 8 rows (7 competitors + 1 Meridian self-row with is_self:true), 20 features each as 'full'|'partial'|'none'
- `data/seed/opportunity-truth.json` — 8 truth themes with target_volume + 28 planted_accounts (4 blocked_deal roles: Retool→usage, Airtable→multi-entity, Attio→salesforce, Pilot→salesforce)

**Generation sizing:** ~956 tickets + 63 transcripts + 14 deals ≈ 1,033 LLM calls. blocked_deal accounts each get a deal row + a sev-5 transcript.

### Person B (frontend) — DONE
- Full frontend built, runs in mock mode, `tsc` + `next build` green.
- All 7 visual components built and rendering. Three wow moments work in mock.
- `INTEGRATION.md` in repo (commit a57e091 on branch `claude/hackathon-chat-frontend-hpii18`) — sections 3/4/8 detail the streaming contract. READ IT.
- Interface named: `createAgentStream(body): AsyncGenerator<StreamEvent>` stubbed at `lib/agent-stream.ts`.
- Transforms done: `lib/queries/transforms.ts` (toStatRow/toVolumeTrap/toTrendLines).
- Owns: route.ts wiring, NDJSON encoding, deployment dashboards (needs human auth — Saurav does this).

### Environment (DONE)
- `.env.local` created locally with: CLICKHOUSE_URL/USER/PASSWORD/DATABASE, POSTGRES_URL (ClickHouse-managed Postgres), GOOGLE_GENERATIVE_AI_API_KEY.
- Env vars also mirrored into Vercel.
- ClickHouse connectivity verified: `curl .../ping` returns `Ok.` from local machine.
- **NOTE:** the generator/schema currently reference `OPENAI_API_KEY` in places — must be switched to Gemini (`@ai-sdk/google`, `GOOGLE_GENERATIVE_AI_API_KEY`) with lowered concurrency for the 15 RPM free-tier limit. This is the first code change needed.

---

## 5. IMMEDIATE NEXT STEPS (in order)

### Step 0 — Switch generator from OpenAI to Gemini ✅ DONE
- [x] `scripts/seed/llm.ts` now defaults to `@ai-sdk/google` + `gemini-2.0-flash-lite` (env-overridable via `GEN_PROVIDER`/`GEN_MODEL`). Single `getModelName()` source of truth.
- [x] Concurrency lowered 5→2 (`GEN_CONCURRENCY`, default 2). Added a **global RPM pace-gate** (`GEN_MIN_INTERVAL_MS`, default 2100ms ≈ 28/min) — caps the request *rate*, not just in-flight count.
- [x] `withRetry` upgraded to **429-aware backoff** (5→60s for rate limits, 1→4s for transient) with jitter.
- [x] `.env.example` documents `GOOGLE_GENERATIVE_AI_API_KEY` + generation tuning knobs; OpenAI/Anthropic marked optional.
- **Two infra fixes discovered while running (both flagged to Person A):**
  - [x] `lib/db/postgres.ts` — newer `pg` treats `sslmode=require` as verify-full and rejects ClickHouse-managed Postgres's cert; now strips `sslmode` from the URL and sets `ssl:{rejectUnauthorized:false}` (honors `sslmode=disable`).
  - [x] `scripts/init-schema.ts` — ClickHouse statement splitter now strips `--` line comments before splitting on `;` (a comment contained a semicolon → "Empty query").

### Step 1 — Run the data pipeline (finishes Phase A1)
1. [x] `npm run db:init` — ✅ Postgres (6 tables/3 triggers/4 enums) + ClickHouse `meridian` DB (mentions + theme_scores_daily MV) applied.
2. [x] `npm run seed:load` — ✅ 123 accounts / 8 themes / 8 competitors in Postgres.
3. [x] `npm run seed:dry` — ✅ **PASSED quality gate.** Switched generation provider to **Anthropic Claude Haiku 4.5** (`GEN_PROVIDER=anthropic`) — Gemini free tier surfaced `limit: 20`, too low for the run; the paid Anthropic key is reliable. Cross-theme samples: 8 themes represented, diverse interviewee names (contact-seeded), theme-appropriate severity, all planted blocked-deals (Retool→usage, Airtable→multi-entity, Attio→salesforce, Slite→latam) landed. ~$0.02 / 17 samples.
4. [~] `npm run seed:generate` — full ~1,033-call run **IN PROGRESS** (started, running in background against live Postgres). Anthropic Claude Haiku 4.5, concurrency 3, ~14/min effective. Tracking to ~$1.15 total, ETA ~55-65 min from start given observed pace (slower than the original 20-30 min estimate — Haiku + retries average out closer to ~14-17/min than hoped). **Important: generate-data.ts generates all 3 groups (tickets→transcripts→deals) fully in memory, then calls persist() ONCE at the end in a single transaction — raw_tickets/raw_transcripts/deals in Postgres stay EMPTY until the entire run completes, not incrementally.** So nothing downstream (extraction) can start until this finishes.
5. [ ] Verify: mentions count, spot-check 20, distribution matches truth. **BLOCKED on step 4 finishing.**

### Phase A2 — Extraction pipeline ✅ CODE DONE, quality-gate PASSED, pending live end-to-end run
1. [x] `lib/extraction/schema.ts` + `prompts.ts` + `model.ts` + `extract.ts` — closed-taxonomy Zod schema (dynamic from live theme ids), prompt requiring exact verbatim quotes, provider-agnostic model selection (`EXTRACT_PROVIDER`, defaults to Anthropic Haiku), and `extractMentions()` which computes char offsets by locating the LLM's snippet in the source text (never trusts LLM-reported offsets — they're routinely wrong).
2. [x] **THE CRITICAL QUALITY GATE — PASSED, well above the 80% bar.** Tested against 4 REAL generated documents (from the seed:dry samples, spanning usage_based_billing/dunning/latam_tax) covering all 20 extracted mentions: **20/20 correct theme classification, 20/20 exact-match verbatim offsets**, theme-appropriate severity (dunning=3-4, usage/latam=5), and one genuinely nuanced sentiment catch (a conditional-positive line correctly scored +1 inside an otherwise negative transcript). Zero cross-theme bleed (a dunning ticket mentioning "templates/branding" wasn't miscategorized into invoice_pdf).
3. [x] `lib/extraction/pipeline.ts` — the testable core logic: `extractMentionsForTicket`/`extractMentionsForTranscript` (LLM path, joins account arr/segment), `buildMentionForDealLoss` (**no LLM call** — a lost deal's `blocking_theme_id`+`loss_reason` already ARE the mention; severity is definitionally 5), `listPending*Ids()` enumerators. Typechecked; NOT yet runtime-tested (raw_tickets/deals are empty until Phase A1 step 4 persists — see above).
4. [x] `trigger/extract-mentions.ts` — thin Trigger.dev `task()` wrapper: `extractMentionsForSource` (per-source unit, batchTrigger fan-out target, inserts directly to ClickHouse so 5,000 runs stay independent) + `extractAllMentions` (orchestrator: loads themes + all pending ids, batchTriggers). Typechecked against the v3 SDK shape from `trigger.config.ts`; **UNVERIFIED against a live Trigger.dev dev server** (`TRIGGER_PROJECT_REF`/`TRIGGER_SECRET_KEY` still placeholders) — smoke-test on one id before the full batchTrigger once `npx trigger.dev@latest dev` is running.
5. [ ] Run full extraction → ~5,000 mentions. **BLOCKED on Phase A1 step 4 + Trigger.dev project keys.**
6. [ ] Verify against ground truth: usage-billing highest enterprise-ARR weight, dunning highest raw count but low ARR, multi-entity few but high-ARR.

### Phase A3 — Query functions + agent (~5-7 hrs, the core)
1. Four query functions in `lib/queries/` returning `agent-tools.ts` shapes verbatim: `listOpportunitiesRanked`, `getThemeEvidence`, `getCompetitivePosition`, `getImpactProjection`.
   - [x] **`getCompetitivePosition`** (`competitive-position.ts`) — DONE, tested against live Postgres. Pure Postgres, no ClickHouse dependency. Real finding while testing: only `'full'` support counts as "a competitor has this" (not `'partial'`) — seed data has Adyen/Zuora at `'partial'` for multi-entity invoicing, and counting that as "has it" would have suppressed the frontend's greenfield/Open status for wow-moment #2. Verified: usage_based_billing shows Metronome/Orb ahead; multi_entity_invoicing shows zero rivals — matches `opportunity-truth.json`'s "greenfield" claim exactly.
   - [x] **`getThemeEvidence`** (`theme-evidence.ts`) — code done, typechecked. Two ClickHouse queries (capped severity-ranked evidence sample + uncapped per-account rollup — capping both would silently undercount "N accounts behind this theme"), one Postgres name lookup (account_name isn't denormalized onto mentions by design — this is the one place OLAP hands off to OLTP for "who"). **NOT YET runtime-verified** — needs live `mentions`.
   - [x] **`getImpactProjection`** (`impact-projection.ts`) — code done, typechecked. Definitions (documented in-file, same "propose now / review real output later" pattern as the scoring formula): `unblock`=lost deals blocked by the theme (hardest evidence), `risk`=in-progress deals blocked by the theme, `expansion`=accounts with ≥2 mentions/avg severity≥3 and NO deal record (latent upsell, not yet a deal). `confidence` derives from which tiers have data. **NOT YET runtime-verified.**
   - [x] **`listOpportunitiesRanked`** (`opportunities-ranked.ts` + `opportunity-scoring.ts`) — code done, typechecked. Split into pure scoring logic (unit-testable without a DB) and query orchestration.
2. [x] The 3 aggregate shapes Person B's transforms need — `lib/queries/signal-summary.ts`: `getSignalSummary()`, `getThemeVolumeStats()`, `getThemeTrends()`. Return the transforms' *input* types (`SignalSummary`/`ThemeVolumeStat`/`ThemeTrend`, defined in `transforms.ts` itself, not `types/chapter.ts` — a real import mistake caught and fixed while building this). `getThemeTrends` deliberately does NOT set `emphasized` — that's `toTrendLines`' job (acceleration heuristic), not the query layer's. **NOT YET runtime-verified.**
3. **THE SCORING FORMULA — implemented per user-approved design, PENDING REVIEW AGAINST REAL DATA (as agreed).** In `opportunity-scoring.ts`:
   ```
   signal_strength = 0.35×norm(enterprise_arr_weighted) + 0.25×norm(deal_loss_count)
                    + 0.20×norm(avg_severity) + 0.15×norm(mention_count) + 0.05×norm(recency_weighted)
   ```
   Min-max normalized 0-100 across the theme set. Deliberately does NOT weight raw mention_count heavily — that's the entire point of the volume-trap wow-moment. `recommendation` is a rule set on top (not a pure threshold): `build_now` requires signal≥70 AND a real lost-deal (hardest evidence); `build_next` requires signal≥55 AND (greenfield OR ≥3 enterprise accounts); `watch` requires signal≥35 AND rising recency share; else `deprioritize`. **USER: once Phase A2 extraction produces real mentions, I'll run this and show you the actual 8-theme ranked table (scores + recommendations) before treating it as final** — per your "propose now, review after" choice.
4. [x] Competitor feature→theme mapping — `lib/queries/competitor-feature-map.ts`. Hand-mapped all 20 features across the 8 themes (verified: sums to 20, no gaps/overlaps).
5. Implement `createAgentStream()` in `lib/agent-stream.ts` — the async generator yielding StreamEvents. Hybrid orchestration: scripted sequence for main flow. Honor per-chapter event order. **Not started** — the 4 query functions + 3 aggregate-shape functions it will call are now ready in code, but unverified against real data; building the stream generator before that verification risks compounding an unvalidated formula into the orchestration layer.
6. Build `chat.agent()` in `trigger/agent.ts` — system prompt + register 4 tools + chapter orchestration. Stubs exist: statusEvent, visualEvent, encodeNdjson. **Not started.**
7. Verify primary flow end-to-end: "what should we prioritize?" → all chapters stream → wow moments land. **Not started.**

**Verification debt (explicit, so nothing is silently assumed correct): `theme-evidence.ts`, `impact-projection.ts`, `opportunities-ranked.ts`, `signal-summary.ts`, and `extract-mentions.ts` (Trigger task) are all typechecked but NOT runtime-tested — every one of them queries the `mentions` ClickHouse table, which is empty until Phase A1 step 4 (generation) finishes AND Phase A2 step 5 (extraction) runs. `getCompetitivePosition` is the only query function verified against live data, because it's the only one with no `mentions` dependency.**

### Phase A4 — OLTP+OLAP sync + secondary tools (~3-4 hrs, bonus prize)
1. `trigger/sync-oltp-to-olap.ts` — scheduled task, propagates changed account/deal fields Postgres→ClickHouse.
2. Optional: simulated live ingestion task (adds a ticket every 10 min → shows real-time counter in demo).
3. Secondary tools: get_theme_trend, compare_themes, get_account_history.
4. Query optimization — target <500ms per query. Materialized views.
5. `docs/architecture.md` with Mermaid diagram (judges look at this for the bonus).

### Phase A5 — Deploy + submit (~2-3 hrs)
1. Deploy frontend to Vercel (env vars already mirrored), agent+tasks to Trigger.dev Cloud (`npx trigger.dev deploy`).
2. Submission materials (Person B drafting): 100-char title, 160-char tagline, 500-word summary, "how ClickHouse + Trigger.dev are used" paragraph.
3. Record demo video (max 5 min, OPEN WITH LIVE PRODUCT per handbook — no intro card). Show main flow + wow moments + drill-in.
4. Make repo public, add MIT LICENSE.
5. SUBMIT EARLY — morning of July 23, not midnight AoE.

---

## 6. KEY DECISIONS & CONSTRAINTS (do not violate)

- **ClickHouse must be primary DB, Postgres is OLTP** — both required for bonus prize. Do NOT collapse to one database.
- **Agent MUST use Trigger.dev `chat.agent()`** — required, disqualification otherwise. Both ClickHouse and Trigger.dev must be meaningfully used.
- **All code written during July 17-23** — no pre-existing code. Data-artifact JSON (design) was allowed pre-window; generator code was written in-window.
- **Gemini free tier: 15 RPM (Flash) / 30 RPM (Flash-Lite), 1,500 req/day** — lower generator concurrency, one full run/day.
- **File ownership:** Person A owns `/lib` (except transforms.ts + agent-stream.ts which B stubbed), `/trigger`, `/scripts`, `/data`, all SQL. Person B owns `/app`, `/components`, transforms, NDJSON/route wiring. Shared (PR only): `/types`, CLAUDE.md, .env.example.
- **Extraction quality gate is non-negotiable** — 20-sample manual check before full extraction.
- **themes.id is a TEXT slug** (e.g. 'usage_based_billing'), NOT a UUID — it's the join key across mentions/tools/seed. Everything else uses UUIDs.
- **Demo video opens with live product** — handbook requirement.

## 7. STYLE RULES (from CLAUDE.md)
TypeScript strict, no `any`, async/await, single quotes + semicolons, named exports (except Next.js page/layout/route), files <~200 lines, comments explain why not what.

## 8. JUDGING RUBRIC (for prioritization)
- Use of ClickHouse & Trigger.dev — 25%
- Problem Fit — 20%
- Technical Implementation — 20%
- Innovation — 20%
- Scalability & Impact — 10%
- Presentation — 5%
Plus bonus category: best OLTP+OLAP integration (€1000).

---

## 9. WHAT TO DO RIGHT NOW (updated 2026-07-20, evening)
Step 0 and Step 1.1-1.3 are done (db:init, seed:load, seed:dry all passed — see §5). **`npm run seed:generate` is running in the background right now** (started ~18:44, Anthropic Claude Haiku 4.5, ~38% through as of this update, ETA ~55-65 min total from start). While it runs, all of Phase A2 (extraction) and all four Phase A3 query functions were written and typechecked — see §5 for the full breakdown and the explicit "verification debt" list of what's typechecked-only vs. runtime-verified against live data.

**The moment generation finishes:** verify raw counts in Postgres (`SELECT count(*) FROM raw_tickets` etc. — expect ~956/63/14), then move to extraction (§5 Phase A2 step 5). Everything needed to do that is already written.

## 10. PARALLEL WORK PLAN — what Person A and Person B can each do RIGHT NOW

The critical path is sequential and can't be parallelized around: **generation finishes → verify counts → extraction runs → mentions populated in ClickHouse → the 4 query functions get verified against real data (incl. the scoring formula review promised to the user) → `createAgentStream()` + `chat.agent()` get built against verified data → end-to-end demo test → deploy → record video → submit.**

But plenty of real work doesn't sit on that chain. Split below by who owns it per `CLAUDE.md`'s boundaries — reassigned slightly from the original split since the frontend is done and the backend surface has grown.

### Person A (backend/data/agent) — do these now, don't wait for generation
1. **Set up the Trigger.dev Cloud project** (account, `TRIGGER_PROJECT_REF`, `TRIGGER_SECRET_KEY` in `.env.local`). This is a dashboard/auth task — needs a human, an AI assistant can't do it. It unblocks two things at once: running `trigger/extract-mentions.ts` for real, and eventually deploying `chat.agent()`. Currently the single biggest blocker to finishing Phase A2 once mentions data exists.
2. **Draft `docs/architecture.md`** with a Mermaid diagram — judges look at this for the OLTP+OLAP bonus prize (§8). This describes architecture that's *already built* (the Postgres/ClickHouse split, the extraction pipeline, the 4 query functions, the StreamEvent contract) — it needs zero live data, purely a writeup of what exists. High leverage, zero blocking dependency.
3. **Scaffold `trigger/sync-oltp-to-olap.ts`** (Phase A4) — same pattern successfully used for extraction: write the sync logic (propagate `accounts.arr`/`deals` changes from Postgres → the denormalized `account_arr`/`account_segment` columns on ClickHouse `mentions`) as plain testable functions first, typecheck now, verify once mentions exist.
4. **Sketch `trigger/agent.ts`'s structure** — the system prompt shape, the 4 tool registrations (referencing the now-built query functions), the hybrid-orchestration skeleton (scripted main flow / LLM-driven follow-ups, per the decision in §2). The exact chapter-by-chapter logic still needs real data to verify against, but the scaffolding doesn't.
5. Once generation finishes (sequential from here): verify → run extraction → **review the scoring formula's actual output together** (this was explicitly promised, not a silent finalize) → finish `createAgentStream()` + `chat.agent()` → end-to-end test.

### Person B (frontend/deploy/demo/submission) — do these now, fully independent of generation
1. **Verify the live Vercel deployment actually works** end-to-end in mock mode — hasn't been re-confirmed since the frontend merged to `main`. Quick sanity check, catches any build/env surprise before it's a Tuesday-deploy-day problem.
2. **Stress-test the 7 chart components against larger/edge-case data shapes than the hand-crafted mock uses** — e.g. `evidence-cards` with 20 quotes instead of 5, `opportunity-ranking` with all 8 themes at once, `volume-trap` with a different trap/gem distribution. Real data will look nothing like the mock's tidy hand-picked numbers; better to find a layout break now than during the live demo.
3. **Draft the demo video shot list/script** against the current mock demo — it already reproduces all three wow-moments identically to what the live agent will show. Script now, re-record once the live agent is verified; doesn't need to wait.
4. **Fix `README.md`** — currently 2 lines, effectively empty. A public hackathon repo needs a real one (what it is, how to run it, the architecture at a glance). Independent of everything else.
5. **Polish `SUBMISSION.md`** — draft exists (tagline/summary/ClickHouse+Trigger paragraph). Flag which numbers are still mock-derived placeholders (e.g. "$9.6M ARR represented") vs. ones that need swapping for real output once the agent runs live.

### Explicitly NOT yet safe to parallelize into
Don't start `createAgentStream()`/`chat.agent()` chapter logic, and don't treat the scoring formula's `build_now`/`build_next`/`deprioritize` calls as final, until real `mentions` data has been run through them once. Building further on unverified numbers just compounds the risk if the formula needs tuning.
