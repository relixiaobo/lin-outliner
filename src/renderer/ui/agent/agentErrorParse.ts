const ERROR_PREVIEW_MAX = 280;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}...` : text;
}

export function parseAgentErrorMessage(raw: string): string {
  let trimmed = raw.trim();

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: { message?: unknown }; message?: unknown };
      const message = parsed.error?.message ?? parsed.message;
      if (typeof message === 'string' && message.trim()) {
        return truncate(message.trim(), ERROR_PREVIEW_MAX);
      }
    } catch {
      // Keep falling through to plain-text handling.
    }
  }

  trimmed = trimmed.replace(/^Error:\s*/i, '').replace(/^Proxy error:\s*/i, '');
  const httpMatch = trimmed.match(/^(\d{3})\b\s*([\s\S]*)$/);
  if (httpMatch) {
    const [, status, bodyRaw] = httpMatch;
    const body = bodyRaw.trim();

    if (body.startsWith('<')) {
      const title = body.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
      return title ? `HTTP ${status} - ${truncate(title, 120)}` : `HTTP ${status}`;
    }

    if (body.startsWith('{')) {
      try {
        const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
        const message = parsed.error?.message ?? parsed.message;
        if (typeof message === 'string' && message.trim()) {
          return `HTTP ${status} - ${truncate(message.trim(), 200)}`;
        }
      } catch {
        // Keep falling through to body preview.
      }
    }

    return body ? `HTTP ${status} - ${truncate(body, 200)}` : `HTTP ${status}`;
  }

  if (trimmed.startsWith('<')) {
    const title = trimmed.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
    return title ? truncate(title, 120) : 'Server returned an HTML error page';
  }

  return truncate(trimmed, ERROR_PREVIEW_MAX);
}

export function looksLikeRawAgentErrorPayload(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.includes('"error"')) return true;
  if (/^\d{3}\s*<\s*!?(?:DOCTYPE\s+)?html/i.test(trimmed)) return true;
  if (/^<\s*!?DOCTYPE\s+html/i.test(trimmed)) return true;
  return false;
}
