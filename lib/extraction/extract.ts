import { generateObject } from 'ai';
import { getExtractModel } from './model';
import { buildExtractionPrompt } from './prompts';
import { buildExtractionSchema, type ThemeTaxonomyItem, type ExtractedMention } from './schema';

export interface OffsetMention extends ExtractedMention {
  char_offset_start: number;
  char_offset_end: number;
}

// Locate the LLM's verbatim_snippet inside the source text to derive real char
// offsets — trusting LLM-reported offsets directly is unreliable (models
// routinely miscount characters). Falls back to a whitespace-normalized search
// for minor quoting drift, and to (0,0) if neither locates it (rare when the
// prompt enforces verbatim copying; downstream should treat (0,0) as "offsets
// unavailable" rather than "start of document").
const locateOffsets = (source: string, snippet: string): { char_offset_start: number; char_offset_end: number } => {
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
  const { object } = await generateObject({
    model: getExtractModel(),
    schema,
    prompt: buildExtractionPrompt(sourceText, themes),
  });
  return object.mentions.map((m) => ({ ...m, ...locateOffsets(sourceText, m.verbatim_snippet) }));
};
