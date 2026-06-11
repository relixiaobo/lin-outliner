import { describe, expect, test } from 'bun:test';
import {
  parseAgentAuthoringInput,
  parseAgentMarkdownDocument,
  serializeAgentMarkdown,
} from '../../src/core/agentMarkdown';
import type { AgentAuthoringInput } from '../../src/core/agentTypes';

// The Form ⇄ Raw editor toggle (AgentEditor) converts entirely through these two
// functions, so their round-trip MUST be stable — a drift here silently mangles
// a user's AGENT.md when they flip modes. Main's loader is covered separately in
// agentAuthoring.test.ts; this guards the renderer-local inverse pair.

const FULL: AgentAuthoringInput = {
  name: 'Research Bot',
  description: 'Digs through the codebase',
  body: 'You are a researcher.\nReport findings as bullet points.',
  model: 'claude-opus-4-8',
  effort: 'high',
  permissionMode: 'restricted',
  maxTurns: 8,
  tools: ['file_read', 'file_grep'],
  disallowedTools: ['bash'],
  skills: ['research'],
  background: true,
};

describe('serializeAgentMarkdown ⇄ parseAgentAuthoringInput', () => {
  test('round-trips every field', () => {
    const back = parseAgentAuthoringInput(serializeAgentMarkdown(FULL));
    expect(back).toEqual(FULL);
  });

  test('a minimal input normalizes to empty/undefined, not noise', () => {
    const back = parseAgentAuthoringInput(serializeAgentMarkdown({ name: 'min', description: '', body: 'Body.' }));
    expect(back.name).toBe('min');
    expect(back.description).toBe('');
    expect(back.body).toBe('Body.');
    expect(back.model).toBeUndefined();
    expect(back.permissionMode).toBeUndefined();
    expect(back.maxTurns).toBeUndefined();
    expect(back.tools).toBeUndefined();
    expect(back.skills).toBeUndefined();
    expect(back.background).toBeUndefined();
  });

  test('model "inherit" is dropped on the way back', () => {
    const back = parseAgentAuthoringInput(serializeAgentMarkdown({ name: 'x', description: '', body: '', model: 'inherit' }));
    expect(back.model).toBeUndefined();
  });

  test('legacy trusted permission mode no longer widens agent definitions', () => {
    const input = parseAgentAuthoringInput(['---', 'name: legacy', 'permission-mode: trusted', '---', '', 'Body.'].join('\n'));
    expect(input.permissionMode).toBeUndefined();
  });
});

describe('parseAgentAuthoringInput tolerance', () => {
  test('accepts a comma-separated tools string and camelCase keys', () => {
    const raw = ['---', 'name: legacy', 'tools: file_read, bash', 'maxTurns: 5', 'disallowedTools: web_fetch', '---', '', 'Body here.'].join('\n');
    const input = parseAgentAuthoringInput(raw);
    expect(input.tools).toEqual(['file_read', 'bash']);
    expect(input.maxTurns).toBe(5);
    expect(input.disallowedTools).toEqual(['web_fetch']);
  });

  test('strips a leading BOM before the frontmatter fence', () => {
    const raw = `﻿---\nname: bommed\n---\n\nBody.`;
    expect(parseAgentAuthoringInput(raw).name).toBe('bommed');
  });

  test('a document with no frontmatter is all body', () => {
    const { frontmatter, body } = parseAgentMarkdownDocument('Just a persona, no fence.');
    expect(frontmatter).toEqual({});
    expect(body).toBe('Just a persona, no fence.');
  });

  test('an unterminated fence is treated as body, not a parse error', () => {
    const input = parseAgentAuthoringInput('---\nname: oops\nstill going');
    expect(input.name).toBe('');
    expect(input.body).toContain('still going');
  });
});
