import { z } from 'zod';

// Closed-taxonomy theme reference the extractor is allowed to classify into —
// mirrors data/seed/themes.json's shape without importing JSON (callers pass
// whichever theme rows they've already loaded from Postgres).
export interface ThemeTaxonomyItem {
  id: string;
  name: string;
  short_description: string;
}

// Schema is built per-call from the live theme id list (not hardcoded) so the
// taxonomy can change without touching this file. Requires >=1 theme.
export const buildExtractionSchema = (themeIds: string[]) => {
  if (themeIds.length === 0) throw new Error('buildExtractionSchema requires at least one theme id');
  return z.object({
    mentions: z.array(
      z.object({
        theme_id: z.enum(themeIds as [string, ...string[]]),
        verbatim_snippet: z.string().min(1).max(400),
        severity: z.number().int().min(1).max(5),
        sentiment: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
      }),
    ),
  });
};

export type ExtractedMention = z.infer<ReturnType<typeof buildExtractionSchema>>['mentions'][number];
