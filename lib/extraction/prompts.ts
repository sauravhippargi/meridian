import type { ThemeTaxonomyItem } from './schema';

// The extraction prompt. Quality-gated per CONTEXT.md — manually graded against
// real generated tickets/transcripts before this runs at the ~1,000-document
// scale. Two design choices worth keeping if this gets edited:
//   1. verbatim_snippet must be an exact substring (no paraphrasing) — extract.ts
//      locates it in the source text to derive char offsets; a paraphrase can't
//      be located, which silently degrades provenance (the demo's wow-moment #3).
//   2. empty mentions[] is a valid, expected answer — not every document should
//      be forced into the taxonomy.
export const buildExtractionPrompt = (sourceText: string, themes: ThemeTaxonomyItem[]): string => {
  const taxonomy = themes.map((t) => `- ${t.id}: ${t.name} — ${t.short_description}`).join('\n');
  return `You are extracting product-feedback signal from a single customer source document for a B2B payments company (Meridian Payments, a Stripe competitor).

CLOSED THEME TAXONOMY (use ONLY these ids — never invent a new one):
${taxonomy}

SOURCE DOCUMENT:
"""
${sourceText}
"""

Find every distinct place in the document where the customer references one of the themes above. For each, return:
- theme_id: the single best-matching id from the taxonomy above.
- verbatim_snippet: an EXACT, word-for-word quote copied from the document (1–2 sentences, under 400 characters). Do not paraphrase, summarize, or correct typos — it must be locatable as a literal substring of the document above.
- severity (1–5): 1 = passing/casual mention, 3 = clear feature ask, 5 = explicit blocker, churn risk, or deal-breaking language.
- sentiment: -1 (frustrated/negative), 0 (neutral/informational), 1 (positive/satisfied).

If the document discusses multiple themes, return one entry per theme — do not merge them. If it doesn't mention any taxonomy theme, return an empty mentions array. Do not fabricate a mention that isn't actually in the text.`;
};
