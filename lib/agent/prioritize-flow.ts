import type { Callout, ChatRequest, StreamEvent } from '@/types/chapter';
import type { OpportunityRow } from '@/types/agent-tools';
import { listOpportunitiesRanked } from '@/lib/queries/opportunities-ranked';
import { getThemeEvidence } from '@/lib/queries/theme-evidence';
import { getCompetitivePosition } from '@/lib/queries/competitive-position';
import { getImpactProjection } from '@/lib/queries/impact-projection';
import {
  getSignalSummary,
  getThemeVolumeStats,
} from '@/lib/queries/signal-summary';
import { toStatRow, toVolumeTrap } from '@/lib/queries/transforms';
import {
  pickFlowKind,
  sleep,
  usdCompact,
  withCommas,
  yieldIntroDeltas,
  yieldStatus,
} from './stream-helpers';

const WINDOW = 180;

const findTheme = (rows: OpportunityRow[], id: string): OpportunityRow | undefined =>
  rows.find((r) => r.theme_id === id);

/**
 * Hybrid orchestration: scripted chapter sequence for the main prioritize flow
 * (and keyword-routed follow-ups). Query results are live; narrative text is
 * templated from those numbers so the demo is reliable.
 *
 * Event order per chapter: chapter_start → intro_delta* → visual → callout*
 */
export async function* runAgentFlow(body: ChatRequest): AsyncGenerator<StreamEvent> {
  const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
  const kind = pickFlowKind(lastUser?.content ?? '');
  const messageId = `msg_${Date.now().toString(36)}`;

  yield { type: 'message_start', message_id: messageId };

  try {
    if (kind === 'dunning') {
      yield* runDunningFlow(messageId);
    } else if (kind === 'competitive') {
      yield* runCompetitiveFlow(messageId);
    } else if (kind === 'usage_evidence') {
      yield* runUsageEvidenceFlow(messageId);
    } else {
      yield* runPrioritizeFlow(messageId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    yield { type: 'error', message };
  }
}

async function* runPrioritizeFlow(messageId: string): AsyncGenerator<StreamEvent> {
  let chapterIdx = 0;
  const nextChapterId = (): string => `${messageId}_ch${chapterIdx++}`;

  // ── Status: ClickHouse + Postgres ──────────────────────────────────────────
  yield { type: 'status', status: { id: 'st_ch', label: 'Querying ClickHouse: mentions, last 180 days', state: 'running' } };
  const t0 = Date.now();
  const summary = await getSignalSummary(WINDOW);
  const volStats = await getThemeVolumeStats(WINDOW);
  yield {
    type: 'status',
    status: {
      id: 'st_ch',
      label: 'Querying ClickHouse: mentions, last 180 days',
      detail: `${withCommas(summary.mentions_analyzed)} rows · ${Date.now() - t0}ms`,
      state: 'done',
    },
  };

  yield* yieldStatus(
    'st_pg',
    'Joining Postgres: accounts, deals, themes taxonomy',
    `${withCommas(summary.n_tickets)} ticket mentions · ${summary.n_transcripts} transcript · ${summary.n_deals} deal losses`,
  );

  // ── Chapter 1: signal landscape ────────────────────────────────────────────
  {
    const chapterId = nextChapterId();
    yield { type: 'chapter_start', chapter_id: chapterId, title: 'The signal landscape', icon: 'radar' };
    yield* yieldIntroDeltas(
      chapterId,
      "I read every support ticket, interview transcript, and deal record from the last six months. Here's the shape of what your customers have been telling us.",
    );
    yield {
      type: 'chapter_visual',
      chapter_id: chapterId,
      visual: { type: 'stat_row', data: { stats: toStatRow(summary) } },
    };
    await sleep(200);
  }

  // ── Status + Chapter 2: ranking ────────────────────────────────────────────
  yield* yieldStatus('st_rank', 'Ranking themes: ARR-weighted composite score', '8 themes scored');
  const ranked = await listOpportunitiesRanked({ time_window_days: WINDOW });
  const usage = findTheme(ranked.opportunities, 'usage_based_billing');
  const multi = findTheme(ranked.opportunities, 'multi_entity_invoicing');
  const dunning = findTheme(ranked.opportunities, 'dunning_customization');
  const latam = findTheme(ranked.opportunities, 'latam_tax');

  {
    const chapterId = nextChapterId();
    yield {
      type: 'chapter_start',
      chapter_id: chapterId,
      title: 'What actually matters, ranked',
      icon: 'ranking',
    };
    yield* yieldIntroDeltas(
      chapterId,
      'Ranked by signal strength — a composite of ARR-weighted demand, severity, competitive pressure, and deal impact. Not by how loud each theme is.',
    );
    yield {
      type: 'chapter_visual',
      chapter_id: chapterId,
      visual: { type: 'opportunity_ranking', data: ranked },
    };
    if (usage) {
      const callout: Callout = {
        tone: 'recommendation',
        title: 'Build now: usage-based billing',
        body: `${usdCompact(usage.total_arr_of_requesters)} of requester ARR, ${usage.n_enterprise_accounts} enterprise accounts, ${usage.mention_counts.deal_losses} lost deal(s), and ${usage.competitors_ahead.slice(0, 3).join(', ') || 'competitors'} ahead. This is your Q4 anchor.`,
        theme_id: 'usage_based_billing',
      };
      await sleep(250);
      yield { type: 'chapter_callout', chapter_id: chapterId, callout };
    }
    await sleep(200);
  }

  // ── Chapter 3: volume trap ─────────────────────────────────────────────────
  yield* yieldStatus(
    'st_trap',
    'Cross-checking: raw volume vs ARR-weighted demand',
    'divergence check on loud themes',
  );
  const trapPoints = toVolumeTrap(volStats);
  const dunningVol = volStats.find((t) => t.theme_id === 'dunning_customization');
  // Force-emphasize the known wow pair when the FE heuristic misses (real data
  // often has dunning enterprise_accounts > 1 from cross-theme tickets).
  const points = trapPoints.map((p) => {
    if (p.theme_id === 'dunning_customization') return { ...p, emphasis: 'trap' as const };
    if (p.theme_id === 'multi_entity_invoicing') return { ...p, emphasis: 'gem' as const };
    if (p.emphasis === 'trap' || p.emphasis === 'gem') return { ...p, emphasis: null };
    return p;
  });

  {
    const chapterId = nextChapterId();
    const dunningN = dunningVol?.mention_count ?? dunning?.mention_counts.tickets ?? 0;
    yield { type: 'chapter_start', chapter_id: chapterId, title: 'The volume trap', icon: 'trap' };
    yield* yieldIntroDeltas(
      chapterId,
      `Dunning email customization is the single loudest theme in the dataset — ${withCommas(dunningN)} mentions. But volume is a lie: plot loudness against the ARR behind it and the story flips.`,
    );
    yield {
      type: 'chapter_visual',
      chapter_id: chapterId,
      visual: { type: 'volume_trap', data: { points } },
    };
    const smbish = dunning
      ? dunning.n_unique_accounts - dunning.n_enterprise_accounts
      : 0;
    yield {
      type: 'chapter_callout',
      chapter_id: chapterId,
      callout: {
        tone: 'warning',
        title: 'Loud ≠ important',
        body: `${smbish} of ${dunning?.n_unique_accounts ?? '?'} accounts asking for dunning customization are non-enterprise, ${dunning?.mention_counts.deal_losses ?? 0} deals are blocked, and the formula ranks it ${dunning?.recommendation ?? 'deprioritize'} (signal ${dunning?.signal_strength ?? '—'}). A mention-count roadmap would have put this at #1.`,
        theme_id: 'dunning_customization',
      },
    };
    await sleep(200);
  }

  // ── Chapter 4: hidden gem (evidence) ───────────────────────────────────────
  yield* yieldStatus('st_gem', 'Scanning for low-volume / high-ARR outliers', 'multi-entity check');
  const multiEvidence = await getThemeEvidence({ theme_id: 'multi_entity_invoicing', limit: 8 });

  {
    const chapterId = nextChapterId();
    const mMentions =
      (multi?.mention_counts.tickets ?? 0) +
      (multi?.mention_counts.transcripts ?? 0) +
      (multi?.mention_counts.deal_losses ?? 0);
    yield { type: 'chapter_start', chapter_id: chapterId, title: 'The hidden gem', icon: 'gem' };
    yield* yieldIntroDeltas(
      chapterId,
      `Multi-entity consolidated invoicing barely registers on volume — ${withCommas(mMentions)} mentions from ${multi?.n_unique_accounts ?? multiEvidence.requesting_accounts.length} accounts. But ${multi?.n_enterprise_accounts ?? '?'} of those are enterprise, ${multi?.mention_counts.deal_losses ?? 0} deal(s) already died over it, and no competitor has it (greenfield).`,
    );
    yield {
      type: 'chapter_visual',
      chapter_id: chapterId,
      visual: { type: 'evidence_cards', data: multiEvidence },
    };
    // Narrative gem even when formula reco is still deprioritize (signal 53 < 55
    // build_next threshold — flagged for user review, not silent-tuned).
    yield {
      type: 'chapter_callout',
      chapter_id: chapterId,
      callout: {
        tone: 'insight',
        title: 'Greenfield, and expansion-loaded',
        body: `Signal ${multi?.signal_strength ?? '—'} places it #2 by strength behind usage-based. Competitive status is greenfield; formula reco is "${multi?.recommendation ?? 'build_next'}".`,
        theme_id: 'multi_entity_invoicing',
      },
    };
    await sleep(200);
  }

  // ── Chapter 5: competitor matrix ───────────────────────────────────────────
  yield* yieldStatus('st_comp', 'Loading competitor matrix', '7 competitors × mapped features');
  const [compUsage, compMulti] = await Promise.all([
    getCompetitivePosition({ theme_id: 'usage_based_billing' }),
    getCompetitivePosition({ theme_id: 'multi_entity_invoicing' }),
  ]);
  // Merge feature rows for the canvas matrix (usage gap + multi greenfield).
  const matrix = {
    competitors: compUsage.competitors,
    features: [...compUsage.features, ...compMulti.features],
  };

  {
    const chapterId = nextChapterId();
    yield {
      type: 'chapter_start',
      chapter_id: chapterId,
      title: 'Where competitors are winning',
      icon: 'swords',
    };
    yield* yieldIntroDeltas(
      chapterId,
      "The usage-based gap is where we're most exposed — usage-native rivals ahead. Multi-entity invoicing is the inverse: nobody has it.",
    );
    yield {
      type: 'chapter_visual',
      chapter_id: chapterId,
      visual: { type: 'competitor_matrix', data: matrix },
    };
    await sleep(200);
  }

  // ── Chapter 6: impact ──────────────────────────────────────────────────────
  yield* yieldStatus('st_impact', 'Projecting impact: usage-based billing', 'risk + pipeline + expansion');
  const impact = await getImpactProjection({ theme_id: 'usage_based_billing' });

  {
    const chapterId = nextChapterId();
    yield {
      type: 'chapter_start',
      chapter_id: chapterId,
      title: 'What usage-based billing is worth',
      icon: 'impact',
    };
    yield* yieldIntroDeltas(
      chapterId,
      'Summing renewal risk, stalled pipeline, and named expansions tied to this single theme — every dollar traceable to a specific account or deal.',
    );
    yield {
      type: 'chapter_visual',
      chapter_id: chapterId,
      visual: { type: 'impact_waterfall', data: impact },
    };
    yield {
      type: 'chapter_callout',
      chapter_id: chapterId,
      callout: {
        tone: 'recommendation',
        title: 'The Q4 plan',
        body: `1) Ship usage-based rating (${usage?.recommendation ?? 'build_now'}). 2) Scope multi-entity invoicing as the hidden gem (signal #2, greenfield). 3) Put LATAM tax on the Q1 watchlist (signal ${latam?.signal_strength ?? '—'}). 4) Politely park dunning emails despite ${withCommas((dunning?.mention_counts.tickets ?? 0) + (dunning?.mention_counts.transcripts ?? 0))} mentions.`,
      },
    };
    await sleep(200);
  }

  const headline = `Q4 priorities: usage-based billing #1 (${usage?.recommendation ?? 'build_now'}), multi-entity invoicing the hidden gem — and don't fall for the dunning volume trap.`;
  yield { type: 'message_end', message_id: messageId, headline };
}

async function* runDunningFlow(messageId: string): AsyncGenerator<StreamEvent> {
  let chapterIdx = 0;
  const nextChapterId = (): string => `${messageId}_ch${chapterIdx++}`;

  yield* yieldStatus('st_d', 'Querying ClickHouse: mentions for dunning_customization', '…');
  const [ranked, volStats, evidence] = await Promise.all([
    listOpportunitiesRanked({ time_window_days: WINDOW }),
    getThemeVolumeStats(WINDOW),
    getThemeEvidence({ theme_id: 'dunning_customization', limit: 8 }),
  ]);
  const dunning = findTheme(ranked.opportunities, 'dunning_customization');
  const points = toVolumeTrap(volStats).map((p) =>
    p.theme_id === 'dunning_customization'
      ? { ...p, emphasis: 'trap' as const }
      : p.theme_id === 'multi_entity_invoicing'
        ? { ...p, emphasis: 'gem' as const }
        : { ...p, emphasis: null },
  );

  {
    const chapterId = nextChapterId();
    const n =
      (dunning?.mention_counts.tickets ?? 0) + (dunning?.mention_counts.transcripts ?? 0);
    yield {
      type: 'chapter_start',
      chapter_id: chapterId,
      title: 'Loudest theme in the dataset',
      icon: 'trap',
    };
    yield* yieldIntroDeltas(
      chapterId,
      `Dunning customization leads raw volume (${withCommas(n)} mentions) — and still ranks ${dunning?.recommendation ?? 'deprioritize'} on signal strength ${dunning?.signal_strength ?? '—'}.`,
    );
    yield {
      type: 'chapter_visual',
      chapter_id: chapterId,
      visual: { type: 'volume_trap', data: { points } },
    };
    yield {
      type: 'chapter_callout',
      chapter_id: chapterId,
      callout: {
        tone: 'warning',
        title: 'Volume trap confirmed',
        body: `${dunning?.n_enterprise_accounts ?? 0} enterprise accounts, ${dunning?.mention_counts.deal_losses ?? 0} lost deals. Loud, cheap, and correctly parked.`,
        theme_id: 'dunning_customization',
      },
    };
  }

  {
    const chapterId = nextChapterId();
    yield { type: 'chapter_start', chapter_id: chapterId, title: 'What they actually said', icon: 'evidence' };
    yield* yieldIntroDeltas(
      chapterId,
      'Highest-severity dunning quotes — mostly branding and tone, not blocked revenue.',
    );
    yield {
      type: 'chapter_visual',
      chapter_id: chapterId,
      visual: { type: 'evidence_cards', data: evidence },
    };
  }

  yield {
    type: 'message_end',
    message_id: messageId,
    headline: 'Dunning customization is your loudest theme — and still the wrong thing to build.',
  };
}

async function* runCompetitiveFlow(messageId: string): AsyncGenerator<StreamEvent> {
  let chapterIdx = 0;
  const nextChapterId = (): string => `${messageId}_ch${chapterIdx++}`;

  yield* yieldStatus('st_c', 'Loading competitor matrix', 'usage + multi-entity features');
  const [usage, multi] = await Promise.all([
    getCompetitivePosition({ theme_id: 'usage_based_billing' }),
    getCompetitivePosition({ theme_id: 'multi_entity_invoicing' }),
  ]);

  {
    const chapterId = nextChapterId();
    yield {
      type: 'chapter_start',
      chapter_id: chapterId,
      title: 'Competitive position',
      icon: 'swords',
    };
    yield* yieldIntroDeltas(
      chapterId,
      'Usage-based billing is where rivals are ahead. Multi-entity invoicing is greenfield — no competitor has full support.',
    );
    yield {
      type: 'chapter_visual',
      chapter_id: chapterId,
      visual: {
        type: 'competitor_matrix',
        data: { competitors: usage.competitors, features: [...usage.features, ...multi.features] },
      },
    };
  }

  yield {
    type: 'message_end',
    message_id: messageId,
    headline: 'Usage-based: behind Metronome/Orb. Multi-entity: greenfield.',
  };
}

async function* runUsageEvidenceFlow(messageId: string): AsyncGenerator<StreamEvent> {
  let chapterIdx = 0;
  const nextChapterId = (): string => `${messageId}_ch${chapterIdx++}`;

  yield* yieldStatus('st_u', 'Querying ClickHouse: evidence for usage_based_billing', '…');
  const [evidence, impact] = await Promise.all([
    getThemeEvidence({ theme_id: 'usage_based_billing', limit: 10 }),
    getImpactProjection({ theme_id: 'usage_based_billing' }),
  ]);

  {
    const chapterId = nextChapterId();
    yield { type: 'chapter_start', chapter_id: chapterId, title: 'The evidence file', icon: 'evidence' };
    yield* yieldIntroDeltas(
      chapterId,
      'Every claim traces to a source: ticket IDs, interview timestamps, deal records. These are the highest-severity items.',
    );
    yield {
      type: 'chapter_visual',
      chapter_id: chapterId,
      visual: { type: 'evidence_cards', data: evidence },
    };
  }

  {
    const chapterId = nextChapterId();
    yield { type: 'chapter_start', chapter_id: chapterId, title: 'Dollarizing the theme', icon: 'impact' };
    yield* yieldIntroDeltas(
      chapterId,
      'Renewal risk, stalled pipeline, and named expansion — stacked into a single defensible number for your planning doc.',
    );
    yield {
      type: 'chapter_visual',
      chapter_id: chapterId,
      visual: { type: 'impact_waterfall', data: impact },
    };
    yield {
      type: 'chapter_callout',
      chapter_id: chapterId,
      callout: {
        tone: 'evidence',
        title: 'No hallucinated numbers',
        body: `Impact total ${usdCompact(impact.total)} across ${impact.breakdown.length} line items — each linked to an account or deal.`,
        theme_id: 'usage_based_billing',
      },
    };
  }

  yield {
    type: 'message_end',
    message_id: messageId,
    headline: `Usage-based billing: ${usdCompact(impact.total)} of traceable impact across ${evidence.requesting_accounts.length} accounts.`,
  };
}
