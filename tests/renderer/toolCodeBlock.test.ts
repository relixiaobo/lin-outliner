import { describe, expect, test } from 'bun:test';
import { toolPathRanges } from '../../src/renderer/agent/components/ToolCodeBlock';

describe('tool code block file paths', () => {
  test('resolves JSON path fields against the Thread working directory', () => {
    const code = JSON.stringify({
      file_path: 'src/main.ts',
      paths: ['./docs/spec.md', '../shared/types.ts'],
      url: 'https://example.com/docs/file.ts',
    }, null, 2);
    const ranges = toolPathRanges(code, 'json', '/workspace/project');

    expect(pathRanges(code, ranges)).toEqual([
      { text: 'src/main.ts', path: '/workspace/project/src/main.ts' },
      { text: './docs/spec.md', path: '/workspace/project/docs/spec.md' },
      { text: '../shared/types.ts', path: '/workspace/shared/types.ts' },
    ]);
  });

  test('links absolute and relative output paths while leaving URLs and labels alone', () => {
    const code = 'Changed /workspace/project/src/app.ts:42 and tests/app.test.ts. See https://example.com/src/app.ts and owner/repo.';
    const ranges = toolPathRanges(code, 'text', '/workspace/project');

    expect(pathRanges(code, ranges)).toEqual([
      { text: '/workspace/project/src/app.ts:42', path: '/workspace/project/src/app.ts' },
      { text: 'tests/app.test.ts', path: '/workspace/project/tests/app.test.ts' },
    ]);
  });

  test('resolves home-relative paths from a macOS Thread working directory', () => {
    const code = '{"path":"~/Desktop/report.pdf"}';
    const ranges = toolPathRanges(code, 'json', '/Users/dev/project');
    expect(pathRanges(code, ranges)).toEqual([
      { text: '~/Desktop/report.pdf', path: '/Users/dev/Desktop/report.pdf' },
    ]);
  });

  test('keeps glob patterns as code while linking the concrete search root', () => {
    const code = JSON.stringify({
      pattern: '**/A Brief History of Intelligence*.epub',
      path: '/Users/dev/Library',
    }, null, 2);
    const ranges = toolPathRanges(code, 'json', '/Users/dev/project');

    expect(pathRanges(code, ranges)).toEqual([
      { text: '/Users/dev/Library', path: '/Users/dev/Library' },
    ]);
  });

  test('keeps bracket and brace names navigable in declared path fields', () => {
    const code = JSON.stringify({
      file_path: 'src/app/[slug]/page.tsx',
      paths: ['reports/Report [final].md', 'fixtures/{draft}/data.json'],
      pattern: 'src/app/[slug]/*.tsx',
    }, null, 2);
    const ranges = toolPathRanges(code, 'json', '/workspace/project');

    expect(pathRanges(code, ranges)).toEqual([
      { text: 'src/app/[slug]/page.tsx', path: '/workspace/project/src/app/[slug]/page.tsx' },
      { text: 'reports/Report [final].md', path: '/workspace/project/reports/Report [final].md' },
      { text: 'fixtures/{draft}/data.json', path: '/workspace/project/fixtures/{draft}/data.json' },
    ]);
  });

  test('decorates the original encoded JSON text without rewriting it', () => {
    const code = '{"path":"C:\\\\Users\\\\dev\\\\report.md"}';
    const ranges = toolPathRanges(code, 'json', '/workspace/project');

    expect(pathRanges(code, ranges)).toEqual([
      { text: 'C:\\\\Users\\\\dev\\\\report.md', path: 'C:\\Users\\dev\\report.md' },
    ]);
  });
});

function pathRanges(code: string, ranges: ReturnType<typeof toolPathRanges>) {
  return ranges.map((range) => ({ text: code.slice(range.start, range.end), path: range.path }));
}
