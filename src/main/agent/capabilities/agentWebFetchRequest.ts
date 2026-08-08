import {
  WEB_FETCH_CLIENT_HINT_PLATFORM,
  WEB_FETCH_CLIENT_HINT_UA,
  WEB_FETCH_USER_AGENT,
} from './agentWebConstants';
import { webFetchRefererForHop } from './agentWebFetchFallback';

export interface WebFetchRedirectContext {
  referrerUrl: string;
  secFetchSite: 'same-origin' | 'cross-site';
}

// Chromium owns Sec-Fetch-Mode for Session.fetch. Setting the navigation-only
// value manually makes the Fetch API reject every request before networking.
export function buildWebFetchHeaders(
  currentUrl: string,
  redirect?: WebFetchRedirectContext,
): Record<string, string> {
  const headers: Record<string, string> = {
    'user-agent': WEB_FETCH_USER_AGENT,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,text/plain;q=0.8,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'sec-ch-ua': WEB_FETCH_CLIENT_HINT_UA,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': WEB_FETCH_CLIENT_HINT_PLATFORM,
    'sec-fetch-dest': 'document',
    'upgrade-insecure-requests': '1',
  };
  if (!redirect) {
    headers['sec-fetch-site'] = 'none';
    headers['sec-fetch-user'] = '?1';
    return headers;
  }

  const referer = webFetchRefererForHop(redirect.referrerUrl, currentUrl);
  if (referer) headers.referer = referer;
  headers['sec-fetch-site'] = redirect.secFetchSite;
  return headers;
}
