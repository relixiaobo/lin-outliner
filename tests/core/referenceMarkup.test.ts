import { describe, expect, test } from 'bun:test';
import {
  formatChatSourceReferenceMarker,
  formatFileReferenceMarker,
  formatNodeReferenceIdMarker,
  formatNodeReferenceMarker,
  nodeReferenceMarkersToText,
  parseNodeReferenceMarkers,
  parseReferenceMarkers,
  referenceMarkupToRichText,
  rewriteFileReferenceMarkerPaths,
  richTextToReferenceMarkup,
  sanitizeFileReferenceRef,
  splitChatSourceReferenceMarkers,
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
    expect(nodeReferenceMarkersToText('[[node:你好^abcd-1234]] 你好')).toBe('你好 你好');
    expect(nodeReferenceMarkersToText('Open [[file:report.pdf^%2FUsers%2Fme%2Freport.pdf]]')).toBe('Open report.pdf');
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

  test('preserves local directory entry kind in file reference markers', () => {
    const path = '/Users/me/Projects';
    const marker = formatFileReferenceMarker('Projects', path, 'directory');
    expect(marker).toBe('[[file:Projects^%2FUsers%2Fme%2FProjects^directory]]');
    expect(splitFileReferenceMarkers(marker)).toEqual([{
      type: 'file',
      raw: marker,
      ref: 'Projects',
      label: 'Projects',
      path,
      entryKind: 'directory',
    }]);
    expect(splitFileReferenceMarkers('[[file:report.pdf^%2FUsers%2Fme%2Freport.pdf^file]]')[0]).toMatchObject({
      type: 'file',
      path: '/Users/me/report.pdf',
      entryKind: 'file',
    });
  });

  test('leaves unknown prefixes and legacy bare markers as text', () => {
    const text = 'Keep [[asset:Logo^asset-1]] and [[Alpha^node-alpha]] plain';
    expect(parseReferenceMarkers(text)).toEqual([]);
    expect(splitNodeReferenceMarkers(text)).toEqual([{ type: 'text', text }]);
  });

  test('keeps raw values when percent decoding fails', () => {
    expect(parseReferenceMarkers('Open [[file:bad percent^/Users/me/100% done.txt]]')).toEqual([{
      end: 49,
      label: 'bad percent',
      raw: '[[file:bad percent^/Users/me/100% done.txt]]',
      start: 5,
      target: { kind: 'local-file', path: '/Users/me/100% done.txt', entryKind: 'file' },
    }]);
  });

  test('preserves whitespace inside encoded paths', () => {
    const path = '/Users/me/ report .txt ';
    const marker = formatFileReferenceMarker('report', path);
    expect(marker).toBe('[[file:report^%2FUsers%2Fme%2F%20report%20.txt%20]]');
    expect(splitFileReferenceMarkers(marker)).toEqual([{
      type: 'file',
      raw: marker,
      ref: 'report',
      label: 'report',
      path,
      entryKind: 'file',
    }]);
  });

  test('formats and parses chat source reference markers', () => {
    const target = {
      kind: 'chat-source',
      stream: 'conversation',
      streamId: 'lin-agent:1@branch',
      range: {
        fromSeqExclusive: 12,
        throughSeq: 18,
        throughEventId: 'event:18@tail',
      },
    } as const;
    const marker = formatChatSourceReferenceMarker('source chat', target);

    expect(marker).toBe('[[chat:source chat^conversation:lin-agent%3A1%40branch@12-18:event%3A18%40tail]]');
    expect(parseReferenceMarkers(`See ${marker}`)).toEqual([{
      end: 84,
      label: 'source chat',
      raw: marker,
      start: 4,
      target,
    }]);
    expect(splitChatSourceReferenceMarkers(`See ${marker} now`)).toEqual([
      { type: 'text', text: 'See ' },
      { type: 'chat', raw: marker, ref: 'source chat', label: 'source chat', target },
      { type: 'text', text: ' now' },
    ]);
  });

  test('formats and parses date-clamped chat source reference markers', () => {
    const target = {
      kind: 'chat-source',
      stream: 'conversation',
      streamId: 'lin-agent-1',
      range: {
        fromSeqExclusive: 12,
        throughSeq: 18,
        throughEventId: 'event-18',
        fromCreatedAtInclusive: 1_800_000_000_000,
        throughCreatedAtExclusive: 1_800_086_400_000,
      },
    } as const;
    const marker = formatChatSourceReferenceMarker('source chat', target);

    expect(marker).toBe('[[chat:source chat^conversation:lin-agent-1@12-18:event-18~1800000000000-1800086400000]]');
    expect(parseReferenceMarkers(marker)).toEqual([{
      end: marker.length,
      label: 'source chat',
      raw: marker,
      start: 0,
      target,
    }]);
  });

  test('keeps legacy chat event ids that contain a tilde', () => {
    const marker = '[[chat:source chat^conversation:lin-agent-1@12-18:event~18]]';

    expect(parseReferenceMarkers(marker)).toEqual([{
      end: marker.length,
      label: 'source chat',
      raw: marker,
      start: 0,
      target: {
        kind: 'chat-source',
        stream: 'conversation',
        streamId: 'lin-agent-1',
        range: {
          fromSeqExclusive: 12,
          throughSeq: 18,
          throughEventId: 'event~18',
        },
      },
    }]);
  });

  test('encodes chat event id tildes so created-at clamps stay unambiguous', () => {
    const target = {
      kind: 'chat-source',
      stream: 'conversation',
      streamId: 'lin-agent-1',
      range: {
        fromSeqExclusive: 12,
        throughSeq: 18,
        throughEventId: 'event~18-19',
      },
    } as const;
    const marker = formatChatSourceReferenceMarker('source chat', target);

    expect(marker).toBe('[[chat:source chat^conversation:lin-agent-1@12-18:event%7E18-19]]');
    expect(parseReferenceMarkers(marker)[0]?.target).toEqual(target);
  });

  test('does not treat a legacy chat event id suffix as a created-at clamp', () => {
    const marker = '[[chat:source chat^conversation:lin-agent-1@12-18:event~18-19]]';

    expect(parseReferenceMarkers(marker)).toEqual([{
      end: marker.length,
      label: 'source chat',
      raw: marker,
      start: 0,
      target: {
        kind: 'chat-source',
        stream: 'conversation',
        streamId: 'lin-agent-1',
        range: {
          fromSeqExclusive: 12,
          throughSeq: 18,
          throughEventId: 'event~18-19',
        },
      },
    }]);
  });

  test('does not parse labels containing raw square brackets', () => {
    const text = 'Keep [[node:[Alpha^node-alpha]] plain';
    expect(parseReferenceMarkers(text)).toEqual([]);
    expect(splitNodeReferenceMarkers(text)).toEqual([{ type: 'text', text }]);
  });

  test('sanitizes labels so markers stay single-line', () => {
    expect(sanitizeFileReferenceRef(' bad\n[file]  name ')).toBe('bad file name');
    expect(formatFileReferenceMarker('', '')).toBe('[[file:attachment^attachment]]');
  });

  test('rewrites only local file reference marker paths', () => {
    const original = '/Users/me/report.pdf';
    const materialized = '/workspace/tmp/agent-attachments/report.pdf';
    const text = `Read ${formatFileReferenceMarker('report.pdf', original)} for [[node:Alpha^node-alpha]].`;

    expect(rewriteFileReferenceMarkerPaths(text, new Map([[original, materialized]]))).toBe(
      `Read ${formatFileReferenceMarker('report.pdf', materialized)} for [[node:Alpha^node-alpha]].`,
    );
  });

  test('serializes rich text inline refs as reference markers', () => {
    const chatSource = {
      kind: 'chat-source' as const,
      stream: 'conversation' as const,
      streamId: 'lin-agent-1',
      range: { fromSeqExclusive: 1, throughSeq: 2, throughEventId: 'event-2' },
    };
    expect(richTextToReferenceMarkup({
      text: 'Review  then  .',
      inlineRefs: [{
        offset: 7,
        target: { kind: 'local-file', path: '/Users/me/report.pdf', entryKind: 'file' },
        displayName: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
      }, {
        offset: 13,
        target: { kind: 'node', nodeId: 'node-alpha' },
        displayName: 'Alpha',
      }, {
        offset: 14,
        target: chatSource,
        displayName: 'source',
      }],
    })).toBe(
      `Review ${formatFileReferenceMarker('report.pdf', '/Users/me/report.pdf')} then [[node:Alpha^node-alpha]] ${formatChatSourceReferenceMarker('source', chatSource)}.`,
    );
  });

  test('deserializes reference markup into rich text inline refs', () => {
    const fileMarker = formatFileReferenceMarker('report.pdf', '/Users/me/report.pdf');
    const chatSource = {
      kind: 'chat-source',
      stream: 'run',
      streamId: 'run-1',
      range: { fromSeqExclusive: 3, throughSeq: 5 },
    } as const;
    const chatMarker = formatChatSourceReferenceMarker('run source', chatSource);

    expect(referenceMarkupToRichText(`Read ${fileMarker} and ${chatMarker}.`)).toEqual({
      text: 'Read  and .',
      marks: [],
      inlineRefs: [{
        offset: 5,
        target: { kind: 'local-file', path: '/Users/me/report.pdf', entryKind: 'file' },
        displayName: 'report.pdf',
      }, {
        offset: 10,
        target: chatSource,
        displayName: 'run source',
      }],
    });
  });
});
