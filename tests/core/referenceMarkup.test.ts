import { describe, expect, test } from 'bun:test';
import {
  formatFileReferenceMarker,
  formatNodeReferenceIdMarker,
  formatNodeReferenceMarker,
  nodeReferenceMarkersToText,
  parseNodeReferenceMarkers,
  parseReferenceMarkers,
  sanitizeFileReferenceRef,
  splitFileReferenceMarkers,
  splitNodeReferenceMarkers,
} from '../../src/core/referenceMarkup';

describe('reference markup', () => {
  test('formats prefixed node reference markers', () => {
    expect(formatNodeReferenceMarker('Alpha', 'node-alpha')).toBe('[[node:Alpha^node-alpha]]');
    expect(formatNodeReferenceMarker('Alpha\nBeta^Gamma', 'node-alpha')).toBe('[[node:Alpha Beta Gamma^node-alpha]]');
    expect(formatNodeReferenceIdMarker('node-alpha')).toBe('[[node:^node-alpha]]');
  });

  test('parses and splits node reference markers', () => {
    expect(parseNodeReferenceMarkers('See [[node:Alpha^node-alpha]] and [[node:^node-beta]] now')).toEqual([
      {
        end: 29,
        label: 'Alpha',
        nodeId: 'node-alpha',
        raw: '[[node:Alpha^node-alpha]]',
        start: 4,
      },
      {
        end: 53,
        label: '',
        nodeId: 'node-beta',
        raw: '[[node:^node-beta]]',
        start: 34,
      },
    ]);
    expect(splitNodeReferenceMarkers('See [[node:Alpha^node-alpha]] and [[node:^node-beta]] now')).toEqual([
      { text: 'See ', type: 'text' },
      { label: 'Alpha', nodeId: 'node-alpha', raw: '[[node:Alpha^node-alpha]]', type: 'nodeReference' },
      { text: ' and ', type: 'text' },
      { label: '', nodeId: 'node-beta', raw: '[[node:^node-beta]]', type: 'nodeReference' },
      { text: ' now', type: 'text' },
    ]);
  });

  test('converts node reference markers to display text without node ids', () => {
    expect(nodeReferenceMarkersToText('Ask [[node:Alpha^node-alpha]] now')).toBe('Ask Alpha now');
    expect(nodeReferenceMarkersToText('Ask [[node:^node-alpha]] now')).toBe('Ask  now');
    expect(nodeReferenceMarkersToText('[[node:你好^node%3Aabcd-1234]] 你好')).toBe('你好 你好');
  });

  test('formats and splits local file references with encoded paths', () => {
    const path = '/Users/me/Design ^ notes/[draft]\nreport.pdf';
    const marker = formatFileReferenceMarker('report.pdf', path);
    expect(marker).toBe('[[file:report.pdf^%2FUsers%2Fme%2FDesign%20%5E%20notes%2F%5Bdraft%5D%0Areport.pdf]]');
    expect(splitFileReferenceMarkers(`Compare ${marker}.`)).toEqual([
      { type: 'text', text: 'Compare ' },
      {
        type: 'file',
        raw: marker,
        ref: 'report.pdf',
        label: 'report.pdf',
        path,
        entryKind: 'file',
      },
      { type: 'text', text: '.' },
    ]);
  });

  test('leaves unknown prefixes and legacy bare markers as text', () => {
    const text = 'Keep [[asset:Logo^asset-1]] and [[Alpha^node-alpha]] plain';
    expect(parseReferenceMarkers(text)).toEqual([]);
    expect(splitNodeReferenceMarkers(text)).toEqual([{ type: 'text', text }]);
  });

  test('sanitizes labels so markers stay single-line', () => {
    expect(sanitizeFileReferenceRef(' bad\n[file]  name ')).toBe('bad file name');
    expect(formatFileReferenceMarker('', '')).toBe('[[file:attachment^attachment]]');
  });
});
