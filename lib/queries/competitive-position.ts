import { postgres } from '@/lib/db/postgres';
import type {
  GetCompetitivePositionInput,
  GetCompetitivePositionOutput,
  CompetitorFeature,
} from '@/types/agent-tools';
import { themeIdForFeature } from './competitor-feature-map';

interface CompetitorRow {
  name: string;
  is_self: boolean;
  features: Record<string, 'full' | 'partial' | 'none'>;
  gap_notes: Record<string, string> | null;
}

// Pure Postgres — competitors.json is static reference data with no analytical
// (ClickHouse) dimension, so this tool never touches mentions. Only 'full'
// counts as "a competitor has this" (both for rivals and Meridian itself) —
// 'partial' support across the board IS the greenfield signal (everyone has a
// bolted-on version, nobody has shipped the real thing), not evidence against
// it. This matters concretely: multi_entity_invoicing has two rivals at
// 'partial', and counting that as "has it" would suppress the frontend's
// Open/greenfield status for the demo's hidden-gem wow-moment.
export const getCompetitivePosition = async (
  input: GetCompetitivePositionInput,
): Promise<GetCompetitivePositionOutput> => {
  const { rows } = await postgres().query<CompetitorRow>(
    'SELECT name, is_self, features, gap_notes FROM competitors ORDER BY is_self DESC, name',
  );

  const self = rows.find((r) => r.is_self);
  if (!self) throw new Error('No Meridian self-row (is_self=true) in competitors table');
  const rivals = rows.filter((r) => !r.is_self);

  const allFeatureNames = Object.keys(self.features);
  const featureNames = input.theme_id
    ? allFeatureNames.filter((f) => themeIdForFeature(f) === input.theme_id)
    : allFeatureNames;

  const features: CompetitorFeature[] = featureNames.map((feature_name) => ({
    feature_name,
    competitors_with_feature: rivals.filter((r) => r.features[feature_name] === 'full').map((r) => r.name),
    meridian_has_feature: self.features[feature_name] === 'full',
    meridian_gap_notes: self.gap_notes?.[feature_name],
  }));

  return { competitors: rivals.map((r) => r.name), features };
};
