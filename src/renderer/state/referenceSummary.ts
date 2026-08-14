import type { ReferenceSummary } from '../../core/references';
import type { DocumentIndex } from './document';

export function referenceSummaryForIndex(index: DocumentIndex): ReferenceSummary {
  return index.referenceSummary;
}
