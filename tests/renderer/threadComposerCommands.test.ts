import { describe, expect, test } from 'bun:test';
import type {
  ThreadComposerDraft,
  ThreadComposerFileReference,
} from '../../src/renderer/agent/components/ThreadComposerEditor';
import type { SkillDefinition } from '../../src/renderer/api/types';
import {
  classifyNewThreadCommand,
  isExactSlashCommandMenuQuery,
  runtimeSlashCommands,
  slashCommandsFromSkills,
} from '../../src/renderer/agent/threadComposerCommands';

const COMMAND_LABELS = {
  compactDescription: 'Compact context',
  clearDescription: 'Clear context',
  newThreadDescription: 'Start a new Thread',
};

function textDraft(text: string): ThreadComposerDraft {
  return {
    content: text ? [{ type: 'text', text }] : [],
    empty: text.length === 0,
    fileRefs: [],
    text,
  };
}

function skillDefinition(name: string, userInvocable = true): SkillDefinition {
  return {
    name,
    source: 'project',
    rootDir: `/skills/${name}`,
    skillFile: `/skills/${name}/SKILL.md`,
    description: `${name} description`,
    hasUserSpecifiedDescription: true,
    userInvocable,
    modelInvocable: true,
    allowedTools: [],
    argumentNames: [],
    execution: 'inline',
    contentLength: 1,
    body: name,
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

  test('closes the menu only for exact command tokens that need no insertion rewrite', () => {
    const commands = runtimeSlashCommands(COMMAND_LABELS);

    expect(isExactSlashCommandMenuQuery('new', commands)).toBe(true);
    expect(isExactSlashCommandMenuQuery('clear', commands)).toBe(true);
    expect(isExactSlashCommandMenuQuery('compact', commands)).toBe(false);
    expect(isExactSlashCommandMenuQuery('New', commands)).toBe(false);
    expect(isExactSlashCommandMenuQuery('ne', commands)).toBe(false);
  });

  test('keeps compact as the default command and appends new after existing runtime commands', () => {
    expect(runtimeSlashCommands(COMMAND_LABELS).map((command) => command.label)).toEqual([
      '/compact',
      '/clear',
      '/new',
    ]);
  });

  test('reserves runtime command names from user-invocable Skills', () => {
    const commands = slashCommandsFromSkills([
      skillDefinition('new'),
      skillDefinition('NEW'),
      skillDefinition('clear'),
      skillDefinition('workspace-review'),
      skillDefinition('hidden', false),
    ], COMMAND_LABELS);

    expect(commands.map((command) => command.label)).toEqual([
      '/compact',
      '/clear',
      '/new',
      '/workspace-review',
    ]);
  });
});
