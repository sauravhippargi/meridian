export type ThemeId = string; // e.g. "usage_based_billing"

export interface Theme {
  id: ThemeId;
  name: string;                    // "Usage-based billing enhancements"
  short_description: string;       // one-line description
  category: 'billing' | 'invoicing' | 'tax' | 'revrec' | 'integrations' | 'other';
  first_seen_at: string;           // ISO date
  last_seen_at: string;
}