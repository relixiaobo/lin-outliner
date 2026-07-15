import { describe, expect, test } from 'bun:test';
import { Core } from '../../src/core/core';
import type { AgentIssue } from '../../src/core/agentIssue';
import { TAG_DAY_ID } from '../../src/core/types';
import {
  prepareIssueExecution,
  validateIssueNodeDefinition,
} from '../../src/main/agentIssueExecutionPreparation';

describe('Agent Issue execution preparation', () => {
  test('rejects unresolved selectors, notes, destructive output, and invalid output parents', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const note = mustFocus(core.createNode(today, null, 'Deleted note'));
    core.trashNode(note);
    const target = mustFocus(core.createNode(today, null, 'Reference target'));
    const referenceOwner = mustFocus(core.createNode(today, null, 'Reference owner'));
    const reference = mustFocus(core.addReference(referenceOwner, target, null));

    const validation = validateIssueNodeDefinition({
      input: { type: 'selected-nodes', nodeIds: ['node:missing'] },
      noteNodeIds: [note],
      output: { type: 'append-to-node', nodeId: reference },
    }, core.projection());

    expect(validation).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'node_not_found', path: 'input.nodeIds.0' }),
      expect.objectContaining({ code: 'node_in_trash', path: 'noteNodeIds.0' }),
      expect.objectContaining({ code: 'reference_output_ambiguous', path: 'output.nodeId' }),
    ]));
    expect(validateIssueNodeDefinition({
      input: { type: 'saved-query', queryId: 'query:later' },
      output: { type: 'replace-input', requiresConfirmation: true },
    }, core.projection())).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'saved_query_not_supported' }),
      expect.objectContaining({ code: 'replace_input_confirmation_unavailable' }),
    ]));
    expect(validateIssueNodeDefinition({
      output: { type: 'daily-note', datePolicy: 'due-date' },
    }, core.projection())).toContainEqual(expect.objectContaining({
      code: 'daily_note_due_date_missing',
    }));
    expect(validateIssueNodeDefinition({
      output: { type: 'daily-note', datePolicy: 'due-date' },
    }, core.projection(), { materializedRecurring: true })).toEqual([]);
    expect(validateIssueNodeDefinition({
      dueDate: { targetAt: Number.NaN, timeZone: 'Not/AZone' },
      output: { type: 'daily-note', datePolicy: 'due-date' },
    }, core.projection())).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'daily_note_date_invalid' }),
      expect.objectContaining({ code: 'daily_note_time_zone_invalid' }),
    ]));
  });

  test('keeps tag queries dynamic and warns when the current snapshot is empty', async () => {
    const core = Core.new();
    const tagId = mustFocus(core.createTag('invoice'));
    const issue = issueWith({
      input: { type: 'tag-query', tag: tagId },
      output: { type: 'activity-only' },
    });

    const empty = await prepareIssueExecution(issue, core.projection(), 100, { mode: 'preview' });
    expect(empty).toMatchObject({
      ok: true,
      prepared: {
        mode: 'preview',
        inputSnapshot: { nodeIds: [] },
        warnings: [expect.objectContaining({ code: 'input_query_empty' })],
      },
    });

    const invoice = mustFocus(core.createNode(core.projection().todayId, null, 'Invoice'));
    core.applyTag(invoice, tagId);
    const populated = await prepareIssueExecution(issue, core.projection(), 200, { mode: 'preview' });
    expect(populated).toMatchObject({
      ok: true,
      prepared: {
        inputSnapshot: { nodeIds: [invoice], resolvedAt: 200 },
        warnings: [],
      },
    });
  });

  test('previews Daily Note output without mutation and resolves it concretely for requests', async () => {
    const core = Core.new();
    const now = Date.parse('2031-02-03T10:30:00Z');
    const issue = issueWith({
      trigger: { type: 'scheduled', startAt: now, timeZone: 'UTC' },
      output: { type: 'daily-note', datePolicy: 'session-date' },
    });
    const nodeCountBefore = core.projection().nodes.length;

    const preview = await prepareIssueExecution(issue, core.projection(), now, { mode: 'preview' });
    expect(preview).toMatchObject({
      ok: true,
      prepared: {
        mode: 'preview',
        outputSnapshot: { type: 'daily-note', datePolicy: 'session-date' },
      },
    });
    expect(core.projection().nodes).toHaveLength(nodeCountBefore);

    const request = await prepareIssueExecution(issue, core.projection(), now, {
      mode: 'request',
      ensureDailyNote: async (date) => {
        expect(date).toMatchObject({ isoDate: '2031-02-03', timeZone: 'UTC' });
        return mustFocus(core.ensureDateNode(date.year, date.month, date.day));
      },
      getProjection: () => core.projection(),
    });
    expect(request).toMatchObject({
      ok: true,
      prepared: {
        mode: 'request',
        outputSnapshot: { type: 'create-child-under-node' },
      },
    });
    if (!request.ok || request.prepared.outputSnapshot?.type !== 'create-child-under-node') {
      throw new Error('Expected concrete Daily Note output.');
    }
    expect(core.state().nodes[request.prepared.outputSnapshot.nodeId]?.content.text).toBe('2031-02-03');
  });

  test('rejects a same-title day-tagged node outside the canonical Daily Notes path', async () => {
    const core = Core.new();
    const now = Date.parse('2032-04-05T08:00:00Z');
    const fakeDay = mustFocus(core.createNode(core.projection().todayId, null, '2032-04-05'));
    core.applyTag(fakeDay, TAG_DAY_ID);
    const result = await prepareIssueExecution(issueWith({
      trigger: { type: 'scheduled', startAt: now, timeZone: 'UTC' },
      output: { type: 'daily-note', datePolicy: 'session-date' },
    }), core.projection(), now, {
      mode: 'request',
      ensureDailyNote: async () => fakeDay,
      getProjection: () => core.projection(),
    });

    expect(result).toEqual({
      ok: false,
      validation: [expect.objectContaining({ code: 'daily_note_resolution_invalid' })],
    });
  });

  test('uses recurrence metadata to prepare legacy materialized due-date output', async () => {
    const core = Core.new();
    const windowStartAt = Date.parse('2033-06-07T02:00:00Z');
    const result = await prepareIssueExecution(issueWith({
      recurrence: {
        recurringIssueId: 'recurring-issue:legacy',
        windowStartAt,
        windowEndAt: windowStartAt + 24 * 60 * 60 * 1_000,
        materializedAt: windowStartAt,
        timeZone: 'Asia/Shanghai',
      },
      output: { type: 'daily-note', datePolicy: 'due-date' },
    }), core.projection(), windowStartAt + 60_000, {
      mode: 'request',
      ensureDailyNote: async (date) => {
        expect(date).toMatchObject({
          isoDate: '2033-06-07',
          timeZone: 'Asia/Shanghai',
          basis: 'due-date',
        });
        return mustFocus(core.ensureDateNode(date.year, date.month, date.day));
      },
      getProjection: () => core.projection(),
    });

    expect(result).toMatchObject({
      ok: true,
      prepared: { outputSnapshot: { type: 'create-child-under-node' } },
    });
  });
});

function issueWith(overrides: Partial<AgentIssue> = {}): AgentIssue {
  return {
    id: 'issue:preparation',
    title: 'Prepared work',
    status: { name: 'Ready', category: 'unstarted' },
    relations: [],
    trigger: { type: 'when-ready' },
    permissionMode: 'unattended',
    confirmation: { confirmedBy: { type: 'system' }, confirmedAt: 1 },
    revision: 'revision:1',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function mustFocus<T extends { focus?: { nodeId: string } }>(outcome: T): string {
  if (!outcome.focus) throw new Error('Expected focused node id.');
  return outcome.focus.nodeId;
}
