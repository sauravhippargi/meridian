/**
 * E2E: run createAgentStream for the prioritize prompt and assert chapter
 * ordering + wow moments. Usage: npx tsx scripts/e2e-live-stream.ts
 */
import { config } from 'dotenv';
import { join } from 'path';

config({ path: join(process.cwd(), '.env.local') });

const main = async (): Promise<void> => {
  // Force in-process path for deterministic CI-less verification (still uses
  // the same runAgentFlow that Trigger task + chat.agent share).
  delete process.env.TRIGGER_SECRET_KEY;

  const { createAgentStream } = await import('../lib/agent-stream');
  const events = [];
  for await (const event of createAgentStream({
    conversation_id: 'e2e-test',
    messages: [{ role: 'user', content: 'what should we prioritize next quarter?' }],
  })) {
    events.push(event);
    if (event.type === 'status' && event.status.state === 'done') {
      console.log(`  status: ${event.status.label} — ${event.status.detail ?? ''}`);
    } else if (event.type === 'chapter_start') {
      console.log(`  chapter: ${event.title} (${event.icon})`);
    } else if (event.type === 'message_end') {
      console.log(`  headline: ${event.headline}`);
    } else if (event.type === 'error') {
      console.error('  ERROR:', event.message);
    }
  }

  const types = events.map((e) => e.type);
  const chapters = events.filter((e) => e.type === 'chapter_start');
  const visuals = events.filter((e) => e.type === 'chapter_visual');
  const callouts = events.filter((e) => e.type === 'chapter_callout');
  const end = events.find((e) => e.type === 'message_end');

  const assert = (cond: boolean, msg: string): void => {
    if (!cond) throw new Error(`ASSERT: ${msg}`);
  };

  assert(types[0] === 'message_start', 'starts with message_start');
  assert(types[types.length - 1] === 'message_end', 'ends with message_end');
  assert(chapters.length >= 5, `expected ≥5 chapters, got ${chapters.length}`);
  assert(
    visuals.some((v) => v.type === 'chapter_visual' && v.visual.type === 'opportunity_ranking'),
    'missing opportunity_ranking',
  );
  assert(
    visuals.some((v) => v.type === 'chapter_visual' && v.visual.type === 'volume_trap'),
    'missing volume_trap (wow #1)',
  );
  assert(
    visuals.some((v) => v.type === 'chapter_visual' && v.visual.type === 'evidence_cards'),
    'missing evidence_cards (wow #3 provenance)',
  );
  assert(
    callouts.some((c) => c.type === 'chapter_callout' && /loud/i.test(c.callout.title)),
    'missing volume-trap callout',
  );
  assert(
    callouts.some((c) => c.type === 'chapter_callout' && /greenfield|gem/i.test(c.callout.title)),
    'missing hidden-gem callout',
  );

  // Per-chapter order: start → intro* → visual → callout*
  let i = 0;
  while (i < events.length) {
    const ev = events[i];
    if (ev.type !== 'chapter_start') {
      i += 1;
      continue;
    }
    const chapterId = ev.chapter_id;
    i += 1;
    while (i < events.length && events[i].type === 'chapter_intro_delta') i += 1;
    assert(
      i < events.length && events[i].type === 'chapter_visual',
      `chapter ${chapterId} missing visual after intros`,
    );
    i += 1;
    while (i < events.length && events[i].type === 'chapter_callout') i += 1;
  }

  console.log(`\nOK — ${events.length} events, ${chapters.length} chapters, headline=` +
    (end && end.type === 'message_end' ? end.headline : '?'));
};

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
