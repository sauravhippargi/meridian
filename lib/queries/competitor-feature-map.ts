import type { ThemeId } from '@/types/theme';

// competitors.json features are keyed by feature NAME (20 of them), not theme_id
// — the seed schema has no such field. getCompetitivePosition needs to filter by
// theme, so this is the explicit feature→theme join, hand-mapped once against
// data/seed/themes.json + the Meridian self-row's feature list. Update both
// together if either changes.
export const FEATURE_THEME_MAP: Record<string, ThemeId> = {
  'Real-time metering': 'usage_based_billing',
  'Custom aggregation rules': 'usage_based_billing',
  'Tiered pricing structures': 'usage_based_billing',
  'Credit management': 'usage_based_billing',
  'Prepaid balance handling': 'usage_based_billing',

  'Multi-entity consolidated invoicing': 'multi_entity_invoicing',
  'Per-entity line-item breakdown': 'multi_entity_invoicing',

  'Dunning email customization': 'dunning_customization',
  'Dunning workflow branching': 'dunning_customization',

  'Brazil tax compliance': 'latam_tax',
  'Mexico/Argentina/Colombia tax': 'latam_tax',

  'Multi-model contract handling': 'hybrid_revrec',
  'ASC 606 automation': 'hybrid_revrec',

  'Retry with exponential backoff': 'webhook_reliability',
  'Webhook observability dashboard': 'webhook_reliability',

  'Native Salesforce integration': 'salesforce_sync',
  'Bi-directional data sync': 'salesforce_sync',

  'Custom invoice PDF templates': 'custom_invoice_pdf',
  'Multi-language invoicing': 'custom_invoice_pdf',
  'Custom line-item groupings': 'custom_invoice_pdf',
};

export const themeIdForFeature = (featureName: string): ThemeId | null =>
  FEATURE_THEME_MAP[featureName] ?? null;

export const featuresForTheme = (themeId: ThemeId): string[] =>
  Object.entries(FEATURE_THEME_MAP)
    .filter(([, t]) => t === themeId)
    .map(([feature]) => feature);
