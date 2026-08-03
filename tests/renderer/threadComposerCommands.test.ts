import { describe, expect, test } from 'bun:test';
import type {
  ThreadComposerDraft,
  ThreadComposerFileReference,
} from '../../src/renderer/agent/components/ThreadComposerEditor';
import {
  classifyNewThreadCommand,
  isCompleteNewThreadMenuQuery,
} from '../../src/renderer/agent/threadComposerCommands';

function textDraft(text: string): ThreadComposerDraft {
  return {
    content: text ? [{ type: 'text', text }] : [],
    empty: text.length === 0,
    fileRefs: [],
    text,
  };
}

describe('new Thread composer command', () => {
  test('recognizes only exact trimmed /new text', () => {
    expect(classifyNewThreadCommand(textDraft('/new'))).toBe('ready');
    expect(classifyNewThreadCommand(textDraft('  /new\n'))).toBe('ready');
    expect(classifyNewThreadCommand(textDraft('/New'))).toBe('ordinary');
    expect(classifyNewThreadCommand(textDraft('/new project'))).toBe('ordinary');
  });

  test('blocks exact /new when a Node reference is present', () => {
    const draft = textDraft('/new');
    draft.content.push({
      type: 'nodeReference',
      reference: { nodeId: 'node-1', title: 'Research' },
    });

    expect(classifyNewThreadCommand(draft)).toBe('blockedByStructuredContent');
  });

  test('blocks a retained file reference even if the content projection is incomplete', () => {
    const reference: ThreadComposerFileReference = {
      attachmentId: 'attachment-1',
      mimeType: 'application/pdf',
      name: 'report.pdf',
      ref: 'managed-report',
      sizeBytes: 42,
    };
    const draft = textDraft('/new');
    draft.fileRefs.push(reference);

    expect(classifyNewThreadCommand(draft)).toBe('blockedByStructuredContent');
  });

  test('keeps non-exact slash text ordinary even with structured content', () => {
    const draft = textDraft('/new project');
    draft.content.push({
      type: 'nodeReference',
      reference: { nodeId: 'node-1', title: 'Research' },
    });

    expect(classifyNewThreadCommand(draft)).toBe('ordinary');
  });

  test('submits complete menu queries without rewriting casing variants', () => {
    const commands = [{ id: 'runtime:new', label: '/new' }];

    expect(isCompleteNewThreadMenuQuery('new', commands)).toBe(true);
    expect(isCompleteNewThreadMenuQuery('New', commands)).toBe(true);
    expect(isCompleteNewThreadMenuQuery('ne', commands)).toBe(false);
  });
});
