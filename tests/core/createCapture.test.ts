import { describe, expect, test } from 'bun:test';
import { Core } from '../../src/core/core';
import { plainText } from '../../src/core/types';
import { buildContextCaptureInput, buildManualCaptureInput, CAPTURE_FIELD } from '../../src/core/launcher/sources';
import type { CaptureNodeMetadata } from '../../src/core/launcher/sources';
import type { ExternalContext } from '../../src/core/launcher/context';
import { projectFieldTypeById } from '../../src/core/configProjection';

function mustFocus<T extends { focus?: { nodeId: string } }>(outcome: T) {
  expect(outcome.focus).toBeDefined();
  return outcome.focus!.nodeId;
}

function sampleMetadata(): CaptureNodeMetadata {
  return {
    schemaVersion: 1,
    captureId: 'cap-1',
    createdBy: 'launcher',
    capturedAt: '2026-06-03T10:00:00.000Z',
    origin: 'global-hotkey',
    providerId: 'generic-webpage',
    app: { name: 'Google Chrome', bundleId: 'com.google.Chrome', windowTitle: 'Example' },
    source: {
      kind: 'article',
      title: 'Why local-first apps need durable sync',
      original: { kind: 'remote-url', url: 'https://example.com/article', preview: 'external-browser' },
      url: 'https://example.com/article',
      author: { name: 'Jane Doe' },
      providerId: 'generic-webpage',
    },
    status: 'saved',
    intent: 'clip',
    warnings: [{ code: 'provider-partial', message: 'Some fields missing' }],
  };
}

describe('Core.createCapture', () => {
  test('creates a capture root node carrying title, description, sidecar, and a child', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createCapture({
      destinationParentId: libraryId,
      title: plainText('Why local-first apps need durable sync'),
      description: 'clipped from Safari',
      metadata: sampleMetadata(),
      children: [{ content: plainText('Local-first software keeps a full copy on device.'), children: [] }],
    }));

    const node = core.projection().nodes.find((entry) => entry.id === id);
    expect(node).toBeDefined();
    expect(node?.parentId).toBe(libraryId);
    expect(node?.content.text).toBe('Why local-first apps need durable sync');
    expect(node?.description).toBe('clipped from Safari');
    expect(node?.capture).toEqual(sampleMetadata());

    expect(node?.children.length).toBe(1);
    const child = core.projection().nodes.find((entry) => entry.id === node?.children[0]);
    expect(child?.content.text).toBe('Local-first software keeps a full copy on device.');
  });

  test('the capture sidecar survives a Loro serialize/reload round-trip', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createCapture({
      destinationParentId: libraryId,
      title: plainText('Round-trip me'),
      metadata: sampleMetadata(),
    }));

    const reloaded = Core.fromState(Core.deserializeState(core.serializeState()));
    const node = reloaded.projection().nodes.find((entry) => entry.id === id);
    expect(node?.capture).toEqual(sampleMetadata());
    expect(node?.content.text).toBe('Round-trip me');
  });

  test('omits the sidecar entirely on nodes that are not captures', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createNode(libraryId, null, 'plain row'));
    const node = core.projection().nodes.find((entry) => entry.id === id);
    expect(node?.capture).toBeUndefined();
  });
});

describe('buildManualCaptureInput', () => {
  test('builds a minimal launcher capture with no reopenable original', () => {
    const input = buildManualCaptureInput({
      destinationParentId: 'node:today',
      title: '  Buy milk  ',
      note: '  from the launcher  ',
      captureId: 'cap:1',
      capturedAt: '2026-06-03T10:00:00.000Z',
    });
    expect(input.destinationParentId).toBe('node:today');
    expect(input.title.text).toBe('Buy milk'); // collapsed to a single line + trimmed
    expect(input.description).toBe('from the launcher'); // note trimmed
    expect(input.metadata.createdBy).toBe('launcher');
    expect(input.metadata.intent).toBe('capture');
    expect(input.metadata.providerId).toBe('unknown-app');
    expect(input.metadata.source.original).toEqual({ kind: 'app-resource', preview: 'unsupported' });
    expect(input.tag).toBeUndefined(); // a typed note is not tagged #capture
  });

  test('drops an empty note', () => {
    const input = buildManualCaptureInput({
      destinationParentId: 'node:today',
      title: 'No note',
      note: '   ',
      captureId: 'cap:2',
      capturedAt: '2026-06-03T10:00:00.000Z',
    });
    expect(input.description).toBeUndefined();
  });

  test('manual capture lands under today and carries the launcher sidecar', () => {
    const core = Core.new();
    const now = new Date();
    const ensured = core.ensureDateNode(now.getFullYear(), now.getMonth() + 1, now.getDate());
    const todayId = ensured.projection.todayId;
    const input = buildManualCaptureInput({
      destinationParentId: todayId,
      title: 'Captured from launcher',
      captureId: 'cap:3',
      capturedAt: now.toISOString(),
    });
    const id = mustFocus(core.createCapture(input));
    const node = core.projection().nodes.find((entry) => entry.id === id);
    expect(node?.parentId).toBe(todayId);
    expect(node?.content.text).toBe('Captured from launcher');
    expect(node?.capture?.createdBy).toBe('launcher');
    expect(node?.capture?.source.kind).toBe('app');
  });
});

function webpageContext(overrides: Partial<ExternalContext> = {}): ExternalContext {
  return {
    id: 'ctx:1',
    capturedAt: '2026-06-03T10:00:00.000Z',
    captureOrigin: 'global-hotkey',
    app: { name: 'Google Chrome', bundleId: 'com.google.Chrome' },
    browser: { name: 'Google Chrome', tabTitle: 'Tab', url: 'https://example.com/a', hostname: 'example.com' },
    providerId: 'generic-webpage',
    confidence: 'exact',
    source: {
      kind: 'article',
      title: 'A great article',
      original: { kind: 'remote-url', url: 'https://example.com/a', preview: 'web-preview' },
      url: 'https://example.com/a',
      providerId: 'generic-webpage',
    },
    warnings: [],
    permissions: ['macos-automation', 'browser-automation'],
    ...overrides,
  };
}

describe('buildContextCaptureInput', () => {
  test('the captured body is never projected into the outline (basic-info only)', () => {
    const input = buildContextCaptureInput({
      context: webpageContext(),
      destinationParentId: 'node:today',
      captureId: 'cap:none',
    });
    // Basic-info capture: a link + native fields, no body children or body field.
    expect(input.children).toBeUndefined();
    expect(input.fields?.some((f) => f.field.id !== CAPTURE_FIELD.url.id)).toBe(false);
  });

  test('projects the source into a capture tag + native fields', () => {
    const input = buildContextCaptureInput({
      context: webpageContext(),
      destinationParentId: 'node:today',
      captureId: 'cap:ctx-1',
    });
    expect(input.title.text).toBe('A great article');
    expect(input.description).toBeUndefined(); // no user note; the URL is a field, not the description
    expect(input.tag).toBe('article'); // article kind → #article
    expect(input.tagExtends).toBe('capture'); // rolls up to #capture
    expect(input.fields).toEqual([{ field: CAPTURE_FIELD.url, value: 'https://example.com/a' }]);
    expect(input.metadata.providerId).toBe('generic-webpage');
    expect(input.metadata.source.url).toBe('https://example.com/a');
    expect(input.metadata.status).toBe('saved');
    expect(input.metadata.intent).toBe('capture');
  });

  test('Source field prefers the canonical URL; author/published become fields', () => {
    const input = buildContextCaptureInput({
      context: webpageContext({
        source: {
          kind: 'article',
          title: 'Canonical wins',
          original: { kind: 'remote-url', url: 'https://m.example.com/a?utm=x', preview: 'web-preview' },
          url: 'https://m.example.com/a?utm=x',
          canonicalUrl: 'https://example.com/a',
          author: { name: 'Jane Doe' },
          publishedAt: '2026-05-31',
          providerId: 'generic-webpage',
        },
      }),
      destinationParentId: 'node:today',
      captureId: 'cap:ctx-canon',
    });
    expect(input.fields).toEqual([
      { field: CAPTURE_FIELD.url, value: 'https://example.com/a' },
      { field: CAPTURE_FIELD.author, value: 'Jane Doe' },
      { field: CAPTURE_FIELD.published, value: '2026-05-31' },
    ]);
  });

  test('a multi-line captured title is collapsed to a single line', () => {
    const input = buildContextCaptureInput({
      context: webpageContext({
        source: {
          kind: 'tweet',
          title: '(3) Wade Watts: "@x Codex broke!!!\n\nexceeded retry limit,\n  last status: 429"',
          original: { kind: 'remote-url', url: 'https://x.com/x/status/1', preview: 'web-preview' },
          url: 'https://x.com/x/status/1',
          providerId: 'x-twitter',
        },
      }),
      destinationParentId: 'node:today',
      captureId: 'cap:ctx-nl',
    });
    expect(input.title.text).toBe('(3) Wade Watts: "@x Codex broke!!! exceeded retry limit, last status: 429"');
    expect(input.title.text).not.toContain('\n');
  });

  test('a full ISO published timestamp is reduced to a valid date-field value', () => {
    const input = buildContextCaptureInput({
      context: webpageContext({
        source: {
          kind: 'article',
          title: 'Dated',
          original: { kind: 'remote-url', url: 'https://example.com/a', preview: 'web-preview' },
          url: 'https://example.com/a',
          publishedAt: '2026-06-02T17:29:46+08:00',
          providerId: 'generic-webpage',
        },
      }),
      destinationParentId: 'node:today',
      captureId: 'cap:ctx-iso',
    });
    const published = input.fields?.find((f) => f.field.id === CAPTURE_FIELD.published.id);
    expect(published).toEqual({ field: CAPTURE_FIELD.published, value: '2026-06-02' });
  });

  test('a generic webpage (non-article) tags #capture with no supertag', () => {
    const input = buildContextCaptureInput({
      context: webpageContext({
        source: {
          kind: 'webpage',
          title: 'Some page',
          original: { kind: 'remote-url', url: 'https://example.com/p', preview: 'web-preview' },
          url: 'https://example.com/p',
          providerId: 'generic-webpage',
        },
      }),
      destinationParentId: 'node:today',
      captureId: 'cap:ctx-web',
    });
    expect(input.tag).toBe('capture');
    expect(input.tagExtends).toBeUndefined();
  });

  test('a user note populates the description, separate from the Source field', () => {
    const input = buildContextCaptureInput({
      context: webpageContext(),
      destinationParentId: 'node:today',
      captureId: 'cap:ctx-note',
      note: '  remember this  ',
    });
    expect(input.description).toBe('remember this');
    expect(input.fields).toEqual([{ field: CAPTURE_FIELD.url, value: 'https://example.com/a' }]);
  });

  test('warnings on the context mark the capture partial and are carried over', () => {
    const input = buildContextCaptureInput({
      context: webpageContext({
        confidence: 'probable',
        warnings: [{ code: 'page-script-blocked', message: 'toggle off', permission: 'browser-automation' }],
      }),
      destinationParentId: 'node:today',
      captureId: 'cap:ctx-2',
      intent: 'read-later',
    });
    expect(input.metadata.status).toBe('partial');
    expect(input.metadata.intent).toBe('read-later');
    expect(input.metadata.warnings).toHaveLength(1);
    expect(input.metadata.warnings[0]?.code).toBe('page-script-blocked');
  });

  test('falls back to an app-resource source when the context has none', () => {
    const input = buildContextCaptureInput({
      context: webpageContext({ providerId: 'unknown-app', source: undefined, app: { name: 'Slack' } }),
      destinationParentId: 'node:today',
      captureId: 'cap:ctx-3',
    });
    expect(input.title.text).toBe('Tab'); // falls to browser.tabTitle, then app name
    expect(input.metadata.source.kind).toBe('app');
    expect(input.metadata.source.original).toEqual({ kind: 'app-resource', preview: 'unsupported' });
  });

  test('a context capture persists end-to-end through Core with tag + seeded URL field', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const input = buildContextCaptureInput({
      context: webpageContext({
        source: {
          kind: 'article',
          title: 'A great article',
          original: { kind: 'remote-url', url: 'https://example.com/a', preview: 'web-preview' },
          url: 'https://example.com/a',
          publishedAt: '2026-05-31',
          providerId: 'generic-webpage',
        },
      }),
      destinationParentId: libraryId,
      captureId: 'cap:ctx-4',
    });
    const id = mustFocus(core.createCapture(input));
    const reloaded = Core.fromState(Core.deserializeState(core.serializeState()));
    const nodes = reloaded.projection().nodes;
    const node = nodes.find((entry) => entry.id === id);
    expect(node?.capture?.providerId).toBe('generic-webpage');
    expect(node?.capture?.source.url).toBe('https://example.com/a');

    // Native outline shape: an #article tag (extends #capture) ...
    const tagDefs = nodes.filter((n) => n.type === 'tagDef');
    const articleTag = tagDefs.find((n) => n.content.text === 'article');
    expect(articleTag).toBeDefined();
    expect(tagDefs.find((n) => n.content.text === 'capture')).toBeDefined();
    expect(node?.tags).toContain(articleTag!.id);

    // ... and the seeded URL field def (stable id), with a value child = the link.
    const urlDef = nodes.find((n) => n.id === CAPTURE_FIELD.url.id);
    expect(urlDef?.type).toBe('fieldDef');
    expect(urlDef?.content.text).toBe('URL');
    const fieldEntry = nodes.find(
      (n) => n.type === 'fieldEntry' && n.parentId === id && n.fieldDefId === CAPTURE_FIELD.url.id,
    );
    expect(fieldEntry).toBeDefined();
    expect(nodes.find((n) => n.parentId === fieldEntry!.id)?.content.text).toBe('https://example.com/a');

    // The URL field is a url type (clickable), seeded by id — not name-matched.
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(projectFieldTypeById(byId, CAPTURE_FIELD.url.id)).toBe('url');
    expect(projectFieldTypeById(byId, CAPTURE_FIELD.published.id)).toBe('date');
  });

  test('an existing user-customized field def at the same id is respected, not overwritten', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    // First capture seeds the URL field (url type).
    core.createCapture(buildContextCaptureInput({ context: webpageContext(), destinationParentId: libraryId, captureId: 'cap:a' }));
    // User downgrades it to plain.
    core.setFieldConfig(CAPTURE_FIELD.url.id, { fieldType: 'plain' });
    // A second capture reuses the same def by id without resetting the user's edit.
    core.createCapture(buildContextCaptureInput({ context: webpageContext(), destinationParentId: libraryId, captureId: 'cap:b' }));
    const nodes = core.projection().nodes;
    expect(nodes.filter((n) => n.id === CAPTURE_FIELD.url.id)).toHaveLength(1);
    expect(projectFieldTypeById(new Map(nodes.map((n) => [n.id, n])), CAPTURE_FIELD.url.id)).toBe('plain');
  });

  test('capture field defs are stable across captures (one def per id, no duplicates)', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    core.createCapture(buildContextCaptureInput({ context: webpageContext(), destinationParentId: libraryId, captureId: 'cap:a' }));
    core.createCapture(buildContextCaptureInput({ context: webpageContext(), destinationParentId: libraryId, captureId: 'cap:b' }));
    const nodes = core.projection().nodes;
    expect(nodes.filter((n) => n.id === CAPTURE_FIELD.url.id)).toHaveLength(1);
    expect(nodes.filter((n) => n.type === 'tagDef' && n.content.text === 'article')).toHaveLength(1);
    expect(nodes.filter((n) => n.type === 'tagDef' && n.content.text === 'capture')).toHaveLength(1);
  });
});
