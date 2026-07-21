import { task } from '@trigger.dev/sdk';
import { chat } from '@trigger.dev/sdk/ai';
import { streamText, stepCountIs, tool } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import type { ChapterVisual, ChatRequest, StreamEvent } from '@/types/chapter';
import { runAgentFlow } from '@/lib/agent/prioritize-flow';
import { listOpportunitiesRanked } from '@/lib/queries/opportunities-ranked';
import { getThemeEvidence } from '@/lib/queries/theme-evidence';
import { getCompetitivePosition } from '@/lib/queries/competitive-position';
import { getImpactProjection } from '@/lib/queries/impact-projection';
import { chapterEvents } from './streams';

export const statusEvent = (
  id: string,
  label: string,
  state: 'running' | 'done',
  detail?: string,
): StreamEvent => ({ type: 'status', status: { id, label, state, detail } });

export const visualEvent = (chapterId: string, visual: ChapterVisual): StreamEvent => ({
  type: 'chapter_visual',
  chapter_id: chapterId,
  visual,
});

export const encodeNdjson = (event: StreamEvent): string => `${JSON.stringify(event)}\n`;

const toChatRequest = (
  chatId: string,
  messages: { role: string; content: unknown }[],
): ChatRequest => ({
  conversation_id: chatId,
  messages: messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    })),
});

const pipeChapterFlow = async (body: ChatRequest): Promise<string> => {
  let headline = 'Analysis complete.';
  for await (const event of runAgentFlow(body)) {
    await chapterEvents.append(event);
    if (event.type === 'message_end') headline = event.headline;
  }
  return headline;
};

/**
 * Durable chapter stream task — createAgentStream triggers this and reads
 * `chapter-events`. Keeps the Next.js route thin while forcing live answers
 * through Trigger.dev.
 */
export const streamMeridianAnswer = task({
  id: 'stream-meridian-answer',
  maxDuration: 300,
  run: async (payload: ChatRequest): Promise<{ headline: string }> => {
    const headline = await pipeChapterFlow(payload);
    return { headline };
  },
});

/**
 * Required hackathon primitive: Trigger.dev chat.agent().
 * Scripted chapter flow for prioritize / keyword follow-ups (hybrid orchestration).
 * LLM+tools path handles open-ended follow-ups that don't match a scripted kind.
 */
export const meridianChat = chat.agent({
  id: 'meridian-chat',
  maxDuration: 300,
  run: async ({ messages, chatId, signal }) => {
    const body = toChatRequest(chatId, messages as { role: string; content: unknown }[]);
    const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const isScripted =
      /(priorit|quarter|roadmap|dunning|compet|usage|evidence|impact|stripe|metronome)/i.test(
        lastUser,
      ) || body.messages.length <= 2;

    if (isScripted) {
      const headline = await pipeChapterFlow(body);
      return streamText({
        ...chat.toStreamTextOptions(),
        model: anthropic(process.env.AGENT_MODEL ?? 'claude-haiku-4-5-20251001'),
        system: 'You are Meridian, a product intelligence agent. Reply in one short sentence only.',
        messages: [{ role: 'user', content: `Confirm this headline to the PM: ${headline}` }],
        abortSignal: signal,
        stopWhen: stepCountIs(1),
      });
    }

    // Open follow-ups: LLM-driven with the four query tools.
    return streamText({
      ...chat.toStreamTextOptions(),
      model: anthropic(process.env.AGENT_MODEL ?? 'claude-sonnet-4-5-20250929'),
      system: `You are Meridian, a visual-first product intelligence agent for Meridian Payments Billing.
Answer with short, evidence-backed claims. Prefer calling tools over guessing. Theme ids are
usage_based_billing, multi_entity_invoicing, dunning_customization, latam_tax, hybrid_revrec,
webhook_reliability, salesforce_sync, custom_invoice_pdf.`,
      messages,
      abortSignal: signal,
      stopWhen: stepCountIs(8),
      tools: {
        list_opportunities_ranked: tool({
          description: 'Rank themes by ARR-weighted signal strength',
          inputSchema: z.object({ time_window_days: z.number().optional() }),
          execute: async ({ time_window_days }) =>
            listOpportunitiesRanked({ time_window_days: time_window_days ?? 180 }),
        }),
        get_theme_evidence: tool({
          description: 'Fetch verbatim evidence quotes for a theme',
          inputSchema: z.object({
            theme_id: z.string(),
            limit: z.number().optional(),
          }),
          execute: async ({ theme_id, limit }) =>
            getThemeEvidence({ theme_id, limit: limit ?? 10 }),
        }),
        get_competitive_position: tool({
          description: 'Competitor feature matrix for a theme',
          inputSchema: z.object({ theme_id: z.string().optional() }),
          execute: async ({ theme_id }) => getCompetitivePosition({ theme_id }),
        }),
        get_impact_projection: tool({
          description: 'ARR impact breakdown for a theme',
          inputSchema: z.object({ theme_id: z.string() }),
          execute: async ({ theme_id }) => getImpactProjection({ theme_id }),
        }),
      },
    });
  },
});
