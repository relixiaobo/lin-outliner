import { Defuddle } from 'defuddle/node';
import { parseHTML } from 'linkedom';
import type { WebFetchData, WebPageMetadata } from './agentWebTools';

export interface ExtractedPageContent {
  content: string;
  metadata: WebPageMetadata;
}

export async function extractPageContent(
  body: string,
  contentType: string,
  finalUrl: string,
  format: WebFetchData['format'],
): Promise<ExtractedPageContent> {
  const fallbackMetadata = extractMetadata(body, finalUrl);
  if (format === 'raw') return { content: body, metadata: fallbackMetadata };
  if (format === 'metadata') {
    const defuddled = contentType.toLowerCase().includes('html')
      ? await extractDefuddledPage(body, finalUrl, 'markdown')
      : null;
    return { content: '', metadata: mergeMetadata(fallbackMetadata, defuddled?.metadata) };
  }
  if (!contentType.toLowerCase().includes('html')) {
    return { content: body.trim(), metadata: fallbackMetadata };
  }

  const defuddled = await extractDefuddledPage(body, finalUrl, format);
  const fallbackContent = format === 'text'
    ? htmlToText(body)
    : htmlToMarkdown(body, finalUrl);
  return {
    content: defuddled?.content?.trim() || fallbackContent,
    metadata: mergeMetadata(fallbackMetadata, defuddled?.metadata),
  };
}

export async function extractContent(
  body: string,
  contentType: string,
  finalUrl: string,
  format: WebFetchData['format'],
): Promise<string> {
  return (await extractPageContent(body, contentType, finalUrl, format)).content;
}

export function extractMetadata(html: string, finalUrl: string): WebPageMetadata {
  const language = matchFirst(html, /<html[^>]*\slang=["']?([^"'\s>]+)/i);
  const title = cleanText(matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ?? '');
  const description = getMetaContent(html, 'description');
  const siteName = getMetaContent(html, 'og:site_name');
  const canonicalUrl = absolutizeUrl(getLinkHref(html, 'canonical') ?? '', finalUrl) || finalUrl;
  const headings = [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map((match) => cleanText(stripTags(match[2] ?? '')))
    .filter(Boolean)
    .slice(0, 30);
  const links = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({
      text: cleanText(stripTags(match[2] ?? '')),
      url: absolutizeUrl(decodeHtml(match[1] ?? ''), finalUrl),
    }))
    .filter((link) => link.text && link.url)
    .slice(0, 80);

  return {
    title: title || undefined,
    description: description || undefined,
    canonicalUrl,
    siteName: siteName || undefined,
    language: language || undefined,
    headings,
    links,
  };
}

async function extractDefuddledPage(
  html: string,
  finalUrl: string,
  format: 'markdown' | 'text',
): Promise<ExtractedPageContent | null> {
  try {
    const parsedDocument = createDefuddleDocument(html, finalUrl);
    const result = await Defuddle(parsedDocument, finalUrl, {
      markdown: format === 'markdown',
      useAsync: false,
    });
    const rawContent = typeof result.content === 'string' ? result.content.trim() : '';
    const content = format === 'text'
      ? htmlToText(rawContent)
      : cleanMarkdown(rawContent);
    if (!content) return null;
    return {
      content,
      metadata: {
        title: compactMetadataText(result.title),
        description: compactMetadataText(result.description),
        canonicalUrl: finalUrl,
        siteName: compactMetadataText(result.site),
        language: compactMetadataText(result.language),
      },
    };
  } catch {
    return null;
  }
}

function createDefuddleDocument(html: string, finalUrl: string): Document {
  const { document } = parseHTML(html);
  const parsedDocument = document as Document;
  // Defuddle relies on browser URL/location fields; linkedom leaves them unset.
  const mutableDocument = parsedDocument as unknown as {
    URL?: string;
    location?: { href: string };
    styleSheets?: unknown;
    defaultView?: unknown;
  };
  mutableDocument.URL = finalUrl;
  mutableDocument.location = { href: finalUrl };
  mutableDocument.styleSheets ??= [];
  const defaultView = mutableDocument.defaultView as { getComputedStyle?: unknown } | undefined;
  if (defaultView && typeof defaultView.getComputedStyle !== 'function') {
    defaultView.getComputedStyle = () => ({ display: '' });
  }
  return parsedDocument;
}

function mergeMetadata(base: WebPageMetadata, extracted?: WebPageMetadata): WebPageMetadata {
  if (!extracted) return base;
  return {
    title: extracted.title || base.title,
    description: extracted.description || base.description,
    canonicalUrl: base.canonicalUrl || extracted.canonicalUrl,
    siteName: extracted.siteName || base.siteName,
    language: extracted.language || base.language,
    headings: base.headings,
    links: base.links,
  };
}

function htmlToMarkdown(html: string, baseUrl: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_match, code) => `\n\n\`\`\`\n${decodeHtml(stripTags(code))}\n\`\`\`\n\n`)
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_match, value) => `\n\n# ${cleanText(stripTags(value))}\n\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_match, value) => `\n\n## ${cleanText(stripTags(value))}\n\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_match, value) => `\n\n### ${cleanText(stripTags(value))}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_match, value) => `\n- ${cleanText(stripTags(value))}`)
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href, label) => {
      const textLabel = cleanText(stripTags(label));
      const url = absolutizeUrl(decodeHtml(href), baseUrl);
      if (!textLabel) return '';
      return url ? `[${textLabel}](${url})` : textLabel;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|blockquote|tr|table|ul|ol)>/gi, '\n\n');

  text = stripTags(text);
  return cleanMarkdown(decodeHtml(text));
}

function htmlToText(html: string): string {
  return cleanText(decodeHtml(stripTags(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|blockquote|tr|li)>/gi, '\n'),
  )));
}

function compactMetadataText(value: unknown): string | undefined {
  return typeof value === 'string' ? cleanText(value) || undefined : undefined;
}

function getMetaContent(html: string, name: string): string | undefined {
  const escaped = escapeRegExp(name);
  const byName = matchFirst(
    html,
    new RegExp(`<meta\\b(?=[^>]*(?:name|property)=["']${escaped}["'])[^>]*content=["']([^"']*)["'][^>]*>`, 'i'),
  );
  if (byName) return cleanText(byName);
  return undefined;
}

function getLinkHref(html: string, rel: string): string | undefined {
  const escaped = escapeRegExp(rel);
  return matchFirst(
    html,
    new RegExp(`<link\\b(?=[^>]*rel=["'][^"']*${escaped}[^"']*["'])[^>]*href=["']([^"']+)["'][^>]*>`, 'i'),
  );
}

function matchFirst(input: string, pattern: RegExp): string | undefined {
  return input.match(pattern)?.[1];
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, ' ');
}

function cleanText(value: string): string {
  return decodeHtml(value).replace(/\s+/g, ' ').trim();
}

function cleanMarkdown(value: string): string {
  return value
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] === '#') {
      const radix = body[1]?.toLowerCase() === 'x' ? 16 : 10;
      const raw = radix === 16 ? body.slice(2) : body.slice(1);
      const codePoint = Number.parseInt(raw, radix);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    return named[body.toLowerCase()] ?? entity;
  });
}

function absolutizeUrl(url: string, baseUrl: string): string {
  if (!url || url.startsWith('#') || url.startsWith('javascript:') || url.startsWith('mailto:')) return '';
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return '';
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
