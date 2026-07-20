import type { ChatRequest, StreamEvent } from '@/types/chapter';
import { pickScenario } from './scenarios';

// Same scripted scenario as before, now expressed as an async generator so it
// shares one code path with the live agent (both are AsyncIterable<StreamEvent>,
// serialized by ndjsonResponse). This IS the reference implementation for the
// event ordering + pacing Person A's chat.agent() must reproduce.
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const INTRO_CHUNK_MS = 24;
const BETWEEN_STEPS_MS = 350;

export async function* mockEventStream(body: ChatRequest): AsyncGenerator<StreamEvent> {
  const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
  const scenario = pickScenario(lastUser?.content ?? '');
  const messageId = `msg_${Date.now().toString(36)}`;

  yield { type: 'message_start', message_id: messageId };

  let chapterIdx = 0;
  for (const [stepIdx, step] of scenario.steps.entries()) {
    if (step.kind === 'status') {
      const id = `st_${stepIdx}`;
      yield { type: 'status', status: { id, label: step.label, state: 'running' } };
      await sleep(step.duration_ms);
      yield { type: 'status', status: { id, label: step.label, detail: step.detail, state: 'done' } };
      continue;
    }

    const chapterId = `${messageId}_ch${chapterIdx++}`;
    yield { type: 'chapter_start', chapter_id: chapterId, title: step.title, icon: step.icon };

    // Stream the intro in word-sized deltas, like a live LLM.
    const words = step.intro.split(' ');
    for (let i = 0; i < words.length; i += 3) {
      yield {
        type: 'chapter_intro_delta',
        chapter_id: chapterId,
        delta: (i === 0 ? '' : ' ') + words.slice(i, i + 3).join(' '),
      };
      await sleep(INTRO_CHUNK_MS);
    }

    if (step.visual) {
      await sleep(200);
      yield { type: 'chapter_visual', chapter_id: chapterId, visual: step.visual };
    }
    for (const callout of step.callouts ?? []) {
      await sleep(300);
      yield { type: 'chapter_callout', chapter_id: chapterId, callout };
    }
    await sleep(BETWEEN_STEPS_MS);
  }

  yield { type: 'message_end', message_id: messageId, headline: scenario.headline };
}
