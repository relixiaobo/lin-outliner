import { describe, expect, test } from 'bun:test';
import {
  formatFileReferenceMarker,
  sanitizeFileReferenceRef,
  splitFileReferenceMarkers,
} from '../../src/core/agentFileReferenceMarkup';

describe('agent file reference markup', () => {
  test('formats and splits positional file references', () => {
    const marker = formatFileReferenceMarker('report.pdf');
    expect(marker).toBe('[[file:report.pdf]]');
    expect(splitFileReferenceMarkers(`Compare ${marker} with [[file:notes.md]].`)).toEqual([
      { type: 'text', text: 'Compare ' },
      { type: 'file', raw: '[[file:report.pdf]]', ref: 'report.pdf' },
      { type: 'text', text: ' with ' },
      { type: 'file', raw: '[[file:notes.md]]', ref: 'notes.md' },
      { type: 'text', text: '.' },
    ]);
  });

  test('sanitizes refs so markers stay single-line and unambiguous', () => {
    expect(sanitizeFileReferenceRef(' bad\n[file]  name ')).toBe('bad file name');
    expect(formatFileReferenceMarker('')).toBe('[[file:attachment]]');
  });
});
