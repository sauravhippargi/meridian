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

### Frontend + streaming (Person B, DONE; live seam wired)
- Next.js 14 App Router + TypeScript strict + Tailwind + Recharts + framer-motion.
- The frontend consumes an **NDJSON stream of typed `StreamEvent`s** (defined in `types/chapter.ts`), NOT raw Trigger.dev tool-call events.
- **The integration seam:** `createAgentStream(body: ChatRequest): AsyncGenerator<StreamEvent>` in `lib/agent-stream.ts` — **implemented** (Trigger `stream-meridian-answer` + in-process fallback). Person B owns NDJSON encoding (`app/api/chat/ndjson.ts`) + route wiring (`route.ts` branches on `NEXT_PUBLIC_AGENT_MODE`).
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

Three are **frontend-shaped** — transforms in `lib/queries/transforms.ts` (`toStatRow` / `toVolumeTrap` / `toTrendLines`). Aggregate inputs produced by `lib/queries/signal-summary.ts` (verified live):
- `stat_row` ← `SignalSummary`
- `volume_trap` ← `ThemeVolumeStat[]`
- `trend_lines` ← `ThemeTrend[]`

---

## 4. What is DONE (verified)

### Live data (re-counted 2026-07-20 night)
| Store | Metric | Count |
| --- | --- | ---: |
| Postgres | accounts | 123 |
| Postgres | raw_tickets | 956 |
| Postgres | raw_transcripts | 63 |
| Postgres | deals (lost) | 14 (11) |
| ClickHouse | mentions | **1,802** |
| ClickHouse | dunning mentions | 582 |

### Backend foundation (Phases A1–A5 code on `main`)
- Schemas + clients (`lib/db/*`), seed generator (`scripts/seed/*`), seed JSON under `data/seed/`
- Extraction pipeline + Trigger tasks (`lib/extraction/*`, `trigger/extract-mentions.ts`) — Trigger.dev SDK **v4.5.5**
- Queries + scoring (`lib/queries/*`) — **`build_next` floor = 53** in `opportunity-scoring.ts`
- Agent stream: `lib/agent-stream.ts` + `lib/agent/prioritize-flow.ts` + `trigger/agent.ts` (`chat.agent` `meridian-chat`) + `trigger/streams.ts`
- A4: `trigger/sync-oltp-to-olap.ts` + `docs/architecture.md`
- A5 materials: MIT `LICENSE`, rewritten `README.md`, `SUBMISSION.md` with real counts
- E2E: `scripts/e2e-live-stream.ts` — 85 events / 6 chapters / three wow moments (passed)

### Frontend (Person B) — DONE
- Full UI in mock mode; all 7 visuals; three wow moments in mock.
- Live path ready: `route.ts` → `createAgentStream` when `NEXT_PUBLIC_AGENT_MODE=live` (still defaults to `mock`).
- Transforms: `lib/queries/transforms.ts`.

### Environment (DONE)
- `.env.local` has ClickHouse, Postgres (ClickHouse-managed), multi-provider LLM keys (`GEN_PROVIDER` / `EXTRACT_PROVIDER`).
- Vercel env mirrored. ClickHouse ping OK.
- Multi-provider generation/extraction wiring done (Anthropic used for full seed; Groq/others available).

### Seed artifacts (committed)
- 123 accounts / 8 themes / 8 competitors / opportunity-truth with planted blocked deals.

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
4. [x] `npm run seed:generate` — ✅ **DONE. Confirmed in Postgres, not just log output** (a prior attempt's misleading exit-code capture taught to always verify with a real `SELECT count(*)` — see the provider saga below). **956 tickets / 63 transcripts / 14 deals (11 lost, 3 in_progress) actually persisted.** Total cost **$1.22** on Anthropic Claude Haiku 4.5 (topped-up key). PHASE A1 IS COMPLETE.
5. [x] Verify: spot-checked planted deals + random tickets + segment distribution — all correct (see below). Full mentions-level verification happens after Phase A2 extraction.

**Provider saga (2026-07-20 evening — for context on why `.env.local` has 4 LLM keys):** Anthropic's original key ran out of credit 76% through a run (zero rows — `generate-data.ts` persists everything in ONE transaction at the very end, so a crash means nothing lands, not a partial write). Tried xAI (Grok) — account hit its spending limit on the first call. Tried Groq — code-verified working, but its structured-output-capable models cap at 200K tokens/day, about half the ~395K estimated need. Evaluated Cerebras (1M tokens/day but only 5 req/min → ~3.5-4hr run) but didn't commit. **Resolved by topping up the Anthropic account with a new key** — re-ran the full generation, verified success against live Postgres (not just the log), $1.22 total. `scripts/seed/llm.ts` now supports `GEN_PROVIDER=anthropic|google|openai|xai|groq|cerebras` if ever needed again.

**Real spot-check results (verified against actual Postgres data, not samples):**
- Planted blocked-deal accounts landed correctly: Retool→`usage_based_billing` ($204,507 lost), Airtable→`multi_entity_invoicing` ($737,096 lost), Attio→`salesforce_sync` ($67,232 lost) — ARR-scaled amounts, matches `opportunity-truth.json` exactly.
- Random ticket sample reads realistically and on-theme (dunning/webhook tickets sampled, correct severity register).
- Ticket count by account segment: 643 SMB / 229 mid-market / 84 enterprise — exactly the volume-trap shape the demo needs (lots of SMB noise, less enterprise signal, ARR-weighting will need to see through this at the ranking stage).

### Phase A2 — Extraction pipeline ✅ DONE (live ClickHouse populated)
1. [x] `lib/extraction/schema.ts` + `prompts.ts` + `model.ts` + `extract.ts` — closed-taxonomy Zod schema, verbatim-offset location, provider-agnostic (`EXTRACT_PROVIDER`, Groq supported).
2. [x] **Quality gate PASSED** — 20/20 theme + offset accuracy on real samples.
3. [x] `lib/extraction/pipeline.ts` — ticket/transcript LLM path + deterministic deal-loss mentions; pg `Date` coercion fixed.
4. [x] `trigger/extract-mentions.ts` — upgraded to **Trigger.dev SDK v4.5.5** (`@trigger.dev/sdk`, not `/v3`). Queue concurrency + 1h TTL. Cloud retired v3.
5. [x] **Full extraction + backfill run.** Smoke-tested one ticket/transcript/deal_loss via live worker → ClickHouse. First pass incomplete (TTL/queue); backfill recovered to **~97% source coverage**. Verified live: **1,802 mentions** in ClickHouse (956 tickets / 63 transcripts / 11 lost deals in Postgres). Expected ~5k was an overestimate — real docs yield fewer mentions/source.
6. [x] Distribution spot-check: dunning highest raw count (~582); usage-based highest enterprise ARR + 6 deal losses; multi-entity low volume, high ARR, greenfield, 2 deal losses.

### Phase A3 — Query functions + agent ✅ DONE
1. Four query functions — **runtime-verified against live mentions**:
   - [x] `getCompetitivePosition` — greenfield multi-entity confirmed
   - [x] `getThemeEvidence` / `getImpactProjection` / `listOpportunitiesRanked` / `signal-summary` — verified via `scripts/verify-queries.ts`
2. [x] Aggregate shapes for FE transforms — verified
3. **SCORING FORMULA — REVIEWED ON LIVE DATA; USER DECISION APPLIED:**
   ```
   signal_strength = 0.35×norm(enterprise_arr_weighted) + 0.25×norm(deal_loss_count)
                    + 0.20×norm(avg_severity) + 0.15×norm(mention_count) + 0.05×norm(recency_weighted)
   ```
   Recommendation rules: `build_now` = signal≥70 AND lost-deal; **`build_next` = signal≥53** (was 55 — lowered 2026-07-21 so multi-entity at 53 gets build_next) AND (greenfield OR ≥3 enterprise); `watch` = signal≥35 AND rising recency; else `deprioritize`.
   **Live ranked table (180d window, verified):**
   | Rank | Theme | Signal | Reco |
   | ---: | --- | ---: | --- |
   | 1 | usage_based_billing | 89.6 | build_now |
   | 2 | multi_entity_invoicing | 53 | build_next (greenfield) |
   | 3 | webhook_reliability | 44 | watch |
   | 4 | dunning_customization | 33.4 | deprioritize (582 mentions — volume trap) |
   | 7 | latam_tax | 23 | deprioritize (not `watch` — signal <35; left untuned) |
4. [x] Competitor feature→theme map
5. [x] `createAgentStream()` + `lib/agent/prioritize-flow.ts` — hybrid scripted chapters; Trigger task `stream-meridian-answer` + in-process fallback
6. [x] `chat.agent()` (`meridian-chat` in `trigger/agent.ts`) — scripted path + LLM+tools follow-ups
7. [x] E2E: `scripts/e2e-live-stream.ts` — 85 events, 6 chapters, three wow moments (volume trap / hidden gem / evidence). Headline correct.

### Phase A4 — OLTP+OLAP sync + docs ✅ CODE DONE
1. [x] `trigger/sync-oltp-to-olap.ts` — task + hourly `schedules.task` propagates account ARR/segment Postgres→ClickHouse mutations
2. [ ] Optional live ingestion ticker — not started
3. [ ] Secondary tools — not started
4. [ ] Query optimization pass — not started (queries already sub-second on 1.8k rows)
5. [x] `docs/architecture.md` with Mermaid OLTP+OLAP diagram

### Phase A5 — Deploy + submit ⏳ PARTIAL
1. [x] `npx trigger.dev@4.5.5 deploy` — **SUCCEEDED** 2026-07-21 as version `20260721.1` (6 tasks). Cloud smoke: `stream-meridian-answer` → 6 chapters / COMPLETED / correct prioritize headline (`CLOUD VERIFY OK`).
2. [x] `SUBMISSION.md` updated with real verified counts
3. [ ] Demo video — **user records** (open on live product, max 5 min)
4. [x] MIT `LICENSE`; `README.md` rewritten (was 2-line placeholder)
5. [x] Repo is **public** on GitHub (`sauravhippargi/meridian`)
6. [ ] Hackathon submission form — user
7. [ ] Flip `NEXT_PUBLIC_AGENT_MODE=live` on **Vercel** (teammate-owned project) + confirm local already `live` for recording

**Process rule (ongoing):** Keep updating this CONTEXT.md after each verified milestone and commit it with related work — do not let it drift.

**Hosting ownership (important):**
- **Vercel project is on the teammate's account** (production URL: `https://meridian-mu-beryl.vercel.app`). Sparsh (repo owner) cannot flip Production env vars there — teammate must set them.
- **Trigger.dev Cloud** is on Sparsh's account (`proj_itrmpnqxuhbpcqlwtorl`). Sparsh owns Trigger deploy + Trigger dashboard env.

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

## 9. WHAT'S LEFT (updated 2026-07-21 — post Trigger Cloud deploy)

Phases A1–A4 + live extraction + agent E2E + **Trigger Cloud deploy** are **done**. Remaining = Vercel live flip + demo + form.

### Must do before submit
1. [x] **Trigger Cloud deploy** — version `20260721.1` live; cloud stream verify OK
2. [ ] **Teammate: set Vercel env → live** — especially `NEXT_PUBLIC_AGENT_MODE=live`, then **Redeploy Production** (Vercel is teammate-owned; Sparsh cannot do this)
3. [ ] **Record demo video** — open on live product (`https://meridian-mu-beryl.vercel.app`), ≤5 min, land three wow moments
4. [ ] **Hackathon submission form** — morning July 23 preferred (deadline midnight AoE July 23)

### Optional / nice-to-have (not blocking demo narrative)
- LATAM `watch` threshold — currently signal 23 → `deprioritize` (needs ≥35); only tune if you want narrative item #4 as `watch`
- Optional live ingestion ticker, secondary agent tools, query optimization pass (A4 leftovers; queries already sub-second)
- Stress-test chart components against fuller live shapes; demo shot list

Repo is already **public**. Do not change scoring code unless user asks.

## 10. OWNERSHIP & STATUS (updated 2026-07-21)

- **Sparsh (repo / Trigger / data):** Trigger Cloud deploy ✅; Trigger dashboard env; local `.env.local`; demo video + hackathon form (or share with teammate).
- **Teammate (Vercel account):** Production project at `https://meridian-mu-beryl.vercel.app` — must add/update env vars and Redeploy so `NEXT_PUBLIC_AGENT_MODE=live` is baked into the build.

**Keep CONTEXT.md updated after every verified milestone** (process rule going forward).

### Verified facts
- Postgres: 123 accounts / 956 tickets / 63 transcripts / 14 deals (11 lost) — re-counted live
- ClickHouse: **1,802 mentions** (dunning 582) — re-counted live; ~97% source coverage after backfill
- Trigger.dev: **v4.5.5**; Cloud deploy **`20260721.1`** ✅; `stream-meridian-answer` cloud smoke OK (6 chapters)
- Scoring: **`build_next ≥53`** (commit `fd71349`) — usage #1 build_now / multi #2 build_next / dunning deprioritize
- Agent E2E passed (`scripts/e2e-live-stream.ts`); Trigger path preferred, in-process fallback remains
- A4 sync + architecture docs on main; A5 LICENSE/README/SUBMISSION on main
- **Vercel owned by teammate** — live flip is their action item

### Recent commits on main
- `9ab9f37` — Trigger v4 + extraction smoke
- `fd71349` — build_next ≥53 + agent stream
- `9550c7d` — sync, architecture, LICENSE, SUBMISSION, E2E script
- `b46430d` — CONTEXT.md A2–A5 progress sync
- `1d15231` — CONTEXT.md verified counts + remaining work

