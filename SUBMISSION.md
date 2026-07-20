# Meridian — Submission Materials (draft)

> Draft by Person B for tonight's sync. Numbers pulled from the demo "opportunity
> truth"; swap any figure for the real seeded values once extraction runs.

## Tagline (≤160 chars)

**Meridian reads every ticket, interview, and deal, then answers "what should we build next?" in charts and cited evidence — not a wall of text.** *(148 chars)*

Alternates:
- *Your product-intel agent: it reads all the tickets, transcripts, and deals, and answers roadmap questions in charts with a source behind every number.* (152)
- *Ask "what do we build next quarter?" — get a ranked, ARR-weighted answer in visuals, every claim traceable to a ticket, transcript, or lost deal.* (146)

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
customization is the single loudest theme (198 mentions) yet correctly gets
deprioritized — 60 of 61 requesters are SMB and no deal is blocked. **The hidden
gem:** multi-entity consolidated invoicing barely registers on volume (31
mentions) but six of its nine requesters are top-15 enterprise, a deal already
died over it, and no competitor ships it — the agent surfaces it as the #2 bet.
**Provenance:** click any recommendation and read the verbatim customer quotes
behind it.

Under the hood, Meridian is a deliberate **OLAP + OLTP** system. **ClickHouse** is
the primary analytical store: ~5,000 LLM-extracted "mentions" (a theme, a source,
a severity, an account) that the agent aggregates in real time — ranking themes by
an ARR-weighted composite score, computing volume-vs-value divergence, rolling up
weekly trends. **Postgres** holds the mutable OLTP state: the accounts book, deal
records, and the themes taxonomy the extraction pipeline dedups against. Queries
join the two — ClickHouse tells us *how loud* a theme is, Postgres tells us *whose
ARR* is behind it — which is exactly what turns a mention count into a
dollar-weighted priority.

The agent is orchestrated with **Trigger.dev's `chat.agent()`**, calling four
narrow, typed tools (rank opportunities, get theme evidence, get competitive
position, project impact) rather than one giant query — keeping each ClickHouse
call fast and the reasoning legible. Ingestion, LLM extraction, dedup, and
OLAP↔OLTP sync all run as Trigger.dev background tasks with `batchTrigger`
fan-out. The agent streams its answer to the UI as "chapters" — each a short
intro, one visual, and optional callouts — over a typed NDJSON event stream, so
the interface renders results the moment the agent reasons them.

Meridian's thesis: the answer to a roadmap question is not a paragraph. It's a
ranked, sourced, dollar-weighted picture a PM can defend in a planning meeting —
built by an agent that actually read everything.

*(~495 words)*

## "How ClickHouse + Trigger.dev are used" paragraph

Meridian is built as a first-class OLAP + OLTP integration. **ClickHouse** is the
primary database: every extracted mention (theme × source × severity × account)
lands there, and the agent runs all analytics against it — ARR-weighted theme
ranking, volume-versus-value divergence detection, weekly trend roll-ups —
returning in milliseconds over thousands of rows. **Postgres** is the OLTP layer
for mutable state (accounts, deals, the themes taxonomy used for dedup); the
agent's tools join ClickHouse aggregates against Postgres records so a raw mention
count becomes a dollar-weighted, account-attributed priority. **Trigger.dev** is
the orchestration backbone in two ways: (1) the agent itself is a Trigger.dev
`chat.agent()` run that calls four narrow typed tools and streams chapters to the
UI, and (2) all data movement — ingestion, LLM extraction, dedup, and the
OLAP↔OLTP sync — runs as Trigger.dev tasks with `batchTrigger` fan-out for
cost-efficient bulk extraction.
