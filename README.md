# Meridian

**Product intelligence agent for PMs** — ClickHouse & Trigger.dev Virtual Summer Hackathon 2026.

Ask *"what should we prioritize next quarter?"* and Meridian reads across support tickets, customer interviews, CRM deals, and competitive intel, then answers in **visual chapters** (ranked opportunities, volume-trap scatter, evidence cards, competitor matrix, impact waterfall) — not a wall of text.

## Stack

- **ClickHouse Cloud** — primary OLAP store (`mentions`, `theme_scores_daily`)
- **Postgres** — OLTP (accounts, deals, themes, raw sources) on ClickHouse-managed Postgres
- **Trigger.dev** — `chat.agent()`, extraction `batchTrigger`, hourly OLTP→OLAP sync
- **Next.js 14** — chat rail + answer canvas, NDJSON `StreamEvent` contract

## Quick start

```bash
cp .env.example .env.local   # fill ClickHouse, Postgres, Trigger, Anthropic keys
npm install
npm run db:init
npm run seed:load
# raw tickets/transcripts already generated in this repo's live DB path —
# or npm run seed:generate if starting fresh
npm run trigger:dev          # local Trigger worker (separate terminal)
npm run dev                  # Next.js — set NEXT_PUBLIC_AGENT_MODE=live for real agent
```

Mock mode (`NEXT_PUBLIC_AGENT_MODE=mock`) needs no keys and streams the scripted demo.

## Demo narrative (verified on live data)

| Rank | Theme | Signal | Recommendation |
| ---: | --- | ---: | --- |
| 1 | Usage-based billing | 89.6 | `build_now` |
| 2 | Multi-entity invoicing | 53 | `build_next` (hidden gem, greenfield) |
| 4 | Dunning customization | 33.4 | `deprioritize` despite highest raw volume |

## Docs

- [`docs/architecture.md`](docs/architecture.md) — OLTP+OLAP diagram
- [`SUBMISSION.md`](SUBMISSION.md) — hackathon submission copy
- [`CONTEXT.md`](CONTEXT.md) — project handoff / status

## License

MIT — see [LICENSE](LICENSE).
