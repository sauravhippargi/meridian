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
4. [ ] `npm run seed:generate` — full ~1,033-call run. On Anthropic @ ~50/min ≈ **20–30 min, ~$1–2**. No longer one-shot-per-day (paid quota), so re-runnable if needed. **AWAITING USER GO.**
5. [ ] Verify: mentions count, spot-check 20, distribution matches truth.

### Phase A2 — Extraction pipeline (~3-4 hrs)
1. Write extraction prompt in `lib/extraction/prompts.ts` — takes a ticket/transcript, returns `Mention[]` (theme from closed-set taxonomy, severity 1-5, sentiment, verbatim quote, char offsets).
2. **THE CRITICAL QUALITY GATE:** test on 20 samples manually, grade quality, iterate until 80%+ correct. If below 80% after iteration, simplify taxonomy from 8 to 5 themes. DO NOT skip this — bad extraction = bad demo.
3. Wrap in Trigger.dev task `extract_mentions_for_source`, fan-out with `batchTrigger`, Zod-validate, batch-insert to ClickHouse.
4. Run full extraction → ~5,000 mentions.
5. Verify against ground truth: usage-billing highest enterprise-ARR weight, dunning highest raw count but low ARR, multi-entity few but high-ARR.

### Phase A3 — Query functions + agent (~5-7 hrs, the core)
1. Four query functions in `lib/queries/` returning `agent-tools.ts` shapes verbatim: `listOpportunitiesRanked`, `getThemeEvidence`, `getCompetitivePosition`, `getImpactProjection`.
2. ALSO produce the 3 aggregate shapes Person B's transforms need: `SignalSummary`, `ThemeVolumeStat[]`, `ThemeTrend[]`.
3. **The scoring formula** (inside listOpportunitiesRanked) — weights enterprise ARR (heavy), mention frequency (medium), deal-loss count (heavy), severity (medium), recency (light). This is the judgment call that makes the demo narrative work — review it carefully.
4. Note: competitor feature→theme mapping isn't in competitors.json (schema has no field) — `getCompetitivePosition`'s theme_id filter needs a feature→theme constant map in the query layer.
5. Implement `createAgentStream()` in `lib/agent-stream.ts` — the async generator yielding StreamEvents. Hybrid orchestration: scripted sequence for main flow. Honor per-chapter event order.
6. Build `chat.agent()` in `trigger/agent.ts` — system prompt + register 4 tools + chapter orchestration. Stubs exist: statusEvent, visualEvent, encodeNdjson.
7. Verify primary flow end-to-end: "what should we prioritize?" → all chapters stream → wow moments land.

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

## 9. WHAT TO DO RIGHT NOW
ClickHouse ping returns `Ok.`, env is set, Phase A1 code + seed artifacts are committed. The immediate next action is **Step 0** (switch generator to Gemini + lower concurrency), then **Step 1** (run db:init → seed:load → seed:dry → review → seed:generate). Everything is staged for this.
