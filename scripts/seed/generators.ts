import { generateObject, type LanguageModel } from 'ai';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { subDays, formatISO } from 'date-fns';
import { withRetry, type CostTracker } from './llm';
import type { PlanItem } from './plan';

// Full row shapes, matching the raw_tickets / raw_transcripts / deals tables so
// dry-run output can be validated against the DB schema before any write.
export interface TicketRow {
  id: string;
  external_id: string;
  account_id: string;
  subject: string;
  body: string;
  status: string;
  priority: string;
  opened_at: string;
}
export interface TranscriptRow {
  id: string;
  external_id: string;
  account_id: string;
  title: string;
  interviewee_name: string;
  interviewee_role: string;
  interview_date: string;
  duration_minutes: number;
  transcript: string;
}
export interface DealRow {
  id: string;
  account_id: string;
  name: string;
  status: 'lost' | 'in_progress' | 'won';
  amount: number;
  close_date: string | null;
  loss_reason: string | null;
  blocking_theme_id: string | null;
  competitor_id: string | null;
}

export interface GenContext {
  model: LanguageModel;
  cost: CostTracker;
}

// Event dates are sampled within a 180-day window ending at run time.
const REFERENCE_DATE = new Date();
const randomWithinDays = (days: number): Date => subDays(REFERENCE_DATE, Math.floor(Math.random() * days));
const isoDate = (d: Date): string => formatISO(d, { representation: 'date' });
const isoDateTime = (d: Date): string => formatISO(d);

const TicketGen = z.object({
  subject: z.string(),
  body: z.string(),
  status: z.enum(['open', 'pending', 'closed']),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
});

export const generateTicket = async (ctx: GenContext, item: PlanItem, seq: number): Promise<TicketRow> => {
  const prompt = `You are simulating a realistic B2B SaaS support ticket for Meridian Payments (a Stripe competitor).
Account: ${item.account.name} (${item.account.industry}, ${item.account.segment}).
Topic/theme: ${item.theme.name} — ${item.theme.short_description}.
Severity (1 = passing mention … 5 = blocking): ${item.severity}.
Write a concrete support ticket: a specific subject line and a 2–4 sentence body describing a real problem this account hit related to the theme. Higher severity = more urgent, business-impacting language. Do not mention that this is simulated.`;
  const { object, usage } = await withRetry(
    () => generateObject({ model: ctx.model, schema: TicketGen, prompt }),
    `ticket ${seq}`,
  );
  ctx.cost.add(usage);
  return {
    id: uuidv4(),
    external_id: `TICK-${String(seq).padStart(5, '0')}`,
    account_id: item.account.id,
    subject: object.subject,
    body: object.body,
    status: object.status,
    priority: object.priority,
    opened_at: isoDateTime(randomWithinDays(180)),
  };
};

// Only the transcript prose comes from the LLM — the interviewee identity is the
// account's real seeded contact, so names stay diverse and traceable (the LLM
// left to itself defaults everyone to "Sarah Chen", which wrecks the evidence-card
// provenance moment).
const TranscriptGen = z.object({
  transcript: z.string(),
});

export const generateTranscript = async (ctx: GenContext, item: PlanItem, seq: number): Promise<TranscriptRow> => {
  const churnLine =
    item.severity >= 5
      ? 'This customer is at real risk of churning or walking away without this capability — make that explicit in their own words.'
      : '';
  const prompt = `Simulate an excerpt from a 30–60 minute customer discovery interview for Meridian Payments (a Stripe competitor).
Account: ${item.account.name} (${item.account.industry}, ${item.account.segment}).
Interviewee: ${item.account.primary_contact_name}, ${item.account.primary_contact_role} at ${item.account.name}.
Theme under discussion: ${item.theme.name} — ${item.theme.short_description}.
Severity/urgency (1–5): ${item.severity}. ${churnLine}
Return a realistic multi-paragraph transcript excerpt in ${item.account.primary_contact_name}'s own first-person voice discussing this theme. Do not restate their name or title; do not mention that this is simulated.`;
  const { object, usage } = await withRetry(
    () => generateObject({ model: ctx.model, schema: TranscriptGen, prompt }),
    `transcript ${seq}`,
  );
  ctx.cost.add(usage);
  return {
    id: uuidv4(),
    external_id: `INT-${String(seq).padStart(4, '0')}`,
    account_id: item.account.id,
    title: `${item.account.name} — ${item.theme.name} discovery`,
    interviewee_name: item.account.primary_contact_name,
    interviewee_role: item.account.primary_contact_role,
    interview_date: isoDate(randomWithinDays(180)),
    duration_minutes: 30 + Math.floor(Math.random() * 31), // 30–60
    transcript: object.transcript,
  };
};

const DealGen = z.object({
  name: z.string(),
  loss_reason: z.string(),
});

export const generateDeal = async (
  ctx: GenContext,
  item: PlanItem,
  seq: number,
  competitorIds: string[],
): Promise<DealRow> => {
  const status = item.dealStatus ?? 'lost';
  const context =
    status === 'lost'
      ? `The deal was blocked/lost primarily because of a gap in: ${item.theme.name} — ${item.theme.short_description}.`
      : `The deal is in progress but at risk over: ${item.theme.name} — ${item.theme.short_description}.`;
  const prompt = `Simulate a CRM deal record for Meridian Payments (a Stripe competitor).
Account: ${item.account.name} (${item.account.industry}, ${item.account.segment}, ~$${Math.round(item.account.arr).toLocaleString()} ARR).
Deal status: ${status}. ${context}
Return a short deal name and a 1–2 sentence loss_reason explaining how the gap in "${item.theme.name}" affected the outcome. Do not mention that this is simulated.`;
  const { object, usage } = await withRetry(
    () => generateObject({ model: ctx.model, schema: DealGen, prompt }),
    `deal ${seq}`,
  );
  ctx.cost.add(usage);
  const competitorId =
    status === 'lost' && competitorIds.length > 0
      ? competitorIds[Math.floor(Math.random() * competitorIds.length)]
      : null;
  return {
    id: uuidv4(),
    account_id: item.account.id,
    name: object.name,
    status,
    // Deal value scales loosely with the account's ARR.
    amount: Math.round(item.account.arr * (0.2 + Math.random() * 0.6)),
    close_date: status === 'in_progress' ? null : isoDate(randomWithinDays(180)),
    loss_reason: status === 'lost' ? object.loss_reason : null,
    blocking_theme_id: item.theme.id,
    competitor_id: competitorId,
  };
};
