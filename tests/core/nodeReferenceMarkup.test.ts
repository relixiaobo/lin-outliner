import { describe, expect, test } from 'bun:test';
import {
  formatNodeReferenceIdMarker,
  formatNodeReferenceMarker,
  nodeReferenceMarkersToText,
  parseNodeReferenceMarkers,
  splitNodeReferenceMarkers,
} from '../../src/core/nodeReferenceMarkup';

describe('node reference markup', () => {
  test('formats labels as inline reference markers', () => {
    expect(formatNodeReferenceMarker('Alpha', 'node-alpha')).toBe('[[Alpha^node-alpha]]');
    expect(formatNodeReferenceMarker('Alpha\nBeta^Gamma', 'node-alpha')).toBe('[[Alpha Beta Gamma^node-alpha]]');
    expect(formatNodeReferenceIdMarker('node-alpha')).toBe('[[^node-alpha]]');
  });

  test('parses and splits text around reference markers', () => {
    expect(parseNodeReferenceMarkers('See [[Alpha^node-alpha]] and [[^node-beta]] now')).toEqual([
      {
        end: 24,
        label: 'Alpha',
        nodeId: 'node-alpha',
        raw: '[[Alpha^node-alpha]]',
        start: 4,
      },
      {
        end: 43,
        label: '',
        nodeId: 'node-beta',
        raw: '[[^node-beta]]',
        start: 29,
      },
    ]);
    expect(splitNodeReferenceMarkers('See [[Alpha^node-alpha]] and [[^node-beta]] now')).toEqual([
      { text: 'See ', type: 'text' },
      { label: 'Alpha', nodeId: 'node-alpha', raw: '[[Alpha^node-alpha]]', type: 'nodeReference' },
      { text: ' and ', type: 'text' },
      { label: '', nodeId: 'node-beta', raw: '[[^node-beta]]', type: 'nodeReference' },
      { text: ' now', type: 'text' },
    ]);
  });

  test('converts reference markers to display text without node ids', () => {
    expect(nodeReferenceMarkersToText('Ask [[Alpha^node-alpha]] now')).toBe('Ask Alpha now');
    expect(nodeReferenceMarkersToText('Ask [[^node-alpha]] now')).toBe('Ask  now');
    expect(nodeReferenceMarkersToText('[[你好^node:abcd-1234]] 你好')).toBe('你好 你好');
  });
});
