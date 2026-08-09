import type { Session } from 'electron';
import {
  WEB_FETCH_CLIENT_HINT_PLATFORM,
  WEB_FETCH_CLIENT_HINT_UA,
  WEB_FETCH_USER_AGENT,
} from './agentWebConstants';

interface MutableRedirectTrace {
  readonly requestedUrl: string;
  readonly requestKey: string;
  requestId?: number;
  finalUrl?: string;
}

export interface WebFetchRedirectTrace {
  finalUrl(responseUrl: string): string;
  dispose(): void;
}

const redirectTrackers = new WeakMap<Session, WebFetchRedirectTracker>();

// Chromium owns the complete Fetch Metadata set for Session.fetch. Navigation
// values are invalid on this Fetch API path, and mixing them with Chromium's
// generated mode creates a self-contradictory request fingerprint.
export function buildWebFetchHeaders(): Record<string, string> {
  return {
    'user-agent': WEB_FETCH_USER_AGENT,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,text/plain;q=0.8,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'sec-ch-ua': WEB_FETCH_CLIENT_HINT_UA,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': WEB_FETCH_CLIENT_HINT_PLATFORM,
    'upgrade-insecure-requests': '1',
  };
}

export function beginWebFetchRedirectTrace(
  clientSession: Session,
  requestedUrl: string,
): WebFetchRedirectTrace {
  let tracker = redirectTrackers.get(clientSession);
  if (!tracker) {
    tracker = new WebFetchRedirectTracker(clientSession);
    redirectTrackers.set(clientSession, tracker);
  }
  return tracker.begin(requestedUrl);
}

class WebFetchRedirectTracker {
  private readonly pendingByUrl = new Map<string, MutableRedirectTrace[]>();
  private readonly activeByRequestId = new Map<number, MutableRedirectTrace>();

  constructor(clientSession: Session) {
    clientSession.webRequest.onBeforeRedirect((details) => {
      let trace = this.activeByRequestId.get(details.id);
      if (!trace) {
        const requestKey = networkUrlKey(details.url);
        const pending = this.pendingByUrl.get(requestKey);
        trace = pending?.shift();
        if (!pending?.length) this.pendingByUrl.delete(requestKey);
        if (!trace) return;
        trace.requestId = details.id;
        this.activeByRequestId.set(details.id, trace);
      }
      trace.finalUrl = details.redirectURL;
    });
  }

  begin(requestedUrl: string): WebFetchRedirectTrace {
    const trace: MutableRedirectTrace = {
      requestedUrl,
      requestKey: networkUrlKey(requestedUrl),
    };
    const pending = this.pendingByUrl.get(trace.requestKey) ?? [];
    pending.push(trace);
    this.pendingByUrl.set(trace.requestKey, pending);
    let disposed = false;

    return {
      finalUrl: (responseUrl) => trace.finalUrl || responseUrl || trace.requestedUrl,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        const queued = this.pendingByUrl.get(trace.requestKey);
        if (queued) {
          const index = queued.indexOf(trace);
          if (index >= 0) queued.splice(index, 1);
          if (!queued.length) this.pendingByUrl.delete(trace.requestKey);
        }
        if (trace.requestId !== undefined && this.activeByRequestId.get(trace.requestId) === trace) {
          this.activeByRequestId.delete(trace.requestId);
        }
      },
    };
  }
}

function networkUrlKey(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    return url.toString();
  } catch {
    return rawUrl;
  }
}
