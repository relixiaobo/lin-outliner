import { describe, expect, test } from 'bun:test';
import { buildLauncherItems, deriveActiveIndex, filterCommands, formatHotkey, primaryActionLabel, remediationForContext, rowKey, rowView, stepActiveKey } from '../../src/renderer/launcher/launcherModel';
import type { LauncherItem } from '../../src/renderer/launcher/launcherModel';
import type { LauncherCommandView, LauncherNodeMatch } from '../../src/core/launcher/commands';
import type { ExternalContext } from '../../src/core/launcher/context';

// Every shipped command is runnable — there is no disabled "coming soon" state.
const COMMANDS: LauncherCommandView[] = [
  { id: 'open-main', title: 'Open main window' },
  { id: 'open-settings', title: 'Open Settings' },
];

const NODES: LauncherNodeMatch[] = [
  { nodeId: 'node:1', title: 'Caching strategies', subtitle: 'Engineering' },
  { nodeId: 'node:2', title: 'Cache invalidation notes' },
];

function webpageContext(overrides: Partial<ExternalContext['source']> = {}): ExternalContext {
  return {
    id: 'ctx-1',
    capturedAt: '2026-06-03T00:00:00',
    captureOrigin: 'test',
    app: { name: 'Safari' },
    browser: { name: 'Safari', tabTitle: 'Example', hostname: 'example.com', url: 'https://example.com/post' },
    providerId: 'generic-webpage',
    confidence: 'probable',
    source: {
      kind: 'article',
      title: 'An Example Article',
      original: { kind: 'remote-url', url: 'https://example.com/post', preview: 'web-preview' },
      url: 'https://example.com/post',
      providerId: 'generic-webpage',
      ...overrides,
    },
    warnings: [],
    permissions: [],
  };
}

function firstOfKind(items: LauncherItem[], kind: LauncherItem['kind']): LauncherItem | undefined {
  return items.find((i) => i.kind === kind);
}

describe('buildLauncherItems', () => {
  test('no context, no query → only commands (no capture rows)', () => {
    const items = buildLauncherItems({ query: '', context: null, commands: COMMANDS });
    expect(items.every((i) => i.kind === 'command')).toBe(true);
    expect(items).toHaveLength(COMMANDS.length);
  });

  test('no context, typed text → a standalone note row first', () => {
    const items = buildLauncherItems({ query: '  buy milk  ', context: null, commands: COMMANDS });
    expect(items[0].kind).toBe('capture-note');
    const note = items[0];
    if (note.kind !== 'capture-note') throw new Error('expected note');
    expect(note.text).toBe('buy milk');
    expect(note.actions[0]).toMatchObject({ id: 'capture-note' });
  });

  test('page context, no query → a single capture-page row (page only), no note', () => {
    const items = buildLauncherItems({ query: '', context: webpageContext(), commands: COMMANDS });
    const page = firstOfKind(items, 'capture-page');
    expect(page?.kind).toBe('capture-page');
    if (page?.kind !== 'capture-page') throw new Error('expected page');
    expect(page.title).toBe('An Example Article');
    expect(page.subtitle).toBe('example.com');
    expect(page.note).toBeUndefined();
    expect(page.actions[0]).toMatchObject({ id: 'capture-page', label: 'Capture page to Today' });
    expect(firstOfKind(items, 'capture-note')).toBeUndefined();
  });

  test('page context + typed text → page row (with note rider), then a new-node escape hatch', () => {
    const items = buildLauncherItems({ query: 'great point on caching', context: webpageContext(), commands: COMMANDS });
    expect(items[0].kind).toBe('capture-page');
    expect(items[1].kind).toBe('capture-note');
    const page = items[0];
    if (page.kind !== 'capture-page') throw new Error('expected page');
    expect(page.note).toBe('great point on caching');
    // The typed text rides along as the capture's comment (shown in the subtitle);
    // the action label stays the plain capture — no "+ note" variant.
    expect(page.actions[0].label).toBe('Capture page to Today');
    const escape = items[1];
    if (escape.kind !== 'capture-note') throw new Error('expected note escape hatch');
    expect(escape.actions[0].label).toBe('New node in Today');
  });

  test('capture-page has exactly one action — no disabled "coming soon" secondaries', () => {
    const items = buildLauncherItems({ query: '', context: webpageContext(), commands: COMMANDS });
    const page = items[0];
    if (page.kind !== 'capture-page') throw new Error('expected page');
    // Save to Inbox / Ask AI with source were removed; they return with their
    // follow-up plans rather than shipping as disabled stubs.
    expect(page.actions).toHaveLength(1);
    expect(page.actions[0]).toMatchObject({ id: 'capture-page' });
  });

  test('a video source frames the row as "Capture video" with a plain hostname subtitle', () => {
    const items = buildLauncherItems({
      query: '',
      context: webpageContext({ kind: 'video', timestampSeconds: 95 }),
      commands: COMMANDS,
    });
    const page = items[0];
    if (page.kind !== 'capture-page') throw new Error('expected page');
    expect(page.actions[0].label).toBe('Capture video to Today');
    // The player position is deliberately not shown — subtitle is just where it's from.
    expect(page.subtitle).toBe('example.com');
  });

  test('a video + typed note keeps the plain "Capture video" label (note rides as a comment)', () => {
    const items = buildLauncherItems({
      query: 'key insight',
      context: webpageContext({ kind: 'video', timestampSeconds: 3661 }),
      commands: COMMANDS,
    });
    const page = items[0];
    if (page.kind !== 'capture-page') throw new Error('expected page');
    expect(page.actions[0].label).toBe('Capture video to Today');
    expect(page.note).toBe('key insight');
    expect(page.subtitle).toBe('example.com');
  });

  test('typed text also filters the command list by the same query', () => {
    const items = buildLauncherItems({ query: 'settings', context: null, commands: COMMANDS });
    const commands = items.filter((i) => i.kind === 'command');
    expect(commands).toHaveLength(1);
    if (commands[0].kind !== 'command') throw new Error('expected command');
    expect(commands[0].command.id).toBe('open-settings');
  });

  test('matching nodes appear inline (after captures, before commands), opening on Enter', () => {
    // Query "open" matches the node list (passed in) AND the open-* commands, so
    // both kinds are present to assert ordering.
    const items = buildLauncherItems({ query: 'open', context: null, commands: COMMANDS, nodes: NODES });
    const kinds = items.map((i) => i.kind);
    // No context, but the note row leads since text was typed → note, then node
    // matches, then commands.
    expect(kinds[0]).toBe('capture-note');
    expect(kinds.filter((k) => k === 'node')).toHaveLength(2);
    const firstNode = items.find((i) => i.kind === 'node');
    if (firstNode?.kind !== 'node') throw new Error('expected node');
    expect(firstNode.nodeId).toBe('node:1');
    expect(firstNode.actions[0]).toMatchObject({ id: 'open-node' });
    // Order: every node precedes every command.
    const lastNode = kinds.lastIndexOf('node');
    const firstCommand = kinds.indexOf('command');
    expect(lastNode).toBeLessThan(firstCommand);
  });

  test('page context + nodes: capture row leads, then node matches', () => {
    const items = buildLauncherItems({ query: 'cache', context: webpageContext(), commands: COMMANDS, nodes: NODES });
    expect(items[0].kind).toBe('capture-page');
    expect(items.some((i) => i.kind === 'node')).toBe(true);
    const firstNodeIndex = items.findIndex((i) => i.kind === 'node');
    const firstCaptureIndex = items.findIndex((i) => i.kind === 'capture-page');
    expect(firstCaptureIndex).toBeLessThan(firstNodeIndex);
  });
});

describe('rowView', () => {
  test('capture-page reads as a "Capture" command with the page as subtitle', () => {
    const items = buildLauncherItems({ query: '', context: webpageContext(), commands: COMMANDS });
    const view = rowView(items[0]);
    expect(view.title).toBe('Capture'); // the command name, NOT the page title
    expect(view.subtitle).toBe('An Example Article · example.com');
    expect(view.typeLabel).toBe('Command'); // capture is a command too
  });

  test('capture-page + note shows the note in the subtitle', () => {
    const items = buildLauncherItems({ query: 'great point', context: webpageContext(), commands: COMMANDS });
    const view = rowView(items[0]);
    expect(view.title).toBe('Capture');
    expect(view.subtitle).toBe('+ “great point” · example.com');
  });

  test('capture-note reads as "New node" with the quoted text', () => {
    const items = buildLauncherItems({ query: 'buy milk', context: null, commands: COMMANDS });
    const view = rowView(items[0]);
    expect(view.title).toBe('New node');
    expect(view.subtitle).toBe('“buy milk”');
    expect(view.typeLabel).toBe('Command');
  });

  test('a node row keeps the node text as title, parent as subtitle, type "Node"', () => {
    const items = buildLauncherItems({ query: 'cache', context: null, commands: COMMANDS, nodes: NODES });
    const node = items.find((i) => i.kind === 'node');
    if (!node) throw new Error('expected node');
    const view = rowView(node);
    expect(view.title).toBe('Caching strategies');
    expect(view.subtitle).toBe('Engineering');
    expect(view.typeLabel).toBe('Node');
  });

  test('every command row carries type "Command" and is runnable (no disabled state)', () => {
    const items = buildLauncherItems({ query: '', context: null, commands: COMMANDS });
    const commands = items.filter((i) => i.kind === 'command');
    expect(commands).toHaveLength(COMMANDS.length);
    for (const cmd of commands) {
      expect(rowView(cmd)).toMatchObject({ typeLabel: 'Command' });
    }
    const main = items.find((i) => i.kind === 'command' && i.command.id === 'open-main');
    if (!main) throw new Error('expected open-main');
    expect(rowView(main).title).toBe('Open main window');
  });
});

describe('selection helpers (identity-based, not raw index)', () => {
  const items = buildLauncherItems({ query: 'open', context: null, commands: COMMANDS, nodes: NODES });
  // items: capture-note, node:1, node:2, open-main, open-settings

  test('rowKey is stable per row identity', () => {
    expect(rowKey(items[0])).toBe('capture-note');
    const node = items.find((i) => i.kind === 'node')!;
    expect(rowKey(node)).toBe('node:node:1');
    const cmd = items.find((i) => i.kind === 'command')!;
    expect(rowKey(cmd)).toBe('cmd:open-main');
  });

  test('deriveActiveIndex follows the key, falling back to the top row', () => {
    expect(deriveActiveIndex(items, null)).toBe(0);
    expect(deriveActiveIndex(items, 'cmd:open-settings')).toBe(items.length - 1);
    // A key that no longer exists (its row vanished) falls back to the top.
    expect(deriveActiveIndex(items, 'node:gone')).toBe(0);
  });

  test('a selected row keeps its selection when the list reorders (the B-1 fix)', () => {
    // User selects open-main; then a query change drops the node rows.
    const before = items;
    const key = 'cmd:open-main';
    const fewer = buildLauncherItems({ query: 'open', context: null, commands: COMMANDS, nodes: [] });
    // Same key resolves to a (different, now-earlier) index — selection follows the row.
    expect(before[deriveActiveIndex(before, key)].kind).toBe('command');
    expect(fewer[deriveActiveIndex(fewer, key)].kind).toBe('command');
    expect((fewer[deriveActiveIndex(fewer, key)] as { command: { id: string } }).command.id).toBe('open-main');
  });

  test('stepActiveKey clamps at both ends and returns null for an empty list', () => {
    expect(stepActiveKey(items, 0, -1)).toBe(rowKey(items[0])); // clamp at top
    expect(stepActiveKey(items, items.length - 1, 1)).toBe(rowKey(items[items.length - 1])); // clamp at bottom
    expect(stepActiveKey(items, 0, 1)).toBe(rowKey(items[1]));
    expect(stepActiveKey([], 0, 1)).toBeNull();
  });
});

describe('filterCommands', () => {
  test('empty query returns all commands', () => {
    expect(filterCommands(COMMANDS, '   ')).toHaveLength(COMMANDS.length);
  });
  test('matches on title, case-insensitive', () => {
    expect(filterCommands(COMMANDS, 'OPEN')).toHaveLength(2);
  });
});

describe('formatHotkey', () => {
  test('renders an Electron accelerator as macOS key symbols', () => {
    expect(formatHotkey('CommandOrControl+Shift+Space')).toBe('⌘⇧␣');
    expect(formatHotkey('Option+Enter')).toBe('⌥↵');
  });
  test('passes unknown tokens through and handles null', () => {
    expect(formatHotkey('F5')).toBe('F5');
    expect(formatHotkey(null)).toBeNull();
  });
});

describe('primaryActionLabel', () => {
  test('returns the first action label, or null for nothing', () => {
    const items = buildLauncherItems({ query: 'x', context: null, commands: [] });
    expect(primaryActionLabel(items[0])).toBe('New node in Today');
    expect(primaryActionLabel(undefined)).toBeNull();
  });
});

describe('remediationForContext', () => {
  function contextWith(codes: string[], over: Partial<ExternalContext> = {}): ExternalContext {
    return {
      id: 'ctx',
      capturedAt: '2026-06-03T00:00:00',
      captureOrigin: 'test',
      app: { name: 'Google Chrome' },
      browser: { name: 'Google Chrome', hostname: 'example.com', url: 'https://example.com/' },
      providerId: 'generic-webpage',
      confidence: 'probable',
      warnings: codes.map((code) => ({ code, message: code })),
      permissions: [],
      ...over,
    };
  }

  test('no context or no warnings → no banner', () => {
    expect(remediationForContext(null)).toBeNull();
    expect(remediationForContext(contextWith([]))).toBeNull();
  });

  test('browser-tab-unavailable → automation hint pointing at System Settings', () => {
    const r = remediationForContext(contextWith(['browser-tab-unavailable']));
    expect(r?.kind).toBe('automation');
    expect(r?.detail).toContain('Automation');
    expect(r?.detail).toContain('Google Chrome');
  });

  test('basic-info capture has no in-page-script / multi-window / multi-instance hints', () => {
    // Those degradation modes went away with the in-page extraction path; only the
    // unreadable-tab (Automation) remediation remains.
    expect(remediationForContext(contextWith(['page-script-blocked']))).toBeNull();
    expect(remediationForContext(contextWith(['context-window-mismatch']))).toBeNull();
    expect(remediationForContext(contextWith(['browser-multiple-instances']))).toBeNull();
  });
});

