// AC-14's handoff half: a page reaches the agent as EXACTLY ONE untrusted
// context entry, and the staging is cleared once a turn has taken it.
//
// The security argument is the protocol's, not a new one: a renderer may author
// `additionalContext` entries of kind `untrusted` and nothing else
// (`core/agent/codec.ts`), and untrusted text can never acquire instruction
// authority. Staging a page is therefore a use of that rule, not an exception
// to it.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  acknowledgeThreadComposerContext,
  onThreadComposerContextRequest,
  pendingComposerAdditionalContext,
  requestSendContextToThreadComposer,
} from '../../src/renderer/agent/agentReveal';
import { stageComposerObject } from '../../src/renderer/ui/interactions/actionSteps';

afterEach(() => {
  for (const key of Object.keys(pendingComposerAdditionalContext())) {
    acknowledgeThreadComposerContext(key);
  }
});

describe('staging a page onto the composer', () => {
  test('stages exactly one UNTRUSTED entry', () => {
    stageComposerObject({
      kind: 'externalPage',
      contextId: 'ctx-1',
      label: 'An Example Article',
      value: 'Title: An Example Article\nURL: https://example.com/post',
    });
    const staged = pendingComposerAdditionalContext();
    expect(Object.keys(staged)).toHaveLength(1);
    const entry = Object.values(staged)[0]!;
    expect(entry.kind).toBe('untrusted');
    expect(entry.value).toContain('https://example.com/post');
  });

  test('re-staging the same page REPLACES rather than accumulates', () => {
    const page = {
      kind: 'externalPage' as const,
      contextId: 'ctx-1',
      label: 'First title',
      value: 'Title: First title',
    };
    stageComposerObject(page);
    stageComposerObject({ ...page, label: 'Second title', value: 'Title: Second title' });
    const staged = pendingComposerAdditionalContext();
    expect(Object.keys(staged)).toHaveLength(1);
    expect(Object.values(staged)[0]!.value).toBe('Title: Second title');
  });

  test('two different pages stage separately', () => {
    stageComposerObject({ kind: 'externalPage', contextId: 'a', label: 'A', value: 'A' });
    stageComposerObject({ kind: 'externalPage', contextId: 'b', label: 'B', value: 'B' });
    expect(Object.keys(pendingComposerAdditionalContext())).toHaveLength(2);
  });

  test('acknowledging clears it, so a later turn does not re-send the page', () => {
    stageComposerObject({ kind: 'externalPage', contextId: 'ctx-1', label: 'A', value: 'A' });
    const [key] = Object.keys(pendingComposerAdditionalContext());
    acknowledgeThreadComposerContext(key!);
    expect(pendingComposerAdditionalContext()).toEqual({});
  });

  test('a listener joining late still sees what is already staged', () => {
    requestSendContextToThreadComposer({ key: 'page:x', label: 'X', value: 'X' });
    const seen: string[] = [];
    const off = onThreadComposerContextRequest((context) => seen.push(context.key));
    off();
    expect(seen).toEqual(['page:x']);
  });

  test('a node still stages as a REFERENCE, not as untrusted context', () => {
    stageComposerObject({ kind: 'node', nodeId: 'n1', title: 'Alpha' });
    // A document node the user can already read is not untrusted external
    // content; it keeps the shipped reference handoff.
    expect(pendingComposerAdditionalContext()).toEqual({});
  });
});
