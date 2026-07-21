import { tasks } from '@trigger.dev/sdk';
import type { ChatRequest, StreamEvent } from '@/types/chapter';
import { runAgentFlow } from '@/lib/agent/prioritize-flow';
import { chapterEvents } from '@/trigger/streams';

// ─────────────────────────────────────────────────────────────────────────────
// THE LIVE SEAM — yields typed StreamEvents for route.ts → NDJSON.
//
// Prefer Trigger.dev task `stream-meridian-answer` (pipes chapter-events stream)
// so live answers run on the Trigger worker. Falls back to in-process
// runAgentFlow when TRIGGER_SECRET_KEY is missing (local without worker).
// chat.agent() lives in trigger/agent.ts and shares the same runAgentFlow.
// ─────────────────────────────────────────────────────────────────────────────

export async function* createAgentStream(body: ChatRequest): AsyncGenerator<StreamEvent> {
  if (!process.env.TRIGGER_SECRET_KEY) {
    yield* runAgentFlow(body);
    return;
  }

  try {
    const handle = await tasks.trigger('stream-meridian-answer', body);
    const stream = await chapterEvents.read(handle.id, { timeoutInSeconds: 180 });
    for await (const event of stream) {
      yield event;
    }
  } catch (err) {
    // Worker down / stream unavailable — still serve the answer in-process so
    // the live demo doesn't hard-fail. Log for operators.
    console.error('[createAgentStream] Trigger path failed, falling back in-process:', err);
    yield* runAgentFlow(body);
  }
}
