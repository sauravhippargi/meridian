import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';
import { groq } from '@ai-sdk/groq';
import type { LanguageModel } from 'ai';

// Independent of GEN_PROVIDER — extraction is ~1,000 source docs (tickets +
// transcripts), so it's the place most worth switching to a cheaper bulk model.
// Defaults to Anthropic Haiku (verified quota). Set EXTRACT_PROVIDER=groq if
// Anthropic credit runs low — openai/gpt-oss-120b supports structured output.
const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  google: 'gemini-2.5-flash',
  openai: 'gpt-4o-mini',
  groq: 'openai/gpt-oss-120b',
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
  if (provider === 'groq') return groq(model);
  throw new Error(
    `Unknown EXTRACT_PROVIDER "${provider}" — use "anthropic", "google", "openai", or "groq"`,
  );
};
