# Meridian — Product Intelligence Agent

## What this is
A chat agent for PMs at a fictional B2B SaaS company ("Meridian Payments") that answers questions like "what should we prioritize next quarter?" by reading across support tickets, customer interview transcripts, CRM deal data, and competitive intelligence.

Responses are visual-first — charts, matrices, and evidence cards — not walls of text. This is the hackathon theme: "Beyond the Wall of Text."

## Hackathon constraints (non-negotiable)
- **ClickHouse must be the primary database.** All analytical data (mentions, extracts, aggregations) lives here.
- **Postgres is the OLTP layer** for mutable state (accounts, deals, themes taxonomy). We are deliberately targeting the "best OLTP+OLAP integration" bonus prize.
- **The agent must use Trigger.dev `chat.agent()`.** Not a Next.js API route. Not a raw Vercel AI SDK route. The `chat.agent()` primitive from Trigger.dev is the required orchestration layer.
- **Background jobs use Trigger.dev tasks.** Ingestion, extraction, dedup, and sync all run as Trigger.dev tasks with `batchTrigger` for fan-out.
- **All code must be written during July 17-23, 2026.** No pre-existing code from prior projects. Public libraries, public datasets, and AI assistants are permitted.

## Tech stack (locked — do not suggest alternatives)
- Frontend: Next.js 14 (App Router), TypeScript, Tailwind CSS, Recharts, shadcn/ui
- Agent: Trigger.dev `chat.agent()` with Vercel AI SDK
- LLM: Anthropic Claude for synthesis (higher quality), OpenAI GPT-4o-mini or Gemini Flash for bulk extraction (cost)
- Data: ClickHouse Cloud (primary), Postgres (OLTP, hosted anywhere)
- Deployment: Vercel (frontend), Trigger.dev Cloud (agent + tasks)

## Company context
Meridian Payments is a fictional Stripe-competitor. Its Billing team owns subscriptions, invoicing, revenue recognition, tax. The user is a PM on that team, preparing for Q4 planning.

Fictional competitors: Stripe, Adyen, Braintree, Metronome, Orb, Chargebee, Zuora. All are being used as public reference points, not as anything Meridian sends data to.

## The opportunity truth (the "right answer" the demo reveals)
The agent's job is to correctly identify:
1. Usage-based billing enhancements — **#1 recommendation** (enterprise ARR, competitive urgency, blocked deals)
2. Multi-entity consolidated invoicing — **#2 hidden gem** (small footprint, top-15 enterprise, greenfield)
3. Dunning email customization — **correctly deprioritized** despite highest raw volume (mostly SMB, no enterprise blocks)
4. LATAM tax handling — **Q1 watch** (growing signal, not urgent)
5. Hybrid RevRec, webhook reliability, Salesforce sync, invoice templates — **backlog**

The demo must land three "wow" moments: (1) the volume-trap detection on dunning emails, (2) the hidden-gem surfacing of multi-entity, (3) the provenance drill-down showing exact source quotes.

## Data volume targets
- ~120 accounts (10 enterprise, 30 mid-market, 80 SMB), total ~$15M ARR
- ~900 support tickets across 6 months
- ~55 customer interview transcripts (30-60 min each)
- ~200 deal records (won/lost/in-progress) with loss reasons
- ~5,000 extracted mentions in ClickHouse after LLM extraction
- 1 competitor matrix JSON (7 competitors × 20 features)

## Repository structure
- `/app` — Next.js pages and routes
- `/app/(chat)` — chat interface routes
- `/components/charts` — visualization components (Person B)
- `/components/chat` — chat UI components (Person B)
- `/lib/db` — ClickHouse + Postgres clients, schema (Person A)
- `/lib/extraction` — LLM extraction prompts and logic (Person A)
- `/lib/queries` — aggregation query functions (Person A)
- `/trigger` — Trigger.dev tasks (Person A)
- `/trigger/agent.ts` — the chat.agent() definition
- `/types` — shared TypeScript types (both — shared contract)
- `/data` — seeded raw data files (Person A generates)
- `/scripts` — data generation scripts (Person A)

## Ownership boundaries (do not cross)
- **Person A owns:** `/lib/*`, `/trigger/*`, `/scripts/*`, `/data/*`, all SQL, all data generation, all extraction prompts, all query logic
- **Person B owns:** `/app/*`, `/components/*`, all visualization work, all chat UI, all styling, the demo video
- **Shared (both edit via PR):** `/types/*`, `CLAUDE.md`, `README.md`, contract JSON samples

If you need something outside your ownership boundary, ask the other person via Slack. Do not edit their files directly.

## Design principles for the agent
- Every claim in a response must be traceable to a source (ticket ID, interview timestamp, or deal ID). No hallucinated numbers.
- Prefer more tool calls with narrow queries over one giant query. This keeps ClickHouse fast and the agent's reasoning legible.
- The agent should stream responses as "chapters" — each chapter is a short text intro + a rendered visual + optional callouts.
- If the answer is a paragraph, we've failed the brief.

## Style
- TypeScript strict mode. No `any` types.
- Async/await, not `.then()`.
- Single-quote strings, semi-colons on.
- Named exports, not default exports.
- Small files. Split when a file exceeds ~200 lines.
- Comments explain *why*, not *what*.