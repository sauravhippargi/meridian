import type { ChatRequest, StreamEvent } from '@/types/chapter';

// ─────────────────────────────────────────────────────────────────────────────
// THE LIVE SEAM — Person A implements this generator's body.
//
// route.ts calls createAgentStream(body) when NEXT_PUBLIC_AGENT_MODE==='live'
// and serializes whatever it yields as NDJSON — no reshaping on the frontend
// side. Your only job: trigger the chat.agent() run and `yield` StreamEvents as
// they arrive, in the ordering the mock demonstrates:
//
//   message_start
//   status(running) → status(done)        // one pair per tool call / query
//   chapter_start → chapter_intro_delta*   // deltas are word/token chunks
//     → chapter_visual → chapter_callout*  // visual.data = tool output as-is
//   message_end (headline)
//
// Contract shape chosen: an async generator (AsyncIterable<StreamEvent>). You
// yield typed events; I own NDJSON encoding + HTTP framing (see ndjson.ts). If
// Trigger.dev realtime gives you a ReadableStream instead, wrap it in a
// `for await` here and yield — the signature below is the only thing route.ts
// depends on. See INTEGRATION.md §3–§4 and app/api/chat/mock/stream.ts.
// ─────────────────────────────────────────────────────────────────────────────
export async function* createAgentStream(body: ChatRequest): AsyncGenerator<StreamEvent> {
  void body;
  throw new Error(
    'Live agent stream not implemented. Person A: trigger chat.agent() and yield StreamEvents here.',
  );
}
