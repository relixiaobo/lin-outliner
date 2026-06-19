import { runSearchExpr, type SearchRankingOptions, type SearchRunResult } from '../core/searchEngine';
import type { DocumentProjection, SearchHit, SearchQueryExpr } from '../core/types';
import type { TextSearchIndex } from '../core/textSearchIndex';

export interface NodeRetrievalHost {
  getProjection(): DocumentProjection;
  getTextSearchIndex(): TextSearchIndex;
}

export interface NodeRetrievalOptions extends SearchRankingOptions {
  limit?: number;
  searchNodeId?: string;
}

export class NodeRetrievalService {
  constructor(private readonly host: NodeRetrievalHost) {}

  searchText(query: string, options: NodeRetrievalOptions = {}): SearchHit[] {
    return searchNodeText(this.host.getProjection(), this.host.getTextSearchIndex(), query, options);
  }

  searchQuery(query: SearchQueryExpr, options: NodeRetrievalOptions = {}): SearchHit[] {
    const result = searchNodeQuery(this.host.getProjection(), this.host.getTextSearchIndex(), query, options);
    return result.ok ? result.hits : [];
  }
}

export function searchNodeQuery(
  projection: DocumentProjection,
  textIndex: TextSearchIndex,
  query: SearchQueryExpr,
  options: NodeRetrievalOptions = {},
): SearchRunResult {
  return runSearchExpr(projection, query, {
    searchNodeId: options.searchNodeId,
    limit: options.limit,
    textIndex,
    personalAccess: options.personalAccess,
    personalAccessStats: options.personalAccessStats,
    now: options.now,
  });
}

export function searchNodeText(
  projection: DocumentProjection,
  textIndex: TextSearchIndex,
  query: string,
  options: NodeRetrievalOptions = {},
): SearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const result = searchNodeQuery(projection, textIndex, { kind: 'rule', op: 'STRING_MATCH', text: q }, {
    ...options,
    limit: options.limit ?? 50,
  });
  return result.ok ? result.hits : [];
}
