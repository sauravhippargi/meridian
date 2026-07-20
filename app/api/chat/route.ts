import type { ChatRequest } from '@/types/chapter';
import { ndjsonResponse } from './ndjson';
import { mockEventStream } from './mock/stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE SEAM between frontend and agent.
// Both modes produce an AsyncIterable<StreamEvent>; ndjsonResponse serializes it.
//  - mock: scripted scenario (app/api/chat/mock/stream.ts) — the reference.
//  - live: Person A's chat.agent() run (lib/agent-stream.ts). Imported lazily so
//          the Trigger.dev/agent dependencies never load in mock mode.
// ─────────────────────────────────────────────────────────────────────────────
export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as ChatRequest;

  if (process.env.NEXT_PUBLIC_AGENT_MODE === 'live') {
    const { createAgentStream } = await import('@/lib/agent-stream');
    return ndjsonResponse(createAgentStream(body));
  }

  return ndjsonResponse(mockEventStream(body));
}
