import { describe, expect, test } from 'bun:test';
import type { DocumentProjection, Node, NodeProjection } from '../../src/core/types';
import { selectDueCommands } from '../../src/main/commandScheduler';

const TRASH_ID = 'trash-root';

function node(partial: Partial<Node> & { id: string }): NodeProjection {
  return {
    parentId: undefined,
    children: [],
    content: { text: '', marks: [], inlineRefs: [] },
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    locked: false,
    autoCollected: false,
    ...partial,
  } as NodeProjection;
}

function projection(nodes: NodeProjection[]): DocumentProjection {
  return {
    workspaceId: 'ws',
    rootId: 'root',
    libraryId: 'lib',
    dailyNotesId: 'daily',
    schemaId: 'schema',
    searchesId: 'searches',
    recentsId: 'recents',
    trashId: TRASH_ID,
    settingsId: 'settings',
    todayId: 'today',
    nodes: [node({ id: TRASH_ID, children: nodes.filter((n) => isTrashed(n)).map((n) => n.id) }), ...nodes],
  };
}

// Mark a fixture node as trashed by tagging it; `projection` wires trash children.
const TRASHED = new Set<string>();
function isTrashed(n: NodeProjection): boolean {
  return TRASHED.has(n.id);
}

describe('selectDueCommands', () => {
  test('fires a one-off command once its anchor has passed and it has never fired', () => {
    const cmd = node({
      id: 'cmd', type: 'command',
      content: { text: 'Summarize overdue items', marks: [], inlineRefs: [] },
      commandSchedule: '2026-06-09T09:00',
    });
    const now = new Date(2026, 5, 9, 10, 0); // 09 Jun 2026 10:00 local — past the anchor
    const due = selectDueCommands(projection([cmd]), now);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ nodeId: 'cmd', brief: 'Summarize overdue items', lastSuccessAt: null });
  });

  test('does not fire before the anchor', () => {
    const cmd = node({ id: 'cmd', type: 'command', commandSchedule: '2026-06-09T09:00' });
    const now = new Date(2026, 5, 9, 8, 0);
    expect(selectDueCommands(projection([cmd]), now)).toHaveLength(0);
  });

  test('does not re-fire an occurrence already covered by the watermark', () => {
    const cmd = node({
      id: 'cmd', type: 'command',
      commandSchedule: '2026-06-09T09:00',
      sysLastRunAt: new Date(2026, 5, 9, 9, 30).getTime(), // fired after the 09:00 due time
    });
    const now = new Date(2026, 5, 9, 10, 0);
    expect(selectDueCommands(projection([cmd]), now)).toHaveLength(0);
  });

  test('coalesces a multi-day gap into a single daily fire', () => {
    const cmd = node({
      id: 'cmd', type: 'command',
      commandSchedule: '2026-06-01T09:00 RRULE:FREQ=DAILY',
      sysLastRunAt: new Date(2026, 5, 6, 9, 0).getTime(), // last fired 06 Jun
    });
    const now = new Date(2026, 5, 9, 10, 0); // 3 days later — fires ONCE (today's occurrence)
    const due = selectDueCommands(projection([cmd]), now);
    expect(due).toHaveLength(1);
    expect(due[0].dueAt).toBe(new Date(2026, 5, 9, 9, 0).getTime());
  });

  test('ignores command nodes with no schedule (manual-only)', () => {
    const cmd = node({ id: 'cmd', type: 'command' });
    expect(selectDueCommands(projection([cmd]), new Date(2026, 5, 9, 10, 0))).toHaveLength(0);
  });

  test('ignores non-command nodes even if they carry a schedule-shaped field', () => {
    const plain = node({ id: 'plain', commandSchedule: '2026-06-09T09:00' } as Partial<Node> & { id: string });
    expect(selectDueCommands(projection([plain]), new Date(2026, 5, 9, 10, 0))).toHaveLength(0);
  });

  test('pauses a trashed command node', () => {
    TRASHED.add('cmd');
    try {
      const cmd = node({ id: 'cmd', type: 'command', commandSchedule: '2026-06-09T09:00' });
      expect(selectDueCommands(projection([cmd]), new Date(2026, 5, 9, 10, 0))).toHaveLength(0);
    } finally {
      TRASHED.delete('cmd');
    }
  });
});
