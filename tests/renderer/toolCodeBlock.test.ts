import { describe, expect, test } from 'bun:test';
import { toolTextSegments } from '../../src/renderer/agent/components/ToolCodeBlock';

describe('tool code block file paths', () => {
  test('resolves JSON path fields against the Thread working directory', () => {
    const segments = toolTextSegments(JSON.stringify({
      file_path: 'src/main.ts',
      paths: ['./docs/spec.md', '../shared/types.ts'],
      url: 'https://example.com/docs/file.ts',
    }, null, 2), 'json', '/workspace/project');

    expect(fileSegments(segments)).toEqual([
      { text: 'src/main.ts', path: '/workspace/project/src/main.ts' },
      { text: './docs/spec.md', path: '/workspace/project/docs/spec.md' },
      { text: '../shared/types.ts', path: '/workspace/shared/types.ts' },
    ]);
  });

  test('links absolute and relative output paths while leaving URLs and labels alone', () => {
    const segments = toolTextSegments(
      'Changed /workspace/project/src/app.ts:42 and tests/app.test.ts. See https://example.com/src/app.ts and owner/repo.',
      'text',
      '/workspace/project',
    );

    expect(fileSegments(segments)).toEqual([
      { text: '/workspace/project/src/app.ts:42', path: '/workspace/project/src/app.ts' },
      { text: 'tests/app.test.ts', path: '/workspace/project/tests/app.test.ts' },
    ]);
  });

  test('resolves home-relative paths from a macOS Thread working directory', () => {
    const segments = toolTextSegments('{"path":"~/Desktop/report.pdf"}', 'json', '/Users/dev/project');
    expect(fileSegments(segments)).toEqual([
      { text: '~/Desktop/report.pdf', path: '/Users/dev/Desktop/report.pdf' },
    ]);
  });
});

function fileSegments(segments: ReturnType<typeof toolTextSegments>) {
  return segments.flatMap((segment) => segment.type === 'file'
    ? [{ text: segment.text, path: segment.path }]
    : []);
}
