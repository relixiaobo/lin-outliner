import { describe, expect, test } from 'bun:test';
import type { ItemExecutionStatus, ThreadItem } from '../../src/core/agent/protocol';
import type { NodeProjection } from '../../src/core/types';
import { en } from '../../src/core/i18n';
import {
  summarizeThreadToolActivity,
  summarizeThreadToolItem,
  threadToolItemSegments,
  type ThreadToolItem,
} from '../../src/renderer/agent/components/items/ThreadItemView';
import type { DocumentIndex } from '../../src/renderer/state/document';

/**
 * The exhaustive tool-copy table. Every tool a run can produce appears here with
 * its wording, so a copy change is reviewed as a diff of this table rather than
 * discovered in a transcript. Two rules it enforces:
 *
 *  1. No row shows a model-facing tool identifier where the tool is one we know.
 *  2. Terminal status is one idiom for every kind — `<act> · failed` — instead of
 *     six competing per-kind phrasings.
 */
const labels = en.agent.thread.activity;

function base(id: string) {
  return { id, provenance: { originThreadId: 't', originTurnId: 'u', originItemId: id } } as const;
}

function dynamic(
  tool: string,
  args: Record<string, unknown>,
  status: ItemExecutionStatus = 'completed',
  options: { readonly id?: string; readonly namespace?: string | null } = {},
): ThreadToolItem {
  return {
    ...base(options.id ?? `dynamic-${tool}`),
    type: 'dynamicToolCall',
    status,
    outputRef: null,
    namespace: options.namespace ?? null,
    tool,
    arguments: args as never,
    contentItems: null,
    success: status === 'failed' ? false : true,
    durationMs: 1,
  };
}

function shell(
  command: string,
  status: ItemExecutionStatus = 'completed',
  id = 'command-1',
  description: string | null = null,
  cwd = '/w',
): ThreadToolItem {
  return {
    ...base(id),
    type: 'commandExecution',
    status,
    outputRef: null,
    command,
    description,
    cwd,
    processId: null,
    commandActions: [],
    aggregatedOutput: null,
    exitCode: status === 'failed' ? 2 : 0,
    durationMs: 1,
  };
}

function collab(
  tool: string,
  status: ItemExecutionStatus = 'completed',
  receiver = 'r1',
): ThreadToolItem {
  return {
    ...base(`collab-${tool}`),
    type: 'collabAgentToolCall',
    status,
    outputRef: null,
    tool: tool as never,
    senderThreadId: 't',
    receiverThreadIds: [receiver],
    prompt: null,
    model: null,
    reasoningEffort: null,
    agentsStates: {},
  };
}

function changes(...paths: readonly string[]): ThreadToolItem {
  return {
    ...base('file-change'),
    type: 'fileChange',
    status: 'completed',
    outputRef: null,
    changes: paths.map((path) => ({ path, kind: 'update' as const })),
  };
}

function nodeIndex(): DocumentIndex {
  const nodes = [titled('node-a', 'Chapter Three'), titled('node-b', 'Appendix')];
  return {
    projection: { nodes } as never,
    byId: new Map(nodes.map((entry) => [entry.id, entry])),
  } as DocumentIndex;
}

function titled(id: string, text: string): NodeProjection {
  return {
    id,
    children: [],
    content: { text, marks: [], inlineRefs: [] },
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    locked: false,
    autoCollected: false,
  } as NodeProjection;
}

describe('every built-in tool says what it did, not which API was called', () => {
  const cases: ReadonlyArray<readonly [string, ThreadToolItem, string]> = [
    ['file_write', dynamic('file_write', { file_path: '/w/src/out.md' }), 'Created out.md'],
    ['file_edit', dynamic('file_edit', { file_path: '/w/ThreadItemView.tsx' }), 'Edited ThreadItemView.tsx'],
    ['file_delete', dynamic('file_delete', { file_path: '/w/tmp/old.log' }), 'Deleted old.log'],
    ['file_read', dynamic('file_read', { file_path: '/w/OEBPS/intro.xhtml' }), 'Read intro.xhtml'],
    ['file_read via path', dynamic('file_read', { path: '/w/notes.md' }), 'Read notes.md'],
    ['file_glob', dynamic('file_glob', { pattern: '**/*.epub' }), 'Searched for "**/*.epub"'],
    ['file_grep', dynamic('file_grep', { pattern: 'TODO' }), 'Searched for "TODO"'],
    ['node_edit', dynamic('node_edit', { node_id: 'node-a' }), 'Edited "node-a"'],
    ['node_delete', dynamic('node_delete', { node_id: 'node-a' }), 'Deleted "node-a"'],
    ['node_delete restore', dynamic('node_delete', { node_id: 'node-a', restore: true }), 'Restored "node-a"'],
    ['node_read', dynamic('node_read', { node_id: 'node-a' }), 'Read "node-a"'],
    ['node_search', dynamic('node_search', { query: 'epub' }), 'Searched for "epub"'],
    ['web_search', dynamic('web_search', { query: 'epub parser' }), 'Searched the web for "epub parser"'],
    ['web_fetch', dynamic('web_fetch', { url: 'https://example.com/a' }), 'Fetched https://example.com/a'],
    ['skill', dynamic('skill', { skill: 'dataviz' }), 'Used the dataviz skill'],
    ['request_user_input', dynamic('request_user_input', { question: 'which?' }), 'Asked a question'],
    ['outline_undo_stack', dynamic('outline_undo_stack', {}), 'Checked history'],
    ['update_plan', dynamic('update_plan', { plan: [] }), 'Updated the plan'],
    ['command', shell('npm test'), 'Ran "npm test"'],
    ['file change', changes('/w/a.ts'), 'Changed a.ts'],
    ['file change, three', changes('/w/a.ts', '/w/b.ts', '/w/c.ts'), 'Changed a.ts, b.ts and 1 more'],
    ['web search item', {
      ...base('web-1'), type: 'webSearch', status: 'completed', outputRef: null,
      query: 'epub', results: [], error: null,
    }, 'Searched the web for "epub"'],
    ['spawn_agent', collab('spawn_agent'), 'Started an agent'],
    ['send_message', collab('send_message'), 'Messaged an agent'],
    ['followup_task', collab('followup_task'), 'Sent a follow-up task'],
    ['wait_agent', collab('wait_agent'), 'Waited for an agent'],
    ['list_agents', collab('list_agents'), 'Listed agents'],
    ['interrupt_agent', collab('interrupt_agent'), 'Interrupted an agent'],
  ];

  for (const [name, item, expected] of cases) {
    test(name, () => {
      expect(summarizeThreadToolItem(item, labels)).toBe(expected);
      // Nothing in the user-facing wording may be the raw tool identifier.
      // (`skill` is exempt: the identifier happens to be the English noun.)
      if (item.type === 'dynamicToolCall' && item.tool !== 'skill') {
        expect(expected).not.toContain(item.tool);
      }
      if (item.type === 'collabAgentToolCall') expect(expected).not.toContain(item.tool);
    });
  }
});

describe('a tool with no usable argument degrades to an honest generic', () => {
  const cases: ReadonlyArray<readonly [string, ThreadToolItem, string]> = [
    ['file_write', dynamic('file_write', {}), 'Created a file'],
    ['file_read', dynamic('file_read', {}), 'Read a file'],
    ['file_grep', dynamic('file_grep', {}), 'Searched files'],
    ['node_create names no parent', dynamic('node_create', { parent_id: 'node-a' }), 'Created a node'],
    ['node_read', dynamic('node_read', {}), 'Read a node'],
    ['skill', dynamic('skill', {}), 'Used a skill'],
  ];
  for (const [name, item, expected] of cases) {
    test(name, () => expect(summarizeThreadToolItem(item, labels)).toBe(expected));
  }

  test('an unmappable tool keeps its identifier, which is all we know', () => {
    expect(summarizeThreadToolItem(dynamic('mystery', {}, 'completed', { namespace: 'plugin' }), labels))
      .toBe('Used plugin.mystery');
    expect(summarizeThreadToolItem({
      ...base('mcp-1'), type: 'mcpToolCall', status: 'completed', outputRef: null,
      server: 'files', tool: 'read', arguments: {}, pluginId: null, result: null,
      error: null, durationMs: null,
    }, labels)).toBe('Used files.read');
  });
});

describe('a command row says what it does, not how the shell was invoked', () => {
  test('the caller description wins, so identical heredocs stop being identical', () => {
    const heredoc = "python3 - <<'PY'\nprint(1)\nPY";
    expect(summarizeThreadToolItem(shell(heredoc, 'completed', 'c-1', 'Inspect EPUB archive contents'), labels))
      .toBe('Inspect EPUB archive contents');
    expect(summarizeThreadToolItem(shell(heredoc, 'completed', 'c-2', 'Extract chapter titles'), labels))
      .toBe('Extract chapter titles');
    // Same shell text, two different rows — the defect from the reported run.
    expect(summarizeThreadToolItem(shell(heredoc, 'completed', 'c-1', 'Inspect EPUB archive contents'), labels))
      .not.toBe(summarizeThreadToolItem(shell(heredoc, 'completed', 'c-2', 'Extract chapter titles'), labels));
  });

  test('a described command still annotates its outcome', () => {
    expect(summarizeThreadToolItem(shell('false', 'failed', 'c-1', 'Check the build'), labels))
      .toBe('Check the build · failed');
  });

  test('without a description the fallback spends its budget on the operative text', () => {
    expect(summarizeThreadToolItem(shell('npm test'), labels)).toBe('Ran "npm test"');
    expect(summarizeThreadToolItem(shell("python3 - <<'PY'\nprint(1)\nPY"), labels))
      .toBe('Ran "python3 -"');
    expect(summarizeThreadToolItem(shell('cd /Users/x/.lin-outliner-codex-3/agent && swift build'), labels))
      .toBe('Ran "swift build"');
    expect(summarizeThreadToolItem(shell("cd '/tmp/with space' && ls -la"), labels))
      .toBe('Ran "ls -la"');
    // Paths under the Thread's own working directory render relative to it.
    expect(summarizeThreadToolItem(shell('/w/scripts/build.sh --release'), labels))
      .toBe('Ran "scripts/build.sh --release"');
  });
});

describe('status is one idiom across every tool kind', () => {
  const subjects: ReadonlyArray<readonly [string, (status: ItemExecutionStatus) => ThreadToolItem, string, string]> = [
    ['file_read', (s) => dynamic('file_read', { file_path: '/w/a.md' }, s), 'Read a.md', 'Reading a.md'],
    ['command', (s) => shell('npm test', s), 'Ran "npm test"', 'Running "npm test"'],
    ['file change', (s) => ({ ...changes('/w/a.ts'), status: s }), 'Changed a.ts', 'Changing a.ts'],
    ['spawn_agent', (s) => collab('spawn_agent', s), 'Started an agent', 'Starting an agent'],
    ['skill', (s) => dynamic('skill', { skill: 'dataviz' }, s), 'Used the dataviz skill', 'Using the dataviz skill'],
  ];

  for (const [name, make, past, present] of subjects) {
    test(name, () => {
      expect(summarizeThreadToolItem(make('completed'), labels)).toBe(past);
      expect(summarizeThreadToolItem(make('inProgress'), labels)).toBe(present);
      expect(summarizeThreadToolItem(make('failed'), labels)).toBe(`${past} · failed`);
      expect(summarizeThreadToolItem(make('interrupted'), labels)).toBe(`${past} · interrupted`);
    });
  }
});

describe('node subjects prefer the title over the id', () => {
  test('resolves through the document index, falling back to the id', () => {
    const index = nodeIndex();
    expect(summarizeThreadToolItem(dynamic('node_read', { node_id: 'node-a' }), labels, index))
      .toBe('Read "Chapter Three"');
    expect(summarizeThreadToolItem(dynamic('node_edit', { node_ids: ['node-a', 'node-b'] }), labels, index))
      .toBe('Edited "Chapter Three", "Appendix"');
    expect(summarizeThreadToolItem(dynamic('node_read', { node_id: 'node-missing' }), labels, index))
      .toBe('Read "node-missing"');
  });
});

describe('review regressions — each of these shipped broken once', () => {
  test('a search query is never resolved as if it were a node id', () => {
    // `'nodeSearch'.startsWith('node')` sent queries through title resolution,
    // so a query equal to a node uuid rendered as that node's title.
    const index = nodeIndex();
    expect(summarizeThreadToolItem(dynamic('node_search', { query: 'node-a' }), labels, index))
      .toBe('Searched for "node-a"');
  });

  test('a repeated subject is counted once, single row and group alike', () => {
    // The bucket Set deduped; the single-row path did not.
    expect(summarizeThreadToolItem(dynamic('node_read', { node_id: 'a', node_ids: ['a'] }), labels))
      .toBe('Read "a"');
    expect(summarizeThreadToolItem(dynamic('node_read', { node_ids: ['a', 'a', 'b'] }), labels))
      .toBe('Read "a", "b"');
  });

  test('a root working directory does not delete every slash in the command', () => {
    expect(summarizeThreadToolItem(shell('ls /usr/local/bin && cat /etc/hosts', 'completed', 'c', null, '/'), labels))
      .toBe('Ran "ls /usr/local/bin && cat /etc/hosts"');
  });

  test('bit shifts and here-strings are not mistaken for heredocs', () => {
    expect(summarizeThreadToolItem(shell("awk 'BEGIN{print 1<<20}' data.txt"), labels))
      .toBe('Ran "awk \'BEGIN{print 1<<20}\' data.txt"');
    expect(summarizeThreadToolItem(shell('grep foo <<< "$text"'), labels))
      .toBe('Ran "grep foo <<< \"$text\""');
    // A here-string whose word IS a valid delimiter: the delimiter match lands
    // on the second `<`, so a guard that only looks forward for `<<<` misses.
    expect(summarizeThreadToolItem(shell('cat <<< hello'), labels))
      .toBe('Ran "cat <<< hello"');
    expect(summarizeThreadToolItem(shell('x <<<word'), labels))
      .toBe('Ran "x <<<word"');
    // Genuine heredocs still collapse, in all three spellings.
    expect(summarizeThreadToolItem(shell("python3 - <<'PY'\nprint(1)\nPY"), labels))
      .toBe('Ran "python3 -"');
    expect(summarizeThreadToolItem(shell('cat <<EOF\nx\nEOF'), labels)).toBe('Ran "cat"');
    expect(summarizeThreadToolItem(shell('cat <<-EOF\nx\nEOF'), labels)).toBe('Ran "cat"');
  });

  test('the outcome is a segment of its own so it cannot be ellipsized away', () => {
    const segments = threadToolItemSegments(
      dynamic('file_edit', { file_path: '/w/config.json' }, 'failed'), labels,
    );
    expect(segments.map((segment) => segment.tone)).toEqual(['neutral', 'failed']);
    expect(segments[0]!.text).toBe('Edited config.json');
    expect(segments[1]!.text).toBe('failed');
  });

  test('the tooltip carries the full subject list the label elided', () => {
    const reads = ['a', 'b', 'c', 'd'].map((n) =>
      dynamic('file_read', { file_path: `/w/${n}.ts` }, 'completed', { id: `r-${n}` }));
    expect(summarizeThreadToolActivity(reads, labels)).toBe('Read a.ts, b.ts and 2 more');
    expect(summarizeThreadToolActivity(reads, labels, undefined, { subjectLimit: Number.POSITIVE_INFINITY }))
      .toBe('Read a.ts, b.ts, c.ts, d.ts');
  });
});

describe('group summaries name up to two subjects, then elide', () => {
  const read = (path: string, status: ItemExecutionStatus = 'completed') =>
    dynamic('file_read', { file_path: path }, status, { id: `read-${path}` });

  const cases: ReadonlyArray<readonly [string, readonly ThreadToolItem[], string]> = [
    ['two reads', [read('/w/a.xhtml'), read('/w/b.xhtml')], 'Read a.xhtml, b.xhtml'],
    ['six reads', ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => read(`/w/${n}.xhtml`)),
      'Read a.xhtml, b.xhtml and 4 more'],
    // P8: the finished half is past tense, the in-flight half is present — the
    // old bucket OR-ed `running` and reported the whole count as in progress.
    ['one still running', [read('/w/a.md'), read('/w/b.md', 'inProgress')],
      'Read a.md · reading b.md'],
    ['five done, one running', [
      ...['a', 'b', 'c', 'd', 'e'].map((n) => read(`/w/${n}.md`)),
      read('/w/f.md', 'inProgress'),
    ], 'Read a.md, b.md and 3 more · reading f.md'],
    ['unnameable split still counts each side', [
      dynamic('file_read', {}, 'completed', { id: 'u-1' }),
      dynamic('file_read', {}, 'completed', { id: 'u-2' }),
      dynamic('file_read', {}, 'inProgress', { id: 'u-3' }),
    ], 'Read 2 files · reading a file'],
    ['one failed', [read('/w/a.md'), read('/w/b.md'), read('/w/c.md', 'failed')],
      'Read a.md, b.md and 1 more · 1 failed'],
    ['mixed kinds', [
      read('/w/a.md'),
      dynamic('node_edit', { node_id: 'node-a' }, 'completed', { id: 'n-1' }),
      dynamic('skill', { skill: 'dataviz' }, 'completed', { id: 's-1' }),
    ], 'Read a.md · edited "node-a" · used the dataviz skill'],
    ['two skills fall back to a count', [
      dynamic('skill', { skill: 'dataviz' }, 'completed', { id: 's-1' }),
      dynamic('skill', { skill: 'run' }, 'completed', { id: 's-2' }),
    ], 'Used 2 skills'],
    ['two web searches keep both queries', [
      dynamic('web_search', { query: 'a' }, 'completed', { id: 'w-1' }),
      dynamic('web_search', { query: 'b' }, 'completed', { id: 'w-2' }),
    ], 'Searched the web for "a", "b"'],
    ['unnameable reads count instead', [
      dynamic('file_read', {}, 'completed', { id: 'u-1' }),
      dynamic('file_read', {}, 'completed', { id: 'u-2' }),
    ], 'Read 2 files'],
    ['a half-named bucket counts rather than mislead', [
      read('/w/a.md'),
      dynamic('file_read', {}, 'completed', { id: 'u-1' }),
    ], 'Read 2 files'],
    ['commands', [shell('ls', 'completed', 'c-1'), shell('pwd', 'completed', 'c-2')], 'Ran 2 commands'],
    // Repeated Plan updates collapse rather than stacking identical rows.
    ['repeated plan updates', [
      dynamic('update_plan', { plan: [] }, 'completed', { id: 'p-1' }),
      dynamic('update_plan', { plan: [] }, 'completed', { id: 'p-2' }),
      dynamic('update_plan', { plan: [] }, 'completed', { id: 'p-3' }),
    ], 'Updated the plan 3 times'],
    ['two agents', [collab('spawn_agent', 'completed', 'r1'), collab('wait_agent', 'completed', 'r2')],
      'Worked with 2 agents'],
    // Two calls aimed at the same agent are one agent worked with, not two.
    ['same agent twice', [collab('spawn_agent', 'completed', 'r1'), collab('wait_agent', 'completed', 'r1')],
      'Worked with an agent'],
  ];

  for (const [name, items, expected] of cases) {
    test(name, () => expect(summarizeThreadToolActivity(items, labels)).toBe(expected));
  }
});
