import { rankTextSearchLabel } from '../../../core/textSearchAnalyzer';

export function textMatchRank(label: string, query: string): number | null {
  return rankTextSearchLabel(label, query)?.rank ?? null;
}
