import type { TurnError } from '../../core/agent/protocol';

const ERROR_PREVIEW_MAX = 280;
const SUBAGENT_BUDGET_EXHAUSTED_ERROR_CODE = 'subagent_budget_exhausted';

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}...` : text;
}

function parsedPayloadError(text: string): TurnError | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { code?: unknown; message?: unknown } | string;
      code?: unknown;
      message?: unknown;
    };
    const message = typeof parsed.error === 'string'
      ? parsed.error
      : parsed.error?.message ?? parsed.message;
    if (typeof message !== 'string' || !message.trim()) return null;
    const code = typeof parsed.error === 'object' && parsed.error !== null
      ? parsed.error.code
      : parsed.code;
    return {
      message: message.trim(),
      ...(typeof code === 'string' && code ? { code } : {}),
    };
  } catch {
    return null;
  }
}

function parsedPayloadMessage(text: string): string | null {
  return parsedPayloadError(text)?.message ?? null;
}

function htmlTitle(text: string): string | null {
  if (!text.trimStart().startsWith('<')) return null;
  return text.match(/<title[^>]*>([^<]+)<\/title>/iu)?.[1]?.trim() ?? null;
}

export function threadErrorMessage(raw: string): string {
  const trimmed = raw.trim().replace(/^Error:\s*/iu, '').replace(/^Proxy error:\s*/iu, '');
  const directMessage = parsedPayloadMessage(trimmed);
  if (directMessage) return truncate(directMessage, ERROR_PREVIEW_MAX);

  const providerStatus = trimmed.match(/^(?:[^:\n]{1,80}\s+)?API error\s*\((\d{3})\):\s*([\s\S]*)$/iu);
  const httpStatus = trimmed.match(/^(\d{3})\b\s*:?\s*([\s\S]*)$/u);
  const statusMatch = providerStatus ?? httpStatus;
  if (statusMatch) {
    const [, status, bodyRaw] = statusMatch;
    const body = bodyRaw.trim();
    const message = parsedPayloadMessage(body);
    if (message) return `HTTP ${status} - ${truncate(message, 200)}`;
    const title = htmlTitle(body);
    if (title) return `HTTP ${status} - ${truncate(title, 120)}`;
    return body ? `HTTP ${status} - ${truncate(body, 200)}` : `HTTP ${status}`;
  }

  const title = htmlTitle(trimmed);
  if (title) return truncate(title, 120);
  if (trimmed.startsWith('<')) return 'Server returned an HTML error page';
  return truncate(trimmed, ERROR_PREVIEW_MAX);
}

export function userFacingAgentError(raw: TurnError | string, resourceLimitMessage: string): string {
  const error = typeof raw === 'string'
    ? parsedPayloadError(raw) ?? { message: raw }
    : raw;
  return error.code === SUBAGENT_BUDGET_EXHAUSTED_ERROR_CODE
    ? resourceLimitMessage
    : threadErrorMessage(error.message);
}
