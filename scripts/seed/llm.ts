import { openai } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';
import { anthropic } from '@ai-sdk/anthropic';
import { xai } from '@ai-sdk/xai';
import { groq } from '@ai-sdk/groq';
import type { LanguageModel } from 'ai';

// Provider/model selection from env (GEN_PROVIDER + GEN_MODEL). Each provider
// reads its own key from env automatically: ANTHROPIC_API_KEY,
// GOOGLE_GENERATIVE_AI_API_KEY, OPENAI_API_KEY, XAI_API_KEY, GROQ_API_KEY.
// Provider history on 2026-07-20: Anthropic ran out of credit balance 76%
// through the real run; xAI's team account hit its credit/spending limit on
// the very first dry-run call. Groq added as the next fallback — verify the
// default model with a live call before running anything larger, since exact
// current model availability isn't guaranteed by this file.
const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  google: 'gemini-2.5-flash',
  openai: 'gpt-4o-mini',
  xai: 'grok-3-mini',
  groq: 'openai/gpt-oss-120b', // llama-3.3-70b-versatile doesn't support Groq's json_schema structured-output mode generateObject needs
};

const getProvider = (): string => process.env.GEN_PROVIDER ?? 'google';

// Single source of truth for the active model string (used by getModel + cost label).
export const getModelName = (): string =>
  process.env.GEN_MODEL ?? DEFAULT_MODELS[getProvider()] ?? DEFAULT_MODELS.google;

export const getModel = (): LanguageModel => {
  const provider = getProvider();
  const model = getModelName();
  if (provider === 'anthropic') return anthropic(model);
  if (provider === 'google') return google(model);
  if (provider === 'openai') return openai(model);
  if (provider === 'xai') return xai(model);
  if (provider === 'groq') return groq(model);
  throw new Error(`Unknown GEN_PROVIDER "${provider}" — use "anthropic", "google", "openai", "xai", or "groq"`);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ── Global request pacing (RPM cap) ──────────────────────────────────────────
// Gemini free tier is 15 RPM for 2.5 Flash. p-limit caps *in-flight* calls, but
// only a minimum spacing between request starts caps the *rate*. This gate makes
// every LLM call begin at least GEN_MIN_INTERVAL_MS after the previous one, so a
// full run stays under the wall instead of thrashing 429s. 4200ms ≈ 14/min.
const MIN_INTERVAL_MS = Number(process.env.GEN_MIN_INTERVAL_MS ?? 4200);
let nextSlot = 0;
const paceGate = async (): Promise<void> => {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL_MS;
  if (wait > 0) await sleep(wait);
};

// ── Retry with 429-aware backoff ──────────────────────────────────────────────
const isRateLimit = (err: unknown): boolean => {
  const status =
    (err as { statusCode?: number })?.statusCode ?? (err as { status?: number })?.status;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    status === 429 ||
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('resource_exhausted') ||
    msg.includes('quota')
  );
};

// Rate-limit errors back off long (the free-tier window is seconds); other
// transient errors use short delays. Jitter avoids retry stampedes.
const RATE_LIMIT_DELAYS_MS = [5000, 10000, 20000, 40000, 60000];
const TRANSIENT_DELAYS_MS = [1000, 2000, 4000];
const jitter = (ms: number): number => ms + Math.floor(Math.random() * 500);

export const withRetry = async <T>(fn: () => Promise<T>, label: string): Promise<T> => {
  let lastErr: unknown;
  let rlAttempt = 0;
  let txAttempt = 0;
  for (;;) {
    await paceGate();
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const rateLimited = isRateLimit(err);
      const delays = rateLimited ? RATE_LIMIT_DELAYS_MS : TRANSIENT_DELAYS_MS;
      const attempt = rateLimited ? rlAttempt++ : txAttempt++;
      if (attempt >= delays.length) break;
      const delay = jitter(delays[attempt]);
      console.warn(
        `  ⚠ ${label} ${rateLimited ? 'rate-limited' : 'failed'} (retry ${attempt + 1}/${delays.length}) in ${delay}ms…`,
      );
      await sleep(delay);
    }
  }
  throw new Error(`${label} failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
};

// ── Cost accounting (display-only, approximate). ─────────────────────────────
interface ModelRate {
  inputPerM: number;
  outputPerM: number;
}
const RATES: Record<string, ModelRate> = {
  'claude-haiku-4-5-20251001': { inputPerM: 1, outputPerM: 5 },
  'gpt-4o-mini': { inputPerM: 0.15, outputPerM: 0.6 },
  'gemini-2.0-flash': { inputPerM: 0.1, outputPerM: 0.4 },
  'gemini-1.5-flash': { inputPerM: 0.075, outputPerM: 0.3 },
  // Free tier while under the daily quota — display reads $0.00, which is correct.
  'gemini-2.5-flash': { inputPerM: 0, outputPerM: 0 },
  'gemini-2.0-flash-lite': { inputPerM: 0, outputPerM: 0 },
  'gemini-2.5-flash-lite': { inputPerM: 0, outputPerM: 0 },
  'grok-3-mini': { inputPerM: 0.3, outputPerM: 0.5 },
  'openai/gpt-oss-120b': { inputPerM: 0.15, outputPerM: 0.75 },
};

export class CostTracker {
  private inputTokens = 0;
  private outputTokens = 0;
  private warnedUnknown = false;

  constructor(private readonly model: string) {}

  add(usage: { inputTokens?: number; outputTokens?: number }): void {
    this.inputTokens += usage.inputTokens ?? 0;
    this.outputTokens += usage.outputTokens ?? 0;
  }

  get spent(): number {
    const rate = RATES[this.model];
    if (!rate) {
      if (!this.warnedUnknown) {
        console.warn(`  ⚠ No cost rate for model "${this.model}" — cost display will read $0.00`);
        this.warnedUnknown = true;
      }
      return 0;
    }
    return (this.inputTokens / 1_000_000) * rate.inputPerM + (this.outputTokens / 1_000_000) * rate.outputPerM;
  }
}
