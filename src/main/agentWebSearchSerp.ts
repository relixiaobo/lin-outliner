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

function normalizeSerpLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SEARCH_LIMIT;
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.trunc(value)));
}

export interface BingImagesExtraction {
  htmlLength: number;
  results: WebSearchResult[];
}

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
  const dimsFor = (anchor: Element): { width?: number; height?: number } => {
    const card = anchor.closest('.iuscp') || anchor.closest('.imgpt') || anchor.parentElement;
    const info = card?.querySelector('.fileInfo, .img_info, .b_caption');
    const text = compact(info ? info.textContent : '');
    const match = text.match(/(\d{2,5})\s*[x×]\s*(\d{2,5})/);
    if (!match) return {};
    return { width: Number(match[1]), height: Number(match[2]) };
  };

  for (const anchor of Array.from(document.querySelectorAll('a.iusc'))) {
    if (results.length >= limit) break;
    const raw = anchor.getAttribute('m');
    if (!raw) continue;
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    const imageUrl = meta.murl;
    const pageUrl = meta.purl;
    if (!isHttpUrl(imageUrl) || !isHttpUrl(pageUrl) || seen.has(imageUrl)) continue;
    seen.add(imageUrl);

    const thumbnailUrl = isHttpUrl(meta.turl) ? meta.turl : undefined;
    const ariaLabel = anchor.getAttribute('aria-label');
    const innerAlt = anchor.querySelector('img')?.getAttribute('alt');
    const title = compact(meta.t || ariaLabel || innerAlt) || hostOf(pageUrl) || pageUrl;
    const dims = dimsFor(anchor);

    results.push({
      title,
      url: pageUrl,
      snippet: '',
      imageUrl,
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
      ...(dims.width && dims.height ? { width: dims.width, height: dims.height } : {}),
      source: hostOf(pageUrl),
    });
  }

  return {
    htmlLength: document.documentElement?.outerHTML?.length || 0,
    results,
  };
}
