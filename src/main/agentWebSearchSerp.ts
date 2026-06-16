import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
} from './agentWebConstants';
import type { WebSearchResult } from './agentWebTools';

export interface GoogleSerpExtraction {
  htmlLength: number;
  results: WebSearchResult[];
}

export function googleSerpExtractorExpression(maxResults = MAX_SEARCH_LIMIT): string {
  return `(${extractGoogleSerp.toString()})(document, ${normalizeSerpLimit(maxResults)})`;
}

export function extractGoogleSerp(document: Document, maxResults: number): GoogleSerpExtraction {
  const root = document.querySelector('#search') || document.querySelector('#rso') || document;
  const seen = new Set<string>();
  const results: WebSearchResult[] = [];
  const limit = Number.isFinite(maxResults) ? Math.max(1, Math.trunc(maxResults)) : 10;

  const compact = (value: unknown): string => String(value || '').replace(/\s+/g, ' ').trim();
  const textOf = (node: Element | null | undefined): string => {
    if (!node) return '';
    const renderedText = 'innerText' in node ? (node as HTMLElement).innerText : undefined;
    return compact(renderedText || node.textContent);
  };
  const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sourceOf = (url: string): string | undefined => {
    try {
      return new URL(url).host;
    } catch {
      return undefined;
    }
  };

  const normalizeHref = (href: string | null | undefined): string | null => {
    if (!href) return null;
    try {
      const url = new URL(href, 'https://www.google.com');
      if (url.pathname === '/url') {
        return url.searchParams.get('q') || url.searchParams.get('url');
      }
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
    } catch {
      return null;
    }
    return null;
  };

  const isExternalResultUrl = (url: string): boolean => {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      if (/(^|\.)google\.[a-z.]+$/i.test(host)) return false;
      if (/(^|\.)googleusercontent\.com$/i.test(host)) return false;
      if (/^webcache\.googleusercontent\.com$/i.test(host)) return false;
      if (/(^|\.)translate\.google/i.test(host)) return false;
      return true;
    } catch {
      return false;
    }
  };

  const stripKnownText = (text: string, title: string, anchorText: string, url: string): string => {
    let value = compact(text);
    const source = sourceOf(url) || '';
    const pathlessUrl = url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    for (const part of [title, anchorText, url, pathlessUrl, source]) {
      const needle = compact(part);
      if (needle) value = value.replace(new RegExp(escapeRegExp(needle), 'gi'), ' ');
    }
    return compact(value
      .replace(/\b(Cached|Similar|Translate this page|View all|About featured snippets)\b/gi, ' ')
      .replace(/^[\s·|›>\-:]+/, ''));
  };

  const looksLikeUrlLine = (text: string): boolean => {
    const value = compact(text);
    return /^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}([/ ›>-].*)?$/i.test(value) && value.length < 140;
  };

  const isBadSnippet = (text: string, title: string, url: string): boolean => {
    const value = compact(text);
    if (value.length < 18) return true;
    if (value === compact(title)) return true;
    if (looksLikeUrlLine(value)) return true;
    const source = sourceOf(url);
    return Boolean(source && value.toLowerCase() === source.toLowerCase());
  };

  const candidateScore = (text: string): number => {
    const value = compact(text);
    let score = Math.min(value.length, 240);
    if (/[.!?。！？]/.test(value)) score += 60;
    if (/\b\d{4}\b/.test(value)) score += 20;
    if (/\b(Cached|Similar|Translate this page)\b/i.test(value)) score -= 120;
    return score;
  };

  const resultBlockFor = (h3: Element, anchor: Element | null, title: string, url: string): Element => {
    const anchorText = textOf(anchor);
    let node: Element | null = h3;
    let fallback = anchor?.closest('div') || h3.parentElement || h3;
    for (let depth = 0; node && node !== root && depth < 8; depth += 1, node = node.parentElement) {
      const nestedTitles = node === h3 ? 1 : node.querySelectorAll('h3').length;
      if (nestedTitles > 1) continue;
      const remaining = stripKnownText(textOf(node), title, anchorText, url);
      if (remaining.length >= 30) return node;
      fallback = node;
    }
    return fallback;
  };

  const snippetFor = (block: Element, h3: Element, anchor: Element | null, title: string, url: string): string => {
    const anchorText = textOf(anchor);
    const candidates: string[] = [];
    for (const el of Array.from(block.querySelectorAll('div, span'))) {
      if (el === h3 || el.contains(h3) || anchor?.contains(el) || el.closest('a')) continue;
      const text = stripKnownText(textOf(el), title, anchorText, url);
      if (isBadSnippet(text, title, url)) continue;
      const links = Array.from(el.querySelectorAll('a'));
      const linkTextLength = links.reduce((total, link) => total + textOf(link).length, 0);
      if (links.length > 0 && linkTextLength > text.length * 0.6) continue;
      candidates.push(text);
    }

    candidates.sort((a, b) => candidateScore(b) - candidateScore(a));
    const text = candidates[0] || stripKnownText(textOf(block), title, anchorText, url);
    return text.length > 400 ? `${text.slice(0, 400).trim()}...` : text;
  };

  for (const h3 of Array.from(root.querySelectorAll('h3'))) {
    if (results.length >= limit) break;
    const anchor = h3.closest('a');
    const url = normalizeHref(anchor?.getAttribute('href'));
    if (!url || seen.has(url) || !isExternalResultUrl(url)) continue;
    const title = textOf(h3);
    if (!title) continue;

    seen.add(url);
    results.push({
      title,
      url,
      snippet: snippetFor(resultBlockFor(h3, anchor, title, url), h3, anchor, title, url),
      source: sourceOf(url),
    });
  }

  return {
    htmlLength: document.documentElement?.outerHTML?.length || 0,
    results,
  };
}

export interface DuckDuckGoSerpExtraction {
  htmlLength: number;
  results: WebSearchResult[];
}

// Single source of truth for the DuckDuckGo HTML-endpoint result link. The
// readiness gate in agentTools.ts imports this; the extractor below hardcodes the
// same literal because it is serialized via .toString() and cannot reference a
// module binding.
export const DUCKDUCKGO_RESULT_SELECTOR = 'a.result__a';

export function duckDuckGoSerpExtractorExpression(maxResults = MAX_SEARCH_LIMIT): string {
  return `(${extractDuckDuckGoSerp.toString()})(document, ${normalizeSerpLimit(maxResults)})`;
}

/**
 * Pure DOM extractor for DuckDuckGo's no-JS HTML endpoint
 * (html.duckduckgo.com/html/). Each organic result is an `a.result__a` whose
 * href is a `//duckduckgo.com/l/?uddg=<target>` redirector; the real URL lives in
 * the `uddg` param. Sponsored rows (`result--ad`) are skipped. Serialized via
 * {@link duckDuckGoSerpExtractorExpression} and runs IN the page, so it must stay
 * fully self-contained — no module-scope helpers.
 */
export function extractDuckDuckGoSerp(document: Document, maxResults: number): DuckDuckGoSerpExtraction {
  const seen = new Set<string>();
  const results: WebSearchResult[] = [];
  const limit = Number.isFinite(maxResults) ? Math.max(1, Math.trunc(maxResults)) : 10;

  const compact = (value: unknown): string => String(value || '').replace(/\s+/g, ' ').trim();
  const textOf = (node: Element | null | undefined): string => {
    if (!node) return '';
    const renderedText = 'innerText' in node ? (node as HTMLElement).innerText : undefined;
    return compact(renderedText || node.textContent);
  };
  const hostOf = (url: string): string | undefined => {
    try {
      return new URL(url).host;
    } catch {
      return undefined;
    }
  };
  const decodeTarget = (href: string | null | undefined): string | null => {
    if (!href) return null;
    try {
      const url = new URL(href, 'https://duckduckgo.com');
      if (/(^|\.)duckduckgo\.com$/i.test(url.hostname)) {
        const target = url.searchParams.get('uddg');
        return target && /^https?:\/\//i.test(target) ? target : null;
      }
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
    } catch {
      return null;
    }
  };

  // The 'a.result__a' literal must stay in sync with DUCKDUCKGO_RESULT_SELECTOR;
  // this function is serialized via .toString() and runs in-page, so it cannot
  // reference the exported constant.
  for (const anchor of Array.from(document.querySelectorAll('a.result__a'))) {
    if (results.length >= limit) break;
    const block = anchor.closest('.result') || anchor.parentElement;
    if (block && /result--ad|result--sponsored/i.test(block.className || '')) continue;
    const url = decodeTarget(anchor.getAttribute('href'));
    if (!url || seen.has(url)) continue;
    const title = textOf(anchor);
    if (!title) continue;

    seen.add(url);
    const snippetEl = block
      ? block.querySelector('.result__snippet') || block.querySelector('.result__extras')
      : null;
    results.push({
      title,
      url,
      snippet: textOf(snippetEl),
      source: hostOf(url),
    });
  }

  return {
    htmlLength: document.documentElement?.outerHTML?.length || 0,
    results,
  };
}

// Pure decision helpers for the web-search fallback chain (Electron-free so they
// are unit-testable). A summary of one engine attempt, projected from the
// SearchOutcome union in agentTools.ts.
export interface SearchAttemptSummary {
  kind: 'ok' | 'hint' | 'error';
  resultCount: number;
  code?: string;
}

// Try the secondary engine when the primary loaded but returned nothing, was
// blocked / needs a browser (hint), or failed with a recoverable error. A bad
// query or a caller abort is not worth a second engine.
export function shouldFallbackToSecondaryEngine(summary: SearchAttemptSummary): boolean {
  if (summary.kind === 'ok') return summary.resultCount === 0;
  if (summary.kind === 'hint') return true;
  return summary.code !== 'invalid_args' && summary.code !== 'aborted';
}

// A transient nav fault is worth one immediate retry; a block, extraction miss,
// bad query, or abort is not.
export function isTransientSearchError(code: string): boolean {
  return code === 'network_error' || code === 'timeout';
}

function normalizeSerpLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SEARCH_LIMIT;
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.trunc(value)));
}

export interface BingImagesExtraction {
  htmlLength: number;
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
  for (const anchor of Array.from(document.querySelectorAll('a.iusc'))) {
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
    results,
  };
}
