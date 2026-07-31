import { describe, expect, test } from 'bun:test';
import * as icons from '../../src/renderer/ui/icons';

/**
 * Tool-row glyph semantics. The transcript renders these at 14px in a vertical
 * stack, so two tools that mean different things must not resolve to the same
 * glyph — and opposite actions must not resolve to glyphs that differ by a
 * single stroke. `docs/plans/icon-semantics.md` owns glyph choices app-wide;
 * these rows were settled here because the tool-row copy work made the
 * mismatches user-visible (see that plan's G13–G16).
 */
const TOOL_GLYPHS = {
  command: icons.TerminalIcon,
  fileCreate: icons.FileWriteToolIcon,
  fileEdit: icons.FileEditToolIcon,
  fileDelete: icons.FileDeleteToolIcon,
  fileRead: icons.FileReadToolIcon,
  fileGlob: icons.FileGlobToolIcon,
  fileGrep: icons.FileGrepToolIcon,
  nodeCreate: icons.NodeCreateToolIcon,
  nodeEdit: icons.NodeEditToolIcon,
  nodeDelete: icons.NodeDeleteToolIcon,
  nodeRestore: icons.RestoreIcon,
  nodeRead: icons.NodeReadToolIcon,
  nodeSearch: icons.NodeSearchToolIcon,
  webSearch: icons.WebSearchToolIcon,
  webFetch: icons.WebFetchToolIcon,
  skill: icons.SkillIcon,
  question: icons.QuestionToolIcon,
  history: icons.OutlineUndoStackToolIcon,
  mcp: icons.McpToolIcon,
  unknown: icons.GenericToolIcon,
  agent: icons.AgentIcon,
} as const;

describe('tool-row glyph semantics', () => {
  test('every tool a row can show resolves to a distinct glyph', () => {
    const byGlyph = new Map<unknown, string[]>();
    for (const [name, glyph] of Object.entries(TOOL_GLYPHS)) {
      byGlyph.set(glyph, [...(byGlyph.get(glyph) ?? []), name]);
    }
    const shared = [...byGlyph.values()].filter((names) => names.length > 1);
    expect(shared).toEqual([]);
  });

  test('a connected MCP tool does not wear the unknown-tool glyph', () => {
    // These two co-occur in one transcript: an integration that worked and a
    // call we could not map must not look the same.
    expect(TOOL_GLYPHS.mcp).not.toBe(TOOL_GLYPHS.unknown);
  });

  test('creating and deleting are not one stroke apart', () => {
    // FilePlus2 vs FileMinus differed by a single horizontal stroke at 14px,
    // for two actions where one is destructive.
    expect(TOOL_GLYPHS.fileDelete).not.toBe(TOOL_GLYPHS.fileCreate);
    expect(displayName(TOOL_GLYPHS.fileDelete)).not.toMatch(/Minus/);
    expect(displayName(TOOL_GLYPHS.nodeDelete)).not.toMatch(/Minus/);
  });

  test('fetching a page is not drawn as a document', () => {
    // ScrollText read as "a document", contradicting the row's own
    // "Fetched <url>" wording and echoing the file-read glyph.
    expect(TOOL_GLYPHS.webFetch).not.toBe(TOOL_GLYPHS.fileRead);
    expect(displayName(TOOL_GLYPHS.webFetch)).toMatch(/Download|Globe|Link|Cloud/);
  });
});

function displayName(glyph: unknown): string {
  const named = glyph as { displayName?: string; name?: string };
  return named.displayName ?? named.name ?? '';
}
