import { expect, test } from 'bun:test';
import { externalContextSourceKind } from '../../src/core/actions/objects';
import type { ExternalContext } from '../../src/core/launcher/context';

const context: ExternalContext = {
  id: 'context', capturedAt: '2026-09-05T00:00:00Z', captureOrigin: 'test',
  app: { name: 'Chrome' }, browser: { name: 'Chrome' }, providerId: 'unknown-app',
  confidence: 'fallback', warnings: [], permissions: [],
};

test('web identity requires captured HTTP(S) evidence, not a browser name', () => {
  expect(externalContextSourceKind(null)).toBe('unknown');
  expect(externalContextSourceKind({ ...context, app: { name: '' } })).toBe('unknown');
  expect(externalContextSourceKind(context)).toBe('application');
  for (const url of ['file:///document', 'mailto:a@example.com', 'not a URL']) {
    expect(externalContextSourceKind({ ...context, browser: { name: 'Chrome', url } })).toBe('application');
  }
  expect(externalContextSourceKind({ ...context, browser: { name: 'Chrome', url: 'https://example.com' } })).toBe('web');
  expect(externalContextSourceKind({ ...context, source: { url: 'http://example.com' } as ExternalContext['source'] })).toBe('web');
  expect(externalContextSourceKind({ ...context, source: { canonicalUrl: 'https://example.com' } as ExternalContext['source'] })).toBe('web');
});
