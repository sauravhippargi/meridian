import { streams } from '@trigger.dev/sdk';
import type { StreamEvent } from '@/types/chapter';

/** Typed chapter StreamEvents from the meridian agent → createAgentStream. */
export const chapterEvents = streams.define<StreamEvent>({
  id: 'chapter-events',
});
