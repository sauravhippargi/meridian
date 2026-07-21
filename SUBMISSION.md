# Meridian — Submission Materials

ClickHouse & Trigger.dev Virtual Summer Hackathon 2026.

## Title (≤100 chars)

Meridian: visual product intelligence that ranks what to build next from tickets, interviews, and deals

## Tagline (≤160 chars)

**Meridian reads every ticket, interview, and deal, then answers "what should we build next?" in charts and cited evidence — not a wall of text.** *(148 chars)*

## 500-word solution summary

Product managers drown in qualitative signal. The evidence for what to build next
is real but scattered — hundreds of support tickets, dozens of hour-long customer
interviews, CRM deal notes, competitive teardowns. Reading it all is impossible,
so teams fall back on the loudest request or the highest ticket count. That's the
trap: raw volume systematically over-weights cheap asks from small customers and
buries quiet, high-value opportunities that only a few enterprise accounts have
voiced. Roadmaps get built on noise.

Meridian is a product-intelligence agent for PMs at a B2B SaaS company. You ask a
planning question in plain language — "what should we prioritize next quarter?" —
and it reads across every source, then answers **visually**: a ranked opportunity
board, an ARR-weighted scatter that exposes volume traps, a competitor matrix, an
impact waterfall, and evidence cards where every claim links back to a specific
ticket ID, interview timestamp, or deal record. No hallucinated numbers; every
figure drills down to its source quote.

The demo lands three "wow" moments. **The volume trap:** dunning-email
customization is the single loudest theme (~582 mentions on live data) yet
correctly gets `deprioritize` — mostly non-enterprise requesters and zero deals
blocked. **The hidden gem:** multi-entity consolidated invoicing has far fewer
mentions (~62) but ranks #2 with `build_next` — 9 enterprise accounts, 2 lost
deals, and greenfield competitive status. **Provenance:** every recommendation
traces to verbatim customer quotes in ClickHouse `mentions`.

Under the hood, Meridian is a deliberate **OLAP + OLTP** system. **ClickHouse** is
the primary analytical store: ~1,800 LLM-extracted mentions (theme, source,
severity, account) that the agent aggregates in real time — ranking themes by an
ARR-weighted composite score, computing volume-vs-value divergence, rolling up
daily scores via a materialized view. **Postgres** holds the mutable OLTP state:
the accounts book, deal records, raw tickets/transcripts, and the themes taxonomy.
A Trigger.dev sync task propagates ARR/segment changes from Postgres into
denormalized ClickHouse columns so rankings stay current.

The agent is orchestrated with **Trigger.dev's `chat.agent()`**, with a hybrid
design: a scripted chapter sequence for the main prioritize flow (demo reliability)
and LLM+tools for open follow-ups. Four narrow typed tools (rank opportunities, get
theme evidence, get competitive position, project impact) keep each ClickHouse call
fast. Ingestion and LLM extraction run as Trigger.dev tasks with `batchTrigger`
fan-out. Answers stream to the UI as typed NDJSON `StreamEvent` chapters.

Meridian's thesis: the answer to a roadmap question is not a paragraph. It's a
ranked, sourced, dollar-weighted picture a PM can defend in a planning meeting —
built by an agent that actually read everything.

## How ClickHouse + Trigger.dev are used

**ClickHouse** is the primary database: every extracted mention lands there, and
the agent runs all analytics against it — ARR-weighted theme ranking,
volume-versus-value divergence, daily roll-ups via `theme_scores_daily`.
**Postgres** is the OLTP layer for mutable state (accounts, deals, raw sources,
themes taxonomy). **Trigger.dev** is the orchestration backbone: (1) the agent is
a `chat.agent()` run that streams chapter `StreamEvent`s, and (2) extraction,
`batchTrigger` fan-out, and hourly OLTP→OLAP sync are Trigger.dev tasks.

## Verified live counts (2026-07-21)

| Artifact | Count |
| --- | ---: |
| Accounts | 123 |
| Tickets | 956 |
| Transcripts | 63 |
| Lost deals (blocking theme) | 11 |
| ClickHouse mentions | ~1,801 |
| Themes | 8 |

### Opportunity ranking (signal ≥53 → build_next)

| Rank | Theme | Signal | Reco |
| ---: | --- | ---: | --- |
| 1 | usage_based_billing | 89.6 | build_now |
| 2 | multi_entity_invoicing | 53 | build_next |
| 3 | webhook_reliability | 44 | watch |
| 4 | dunning_customization | 33.4 | deprioritize |
| 7 | latam_tax | 23 | deprioritize |

## Demo video notes (user records)

- Open on live product (`NEXT_PUBLIC_AGENT_MODE=live`), no intro card
- Ask: "what should we prioritize next quarter?"
- Call out: volume trap (dunning), hidden gem (multi-entity), provenance drill-down
- Max 5 minutes
