import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

function listenerCount(source: string, eventName: 'error' | 'unhandledrejection'): number {
  const pattern = new RegExp(`window\\.addEventListener\\(\\s*['"]${eventName}['"]`, 'g');
  return [...source.matchAll(pattern)].length;
}

describe('renderer diagnostics capture seam', () => {
  test('normal renderer startup uses the preload diagnostics listeners only once', () => {
    const preload = readFileSync('src/preload/index.ts', 'utf8');
    const rendererMain = readFileSync('src/renderer/main.tsx', 'utf8');

    expect(listenerCount(preload, 'error')).toBe(1);
    expect(listenerCount(preload, 'unhandledrejection')).toBe(1);
    expect(preload).toContain('LIN_REPORT_RENDERER_ERROR_CHANNEL');
    expect(rendererMain).not.toContain('installRendererDiagnostics');
  });
});
