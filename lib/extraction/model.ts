import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

// Mirrors scripts/seed/llm.ts's provider selection, but independent env vars
// (EXTRACT_PROVIDER/EXTRACT_MODEL) — extraction runs at ~5,000 calls, well past
// generation's ~1,000, so it's the one most worth moving to a cheaper/faster
// bulk model (CLAUDE.md calls for GPT-4o-mini or Gemini Flash here) once that
// provider has confirmed capacity. Defaults to the same Anthropic key generation
// uses, since it's the one with verified working quota.
const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  google: 'gemini-2.5-flash',
  openai: 'gpt-4o-mini',
};

const getProvider = (): string => process.env.EXTRACT_PROVIDER ?? 'anthropic';

export const getExtractModelName = (): string =>
  process.env.EXTRACT_MODEL ?? DEFAULT_MODELS[getProvider()] ?? DEFAULT_MODELS.anthropic;

export const getExtractModel = (): LanguageModel => {
  const provider = getProvider();
  const model = getExtractModelName();
  if (provider === 'anthropic') return anthropic(model);
  if (provider === 'google') return google(model);
  if (provider === 'openai') return openai(model);
  throw new Error(`Unknown EXTRACT_PROVIDER "${provider}" — use "anthropic", "google", or "openai"`);
};
