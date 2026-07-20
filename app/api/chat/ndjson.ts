import type { StreamEvent } from '@/types/chapter';

// Serialize any async stream of StreamEvents as an NDJSON HTTP Response — one
// JSON-encoded event per line. THIS is the frontend contract; both the mock and
// the live agent flow through here, so neither has to know about encoding or
// HTTP framing. A mid-stream throw is surfaced as a trailing `error` event.
const encoder = new TextEncoder();

export const ndjsonResponse = (events: AsyncIterable<StreamEvent>): Response => {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of events) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'stream failed';
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'error', message })}\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
    },
  });
};
