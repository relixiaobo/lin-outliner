import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
} from './agentWebConstants';
import type { WebSearchResult } from './agentWebTools';

export function isTransientSearchError(code: string): boolean {
  return code === 'network_error' || code === 'timeout' || code === 'navigation_failed';
}

function normalizeSerpLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SEARCH_LIMIT;
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.trunc(value)));
}

export interface BingImagesExtraction {
  htmlLength: number;
  candidateCount: number;
  results: WebSearchResult[];
}

// Single source of truth for the Bing result anchor. The readiness gate in
// agentTools.ts imports this; the extractor below must hardcode the same literal
// because it is serialized via .toString() and cannot reference a module binding.
export const BING_IMAGES_RESULT_SELECTOR = 'a.iusc';

export function bingImagesExtractorExpression(maxResults = MAX_SEARCH_LIMIT): string {
  return `(${extractBingImages.toString()})(document, ${normalizeSerpLimit(maxResults)})`;
}

/**
 * Pure DOM extractor for a Bing Images results page. Bing puts a JSON blob on
 * every result anchor (`a.iusc[m]`) carrying the full image url (`murl`), the
 * thumbnail (`turl`), and the source page (`purl`) — far more reliable to scrape
 * than Google Images, whose full-res urls are buried in lazy-loaded JS. This is
 * serialized via {@link bingImagesExtractorExpression} and runs IN the page, so
 * it must stay fully self-contained — no module-scope helpers.
 */
export function extractBingImages(document: Document, maxResults: number): BingImagesExtraction {
  const candidates = Array.from(document.querySelectorAll('a.iusc'));
  const seen = new Set<string>();
  const results: WebSearchResult[] = [];
  const limit = Number.isFinite(maxResults) ? Math.max(1, Math.trunc(maxResults)) : 10;

  const compact = (value: unknown): string => String(value || '').replace(/\s+/g, ' ').trim();
  const hostOf = (url: string): string | undefined => {
    try {
      return new URL(url).host;
    } catch {
      return undefined;
    }
  };
  const isHttpUrl = (value: unknown): value is string => {
    if (typeof value !== 'string' || !value) return false;
    try {
      const protocol = new URL(value).protocol;
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  };
  // The 'a.iusc' literal must stay in sync with BING_IMAGES_RESULT_SELECTOR; this
  // function is serialized via .toString() and runs in-page, so it cannot
  // reference the exported constant.
  for (const anchor of candidates) {
    if (results.length >= limit) break;
    const raw = anchor.getAttribute('m');
    if (!raw) continue;
    let meta: unknown;
    try {
      meta = JSON.parse(raw);
    } catch {
      continue;
    }
    // JSON.parse can yield null / an array / a primitive; reading `.murl` off
    // null would throw out of this whole in-page extractor (the try only guards
    // the parse), so require a plain object first.
    if (!meta || typeof meta !== 'object') continue;
    const record = meta as Record<string, unknown>;
    const imageUrl = record.murl;
    const pageUrl = record.purl;
    if (!isHttpUrl(imageUrl) || !isHttpUrl(pageUrl) || seen.has(imageUrl)) continue;
    seen.add(imageUrl);

    const thumbnailUrl = isHttpUrl(record.turl) ? record.turl : undefined;
    const ariaLabel = anchor.getAttribute('aria-label');
    const innerAlt = anchor.querySelector('img')?.getAttribute('alt');
    // Only trust a string title; a non-string record.t (markup drift) would
    // short-circuit the fallback chain and stringify to garbage like
    // '[object Object]'. Dimensions are intentionally not scraped: Bing exposes
    // no reliable dimension field on the result anchor.
    const metaTitle = typeof record.t === 'string' ? record.t : '';
    const fallbackTitle = hostOf(pageUrl) ?? pageUrl;
    const title = compact(metaTitle || ariaLabel || innerAlt) || fallbackTitle;

    results.push({
      title,
      url: pageUrl,
      snippet: '',
      imageUrl,
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
      source: hostOf(pageUrl),
    });
  }

  return {
    htmlLength: document.documentElement?.outerHTML?.length || 0,
    candidateCount: candidates.length,
    results,
  };
}
