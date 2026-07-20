# Meridian — Frontend → Backend Integration Handoff

**From:** Person B (frontend) · **To:** Person A (data / agent / Trigger.dev)
**Status:** Frontend fully built and working in **mock mode**. Zero keys needed to run.
**Branch:** `claude/hackathon-chat-frontend-hpii18`

This document is the single source of truth for wiring the real agent to the UI.
Read it top to bottom once, then keep §3 (the contract) open while you build.
Nothing in the frontend needs to change for you to go live — there is exactly
**one seam**, described in §4.

---

## 1. What's built (and what runs today)

Run it right now — no ClickHouse, no Trigger.dev, no keys:

```bash
npm install
npm run dev          # → http://localhost:3000
```

The app boots into **mock mode** (`NEXT_PUBLIC_AGENT_MODE=mock`, the default).
Ask any of the suggested prompts and it streams a complete, realistic answer —
all three demo "wow" moments — from a scripted mock that emits the *exact* event
stream your real agent must emit. **The mock is your reference implementation.**

Verified working: `npx tsc --noEmit` clean, `npm run build` clean, and the full
prioritization scenario driven end-to-end in a real browser (empty state →
6 streamed chapters → headline banner) with all charts and animations rendering.

### The demo storyline the UI is designed around
Straight from `CLAUDE.md`'s "opportunity truth":
1. **Usage-based billing** — #1, `build_now`
2. **Multi-entity consolidated invoicing** — #2 hidden gem, `build_next`
3. **Dunning email customization** — the volume trap, `deprioritize` despite highest raw volume
4. **LATAM tax** — `watch` (Q1)
5. Hybrid RevRec, webhooks, Salesforce sync, invoice templates — backlog

Three wow moments the visuals are built to land: (1) volume-trap detection on
dunning, (2) hidden-gem surfacing of multi-entity, (3) provenance drill-down to
exact source quotes.

---

## 2. Architecture at a glance

```
┌─────────────────────────── Browser (Next.js client) ───────────────────────────┐
│                                                                                 │
│  app/(chat)/page.tsx  ── the whole app: one full-screen workspace               │
│     ├── components/chat/chat-rail.tsx    (390px left rail)                       │
│     │     ├── suggested-prompts / composer / status-ticker                      │
│     │     └── useChat()  ── components/chat/use-chat.ts                          │
│     │            │  POSTs ChatRequest, reads NDJSON stream, builds Turn state    │
│     └── components/canvas/canvas.tsx     (big right canvas)                      │
│           └── chapter-card → visual-renderer → components/charts/*              │
│                                                                                 │
└───────────────────────────────────┬─────────────────────────────────────────────┘
                                     │  POST /api/chat   (ChatRequest → NDJSON)
                                     ▼
                    app/api/chat/route.ts   ◀── THE ONE SEAM (§4)
                       ├── mode 'mock' → app/api/chat/mock/*  (scripted stream)
                       └── mode 'live' → YOU: trigger chat.agent(), pipe its
                                          StreamEvents through as the same NDJSON
                                     │
                                     ▼
                         Trigger.dev  chat.agent()   ◀── YOUR territory
                           ├── tools (typed in types/agent-tools.ts)
                           │     └── query fns in lib/queries/* (you write)
                           ├── ClickHouse  (lib/db/clickhouse.ts — scaffolded)
                           └── Postgres    (OLTP)
```

**Key idea:** the frontend and agent communicate over a stream of typed
`StreamEvent`s encoded as **NDJSON** (one JSON object per line). The frontend
does not know or care whether those events come from the mock or the real agent.

---

## 3. THE CONTRACT (`types/chapter.ts`)

This is the whole interface. Everything is typed — import these types on your
side so the compiler enforces the contract.

### 3.1 Request — what the frontend sends

`POST /api/chat` with body:

```ts
interface ChatRequest {
  conversation_id: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
}
```

`messages` is the running history; the last `user` message is the current
question. (The mock routes on the last user message; your agent gets full history.)

### 3.2 Response — an NDJSON stream of `StreamEvent`

The response body is `Content-Type: application/x-ndjson`. **Each line is one
JSON-encoded `StreamEvent`.** The union:

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

### 3.3 Event-by-event semantics

| Event | When to emit | What the UI does |
|---|---|---|
| `message_start` | Once, first. | Begins a new assistant answer. |
| `status` | One per tool call / query. Emit `state:'running'` when it starts, then the **same `id`** with `state:'done'` + a `detail`. | Rows in the rail's live activity ticker. `detail` e.g. `"4,812 rows · 41ms"`. |
| `chapter_start` | Begin a new answer section. | New card on the canvas (numbered), with `title` + `icon`. |
| `chapter_intro_delta` | Stream the intro text in chunks. | Appends to that chapter's intro, with a live typing caret. Word-sized deltas feel best. |
| `chapter_visual` | Once per chapter, after the intro. | Renders the chart (see §3.5). |
| `chapter_callout` | 0..n per chapter, after the visual. | Highlighted insight/warning/recommendation card. |
| `message_end` | Once, last. | Renders the gradient headline summary banner. `headline` = one punchy sentence. |
| `error` | On failure, any time. | Shows an inline error in the canvas. |

**Ordering per chapter:** `chapter_start` → `chapter_intro_delta`* →
`chapter_visual` → `chapter_callout`*. Chapters are appended in emit order.
`chapter_id` ties deltas/visual/callouts to their chapter — use any stable
unique string (mock uses `"{message_id}_ch{n}"`).

### 3.4 Supporting types

```ts
type ChapterIcon =
  | 'radar' | 'ranking' | 'trap' | 'gem'
  | 'swords' | 'impact' | 'evidence' | 'trend' | 'summary';

interface StatusUpdate {
  id: string;          // stable across the running→done pair
  label: string;       // "Querying ClickHouse: mentions, last 90 days"
  detail?: string;     // "4,812 rows · 41ms" — set on the done event
  state: 'running' | 'done';
}

interface Callout {
  tone: 'insight' | 'warning' | 'evidence' | 'recommendation';
  title: string;
  body: string;
  theme_id?: ThemeId;  // optional deep-link affordance
}
```

### 3.5 Visuals — `ChapterVisual` (the important part)

A discriminated union. **`data` for four of the seven types is *literally* your
tool's typed output from `types/agent-tools.ts` — pass the tool result straight
through, no reshaping.**

```ts
type ChapterVisual =
  | { type: 'stat_row';            data: { stats: StatTile[] } }              // FE-shaped
  | { type: 'opportunity_ranking'; data: ListOpportunitiesOutput }           // ← tool output as-is
  | { type: 'volume_trap';         data: { points: VolumeTrapPoint[] } }     // FE-shaped
  | { type: 'evidence_cards';      data: GetThemeEvidenceOutput }            // ← tool output as-is
  | { type: 'competitor_matrix';   data: GetCompetitivePositionOutput }      // ← tool output as-is
  | { type: 'impact_waterfall';    data: GetImpactProjectionOutput }         // ← tool output as-is
  | { type: 'trend_lines';         data: { series: TrendSeries[] } };        // FE-shaped
```

| Visual | `data` type | Source |
|---|---|---|
| `opportunity_ranking` | `ListOpportunitiesOutput` | `list_opportunities_ranked` tool — **pass through** |
| `evidence_cards` | `GetThemeEvidenceOutput` | `get_theme_evidence` tool — **pass through** |
| `competitor_matrix` | `GetCompetitivePositionOutput` | `get_competitive_position` tool — **pass through** |
| `impact_waterfall` | `GetImpactProjectionOutput` | `get_impact_projection` tool — **pass through** |
| `stat_row` | `{ stats: StatTile[] }` | You assemble — headline KPIs |
| `volume_trap` | `{ points: VolumeTrapPoint[] }` | You assemble — see shape below |
| `trend_lines` | `{ series: TrendSeries[] }` | You assemble — see shape below |

The three frontend-shaped payloads (their full definitions live in `types/chapter.ts`):

```ts
interface StatTile {
  label: string;
  value: string;   // PRE-FORMATTED by you, e.g. "$4.2M" / "312"
  sub?: string;
  delta?: { value: string; direction: 'up' | 'down' | 'flat'; good: boolean };
}

interface VolumeTrapPoint {
  theme_id: ThemeId;
  theme_name: string;
  mention_count: number;        // x-axis: raw loudness
  weighted_arr: number;         // y-axis: sum of requesting accounts' ARR
  n_enterprise_accounts: number;
  emphasis: 'trap' | 'gem' | null;   // drives color + direct label
}

interface TrendSeries {
  theme_id: ThemeId;
  theme_name: string;
  emphasized: boolean;          // true = accent color, false = context gray
  points: { date: string; mentions: number }[];  // ISO week-start dates
}
```

**Adding a brand-new visual type** = PR to `types/chapter.ts` (add a union member)
→ Person B builds the component + adds a `case` in
`components/canvas/visual-renderer.tsx`. Don't add visuals unilaterally; it's a
shared contract file.

---

## 4. Going live — the ONE change you make

The entire mock/live switch lives in **`app/api/chat/route.ts`**. Today it always
runs the mock. To go live, branch on the mode and pipe your agent's stream through:

```ts
// app/api/chat/route.ts  (sketch of the live branch)
export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as ChatRequest;

  if (process.env.NEXT_PUBLIC_AGENT_MODE === 'live') {
    // 1. kick off the Trigger.dev chat.agent() run for this conversation
    // 2. get back an async iterable / ReadableStream of StreamEvent
    // 3. return it as NDJSON with these exact headers:
    return new Response(agentStreamAsNdjson, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
      },
    });
  }

  // ...existing mock path stays exactly as-is (your reference)...
}
```

Your job on the agent side:
1. Define `chat.agent()` in `trigger/agent.ts` with the four tools typed in
   `types/agent-tools.ts`, backed by query fns you write in `lib/queries/*`.
2. As the agent reasons, **emit `StreamEvent`s** in the §3.3 order:
   - tool call start/finish → `status` (running → done)
   - each answer section → `chapter_start` → `chapter_intro_delta`* →
     `chapter_visual` (tool output passed straight into `.data`) → `chapter_callout`*
   - end → `message_end` with a one-line `headline`
3. Serialize each event as `JSON.stringify(event) + '\n'`.

Helper functions are already stubbed for you in `trigger/agent.ts`:
`statusEvent()`, `visualEvent()`, `encodeNdjson()`.

**Study `app/api/chat/route.ts` + `app/api/chat/mock/scenarios.ts`** — they show
exact event ordering, chapter structure, pacing, and realistic data for every
visual. Match that shape and the UI just works.

---

## 5. File map

### Person B owns (frontend — don't edit these; PR if you need a change)
```
app/(chat)/page.tsx                     workspace: rail + canvas
app/layout.tsx  app/globals.css  app/icon.svg
app/api/chat/route.ts                   ◀ THE SEAM (§4)
app/api/chat/mock/
    opportunities.ts                    mock ranking/trend/volume-trap data
    evidence.ts                         mock evidence, competitor matrix, impact
    scenarios.ts                        4 keyword-routed scripts + pickScenario()
components/chat/
    use-chat.ts                         stream reader + Turn state machine
    chat-rail.tsx  composer.tsx  status-ticker.tsx  suggested-prompts.tsx
components/canvas/
    canvas.tsx  chapter-card.tsx  visual-renderer.tsx  callout-card.tsx  empty-state.tsx
components/charts/
    palette.ts                          CVD-validated color tokens
    format.ts                           formatUsd / formatCount / segmentLabel
    chart-frame.tsx                     shared chrome + tooltip
    stat-row.tsx  opportunity-ranking.tsx  volume-trap.tsx
    competitor-matrix.tsx  impact-waterfall.tsx  evidence-cards.tsx  trend-lines.tsx
```

### You own (Person A — scaffolded by B so deps/env exist; contents are yours)
```
trigger.config.ts                       Trigger.dev v3 config, reads env
trigger/agent.ts                        chat.agent() skeleton + StreamEvent helpers
lib/db/clickhouse.ts                    lazy @clickhouse/client singleton, env-driven
lib/queries/*                           (you create) aggregation query fns
lib/extraction/*                        (you create) LLM extraction
scripts/*  data/*                       (you create) data gen + seed
```

### Shared (edit via PR only)
```
types/chapter.ts                        the stream contract (B created)
types/agent-tools.ts                    tool I/O types (you own the tools)
types/{account,mention,theme}.ts        data models
CLAUDE.md  README.md  INTEGRATION.md
```

---

## 6. Config & tooling decisions

- **Next.js 14 App Router + TypeScript strict**, `target: ES2017` in `tsconfig`
  (needed so `for…of` over `.entries()` in the stream route downlevels cleanly).
  Path alias `@/*` → repo root.
- **Tailwind** with a custom light theme (§7). `tailwind.config.ts` holds all UI
  chrome tokens (page/card/ink/line/accent + `shadow-depth-*` ramp + `float-slow`
  / `shimmer` keyframes). **Chart colors are NOT here** — they live in
  `components/charts/palette.ts` (validated against the card surface).
- **Deps:** `next`, `react`, `recharts` (charts), `framer-motion` (animation),
  `lucide-react` (icons), `@clickhouse/client`, `@trigger.dev/sdk`, `zod`,
  `tailwind-merge` + `clsx`. Fonts: Inter (body) + Space Grotesk (display) via
  `next/font`.
- **Style rules** (from `CLAUDE.md`): strict mode, **no `any`**, async/await,
  single quotes + semicolons, **named exports** (exception: Next.js requires
  default exports for `page.tsx`/`layout.tsx`/`route.ts`), small files (<~200 lines),
  comments explain *why* not *what*.
- **Scripts:** `npm run dev` · `build` · `start` · `typecheck` · `trigger:dev`.

---

## 7. Design system (so anything you add matches)

Light "Fluent × Hex.tech" aesthetic. Off-white planes, soft **layered depth**
shadows, generous radii (rounded-2xl/3xl), framer-motion spring entrances,
lucide icons, subtle floating vector glyphs on the empty state.

- Page plane `#f4f3ef`, card surface `#fcfcfb`, strong card `#ffffff`.
- Ink: primary `#0b0b0b`, secondary `#52514e`, muted `#898781`. Lines `#e1e0d9`.
- Accent violet `#4a3aa7` (+ `accent-soft`), plus blue/aqua/amber/coral soft tints.
- Depth ramp: `shadow-depth-4 / -8 / -16 / -glow`.

### Chart palette (`components/charts/palette.ts`) — **do not invent new chart colors**
Validated CVD-safe. Categorical **slots assigned in fixed order, never cycled**:
- **Source types are fixed:** tickets = blue `#2a78d6`, transcripts = green
  `#008300`, deal_losses = magenta `#e87ba4`. (Used in the ranking stacked bars,
  evidence card badges, trend lines.)
- **Magnitude** (signal strength, waterfall) = a single **blue ramp**, light→dark.
- **Status** colors are reserved (good/warning/serious/critical) and always
  paired with an **icon + label**, never color alone.
- **Emphasis** charts (volume-trap, trend-lines) put the story series in an accent
  hue and everything else in context-gray `#c9c7bf`.

If you ever hand back data for a *new* chart, give me the numbers and let the
component choose colors — don't pass hex.

---

## 8. The 7 visual components (what each expects)

| Component | Visual type | Encoding / what it shows |
|---|---|---|
| `stat-row` | `stat_row` | 4 KPI tiles; you pre-format `value` strings + optional delta. |
| `opportunity-ranking` | `opportunity_ranking` | Ranked list; signal-strength bar (blue ramp by magnitude) + stacked source-mix minibar + ARR/accounts + a recommendation badge (`build_now`/`build_next`/`watch`/`deprioritize`). Hover shows `reasoning`. |
| `volume-trap` | `volume_trap` | Scatter: x = mentions (loudness), y = requester ARR. Trap point coral + labeled, gem point violet + labeled, rest gray. This is wow-moment #1. |
| `evidence-cards` | `evidence_cards` | Verbatim quote cards with source-type badge, source ID, date, severity dots, account + ARR + segment; plus an "accounts behind this theme" chip row. Provenance = wow-moment #3. |
| `competitor-matrix` | `competitor_matrix` | Boolean grid (dot = competitor has feature). Highlighted Meridian column with Yes / Gap / **Open** (greenfield) status. Greenfield rows are wow-moment #2 setup. |
| `impact-waterfall` | `impact_waterfall` | Waterfall (risk → unblock → expansion → total) in the blue ramp + a per-account breakdown table, each line tagged At risk / Unblocks / Expansion with its `reason`. |
| `trend-lines` | `trend_lines` | Weekly mentions per theme; emphasized series in accent hue, context in gray. |

All read straight from the §3.5 shapes. The mock files in `app/api/chat/mock/`
contain a full realistic instance of every one — copy those shapes exactly.

---

## 9. Environment & running

`.env.example` documents every var. Copy to `.env.local` (git-ignored).
**The frontend runs with none of them** (mock is the default).

```
NEXT_PUBLIC_AGENT_MODE=mock            # 'mock' | 'live' — the §4 switch
TRIGGER_PROJECT_REF=proj_…             # Trigger.dev dashboard
TRIGGER_SECRET_KEY=tr_dev_…            # dev key for `npx trigger.dev dev`;
                                       #   use tr_prod_… against a deploy
CLICKHOUSE_URL=https://….clickhouse.cloud:8443
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=…
CLICKHOUSE_DATABASE=meridian
POSTGRES_URL=postgres://…              # OLTP — you provision
ANTHROPIC_API_KEY=…                    # agent synthesis
OPENAI_API_KEY=…                       # bulk extraction
```

**Current status of keys** (already set in `.env.local` on B's machine — you'll
set your own locally):
- ✅ ClickHouse Cloud URL/user/password/db — set
- ✅ Trigger.dev project ref + dev key — set (prod key kept as a comment)
- ⬜ `POSTGRES_URL` — **you provision** (OLTP for accounts/deals/themes)
- ⬜ `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` — **you provide** (agent + extraction)

> Note: `.env.local` is git-ignored and only lives locally — it is **never**
> committed. Each of us sets our own. Don't paste real secrets into any tracked
> file (including this one).

### Running the pieces
- **Frontend:** `npm run dev` → localhost:3000
- **Trigger.dev tasks (local):** `npx trigger.dev@latest dev` (uses the dev key,
  hot-reloads `trigger/*`)
- **Deploy tasks:** `npx trigger.dev@latest deploy`

### Deployment targets (per `CLAUDE.md`)
- **Frontend → Vercel.** Import `sauravhippargi/meridian`; it auto-detects
  Next.js. Mirror all `.env.local` vars into Vercel → Settings → Environment
  Variables (Production + Preview). Use the **prod** Trigger key there.
- **Agent + tasks → Trigger.dev Cloud** via `trigger.dev deploy` — a separate
  deploy from Vercel; Vercel does not build your tasks.

> Sandbox caveat discovered during setup: the managed dev container's egress
> proxy only tunnels port **443**, so ClickHouse Cloud's **:8443** HTTPS port
> can't be reached *from inside that specific sandbox*. This is purely a sandbox
> limitation — port 8443 is reachable normally from Vercel and from your laptop
> (`curl -u default:<pw> https://…clickhouse.cloud:8443/ping` returns `Ok.`).

---

## 10. Suggested integration order for Person A

1. **Provision Postgres + set your `.env.local`** (Postgres URL + LLM keys; the
   ClickHouse/Trigger values you already have).
2. **Write the schema + seed data** (`scripts/`, `data/`) and the ClickHouse
   tables per the `types/mention.ts` / `types/account.ts` / `types/theme.ts` models.
3. **Implement the four tools** in `lib/queries/*`, returning exactly the
   `types/agent-tools.ts` output shapes. Unit-test them against seeded data.
4. **Build `chat.agent()`** in `trigger/agent.ts`, emitting `StreamEvent`s in the
   §3.3 order — mirror `app/api/chat/mock/scenarios.ts` for structure and pacing.
5. **Flip the seam:** add the `live` branch in `app/api/chat/route.ts` and set
   `NEXT_PUBLIC_AGENT_MODE=live`. The UI renders your real stream unchanged.
6. **Deploy:** tasks to Trigger.dev Cloud, frontend to Vercel with prod env vars.

Ping me (Person B) if you need a new visual type or a tweak to any `data` shape —
those are `types/chapter.ts` changes and we do them by PR so both sides stay typed.
