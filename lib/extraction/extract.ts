import { generateObject } from 'ai';
import { getExtractModel } from './model';
import { buildExtractionPrompt } from './prompts';
import { buildExtractionSchema, type ThemeTaxonomyItem, type ExtractedMention } from './schema';

export interface OffsetMention extends ExtractedMention {
  char_offset_start: number;
  char_offset_end: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const isRateLimit = (err: unknown): boolean => {
  const status =
    (err as { statusCode?: number })?.statusCode ?? (err as { status?: number })?.status;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    status === 429 ||
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('resource_exhausted') ||
    msg.includes('quota') ||
    msg.includes('credit')
  );
};

// Locate the LLM's verbatim_snippet inside the source text to derive real char
// offsets — trusting LLM-reported offsets directly is unreliable (models
// routinely miscount characters). Falls back to a whitespace-normalized search
// for minor quoting drift, and to (0,0) if neither locates it.
const locateOffsets = (
  source: string,
  snippet: string,
): { char_offset_start: number; char_offset_end: number } => {
  const exact = source.indexOf(snippet);
  if (exact >= 0) return { char_offset_start: exact, char_offset_end: exact + snippet.length };

  const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const normIdx = normalize(source).indexOf(normalize(snippet));
  if (normIdx >= 0) {
    const start = Math.min(normIdx, Math.max(0, source.length - snippet.length));
    return { char_offset_start: start, char_offset_end: Math.min(source.length, start + snippet.length) };
  }
  return { char_offset_start: 0, char_offset_end: 0 };
};

export const extractMentions = async (
  sourceText: string,
  themes: ThemeTaxonomyItem[],
): Promise<OffsetMention[]> => {
  const schema = buildExtractionSchema(themes.map((t) => t.id));
  const prompt = buildExtractionPrompt(sourceText, themes);
  const model = getExtractModel();

  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const { object } = await generateObject({ model, schema, prompt });
      return object.mentions.map((m) => ({ ...m, ...locateOffsets(sourceText, m.verbatim_snippet) }));
    } catch (err) {
      lastErr = err;
      if (!isRateLimit(err) || attempt === 4) break;
      // 5s → 15s → 45s → 60s with jitter for rate-limit walls
      const base = Math.min(60_000, 5_000 * 3 ** attempt);
      const wait = base + Math.floor(Math.random() * 1_000);
      await sleep(wait);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
};
