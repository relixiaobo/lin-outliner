import { describe, expect, test } from 'bun:test';
import { renderedMarkdownNodeReferenceIds } from '../../src/core/markdownNodeReferences';
import { PUBLIC_REFERENCE_NODE_IDS } from '../../src/core/nodeId';
import {
  formatFileReferenceMarker,
  formatFileReferenceUri,
  formatNamedNodeReference,
  formatNodeReferenceMarker,
  formatNodeReferenceUri,
  nodeReferenceMarkersToText,
  parseFileReferenceUri,
  parseNodeReferenceMarkers,
  parseReferenceMarkers,
  parseReferenceUri,
  referenceMarkupToRichText,
  rewriteFileReferenceMarkerPaths,
  richTextToReferenceMarkup,
  splitFileReferenceMarkers,
  splitNodeReferenceMarkers,
} from '../../src/core/referenceMarkup';

const NODE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const NODE_ID = `node:${NODE_UUID}`;
const SECOND_UUID = '6ba7b810-9dad-4d80-b4f0-21cf460d5c2f';
const SECOND_NODE_ID = `node:${SECOND_UUID}`;

describe('reference URI markup', () => {
  test('formats canonical Node UUID and public system Node markers without labels', () => {
    expect(formatNodeReferenceUri(NODE_ID)).toBe(`node://${NODE_UUID}`);
    expect(formatNodeReferenceMarker(NODE_ID)).toBe(`[[node://${NODE_UUID}]]`);
    for (const nodeId of PUBLIC_REFERENCE_NODE_IDS) {
      expect(formatNodeReferenceMarker(nodeId)).toBe(`[[node://${nodeId}]]`);
      expect(parseNodeReferenceMarkers(`[[node://${nodeId}]]`)[0]?.nodeId).toBe(nodeId);
    }
    expect(formatNodeReferenceMarker(`node:${NODE_UUID.toUpperCase()}`)).toBe(`[[node://${NODE_UUID}]]`);
  });

  test('rejects private and malformed Node identities instead of guessing aliases', () => {
    for (const nodeId of [
      'trash',
      'recents',
      'tag:day',
      'tag:550e8400-e29b-41d4-a716-446655440000',
      'field:550e8400-e29b-41d4-a716-446655440000',
      'schema:field-types',
      'sys:name',
      'node:not-a-uuid',
      'node:550e8400-e29b-11d4-a716-446655440000',
    ]) {
      expect(formatNodeReferenceUri(nodeId)).toBeNull();
      expect(formatNodeReferenceMarker(nodeId)).toBe(nodeId);
    }
    expect(formatNamedNodeReference(
      'date:550e8400-e29b-41d4-a716-446655440000',
      'Today',
      { unavailable: 'display' },
    ))
      .toBe('Today');
    for (const uri of [
      `node://node%3A${NODE_UUID}`,
      `node:///${NODE_UUID}`,
      `node://${NODE_UUID}/`,
      `node://user@${NODE_UUID}`,
      `node://${NODE_UUID}?query=1`,
      `node://${NODE_UUID}#fragment`,
      'node://trash',
      'node://unknown-system-node',
      'thread://01951d6e-7c25-7c31-8d62-313038616239',
      'asset://abc123',
      'preview-local://abc123',
    ]) {
      expect(parseReferenceUri(uri)).toBeNull();
    }
  });

  test('parses, canonicalizes, and splits Node references under explicit scheme admission', () => {
    const upper = `NODE://${NODE_UUID.toUpperCase()}`;
    expect(parseReferenceUri(upper)).toEqual({ scheme: 'node', nodeId: NODE_ID });
    const text = `See [[${upper}]] and [[node://${SECOND_UUID}]] now`;
    const markers = parseNodeReferenceMarkers(text);
    expect(markers.map(({ nodeId, uri }) => ({ nodeId, uri }))).toEqual([
      { nodeId: NODE_ID, uri: `node://${NODE_UUID}` },
      { nodeId: SECOND_NODE_ID, uri: `node://${SECOND_UUID}` },
    ]);
    expect(markers.map((marker) => marker.raw)).toEqual([
      `[[${upper}]]`,
      `[[node://${SECOND_UUID}]]`,
    ]);
    expect(splitNodeReferenceMarkers(`[[node://${NODE_UUID}]] / [[file:///tmp/a.txt]]`)).toEqual([
      {
        nodeId: NODE_ID,
        raw: `[[node://${NODE_UUID}]]`,
        type: 'nodeReference',
        uri: `node://${NODE_UUID}`,
      },
      { text: ' / [[file:///tmp/a.txt]]', type: 'text' },
    ]);
    expect(parseReferenceUri(`node://${NODE_UUID}`, ['file'])).toBeNull();
  });

  test('formats standard absolute file URLs with canonical percent encoding', () => {
    const path = '/Users/me/Quarterly ] # ? % 你好.pptx';
    const uri = 'file:///Users/me/Quarterly%20%5D%20%23%20%3F%20%25%20%E4%BD%A0%E5%A5%BD.pptx';
    expect(formatFileReferenceUri(path)).toBe(uri);
    expect(formatFileReferenceMarker(path)).toBe(`[[${uri}]]`);
    expect(parseFileReferenceUri(uri)).toEqual({ scheme: 'file', entryKind: 'file', path });
    expect(parseReferenceUri('file:///Users/me/你好.pptx')).toEqual({
      scheme: 'file',
      entryKind: 'file',
      path: '/Users/me/你好.pptx',
    });
  });

  test('uses a trailing slash as directory intent and preserves root', () => {
    expect(formatFileReferenceUri('/Users/me/Projects', 'directory')).toBe('file:///Users/me/Projects/');
    expect(parseFileReferenceUri('file:///Users/me/Projects/')).toEqual({
      scheme: 'file',
      entryKind: 'directory',
      path: '/Users/me/Projects',
    });
    expect(parseFileReferenceUri('file:///')).toEqual({ scheme: 'file', entryKind: 'directory', path: '/' });
  });

  test('rejects relative, remote, credential, query, fragment, and malformed file locators', () => {
    expect(formatFileReferenceUri('relative/file.txt')).toBeNull();
    expect(formatFileReferenceMarker('relative/file.txt')).toBe('relative/file.txt');
    expect(formatFileReferenceUri('/tmp/invalid-\ud800.txt')).toBeNull();
    expect(formatFileReferenceMarker('/tmp/invalid-\ud800.txt')).toBe('/tmp/invalid-\ud800.txt');
    for (const uri of [
      'file:relative.txt',
      'file:/tmp/one.txt',
      'file://server/tmp/one.txt',
      'file://user@server/tmp/one.txt',
      'file:///tmp/one.txt?query=1',
      'file:///tmp/one.txt#fragment',
      'file:///tmp/100%.txt',
      'file:///tmp/a%2Fb.txt',
      'file://relative/old.txt',
    ]) {
      expect(parseFileReferenceUri(uri)).toBeNull();
    }
  });

  test('preserves escaped markers as literal text and scans adjacent markers once', () => {
    const nodeMarker = `[[node://${NODE_UUID}]]`;
    const fileMarker = '[[file:///tmp/a.txt]]';
    const text = `\\${nodeMarker} ${fileMarker}`;
    const markers = parseReferenceMarkers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      raw: fileMarker,
      target: { kind: 'local-file', path: '/tmp/a.txt', entryKind: 'file' },
      uri: 'file:///tmp/a.txt',
    });
    expect(parseReferenceMarkers(`\\\\${nodeMarker}`)).toHaveLength(1);
    expect(parseReferenceMarkers(`${nodeMarker}${fileMarker}`)).toHaveLength(2);
    expect(parseReferenceMarkers('Keep [[https://example.com]] and [[#tag]] plain')).toEqual([]);
  });

  test('finds only Node references rendered as Markdown affordances', () => {
    const marker = `[[node://${NODE_UUID}]]`;
    const markdown = [
      `Visible ${marker} and **${marker}**.`,
      `\`${marker}\``,
      '```text',
      marker,
      '```',
      `[Existing link](https://example.test/${marker} "${marker}")`,
      `[Existing ${marker}][reference-link]`,
      `![Image ${marker}](https://example.test/image.png "${marker}")`,
      `[reference-link]: https://example.test/${marker}`,
    ].join('\n\n');

    expect(renderedMarkdownNodeReferenceIds(markdown)).toEqual([NODE_ID, NODE_ID]);
    expect(renderedMarkdownNodeReferenceIds(`\\\\${marker}`)).toEqual([NODE_ID]);
    expect(renderedMarkdownNodeReferenceIds(`\\\\\\${marker}`)).toEqual([]);
    expect(renderedMarkdownNodeReferenceIds(`&#91;${marker.slice(1)} / \\${marker}`)).toEqual([NODE_ID]);
    expect(renderedMarkdownNodeReferenceIds(`&acE; ${marker}`)).toEqual([NODE_ID]);
  });

  test('derives display fallback independently from marker identity', () => {
    expect(nodeReferenceMarkersToText(`Ask [[node://${NODE_UUID}]] now`)).toBe('Ask 550e8400 now');
    expect(nodeReferenceMarkersToText('Open [[file:///Users/me/report.pdf]]')).toBe('Open report.pdf');
  });

  test('splits and rewrites local file references without serialized labels', () => {
    const marker = formatFileReferenceMarker('/Users/me/report.pdf');
    expect(splitFileReferenceMarkers(`Compare ${marker}.`)).toEqual([
      { type: 'text', text: 'Compare ' },
      {
        type: 'file',
        raw: marker,
        ref: 'report.pdf',
        path: '/Users/me/report.pdf',
        entryKind: 'file',
        uri: 'file:///Users/me/report.pdf',
      },
      { type: 'text', text: '.' },
    ]);
    expect(rewriteFileReferenceMarkerPaths(
      `Read ${marker}.`,
      new Map([['/Users/me/report.pdf', '/workspace/report.pdf']]),
    )).toBe('Read [[file:///workspace/report.pdf]].');
  });

  test('round-trips structured rich text without serializing display metadata', () => {
    const richText = {
      text: 'Review report.pdf then Alpha.',
      inlineRefs: [{
        offset: 7,
        target: { kind: 'local-file' as const, path: '/Users/me/report.pdf', entryKind: 'file' as const },
        displayName: 'report.pdf',
      }, {
        offset: 23,
        target: { kind: 'node' as const, nodeId: NODE_ID },
        displayName: 'Alpha',
      }],
    };
    expect(richTextToReferenceMarkup(richText)).toBe(
      `Review [[file:///Users/me/report.pdf]]report.pdf then [[node://${NODE_UUID}]]Alpha.`,
    );
    expect(referenceMarkupToRichText(`Read [[file:///Users/me/report.pdf]] and [[node://${NODE_UUID}]].`)).toEqual({
      text: 'Read  and .',
      marks: [],
      inlineRefs: [{
        offset: 5,
        target: { kind: 'local-file', path: '/Users/me/report.pdf', entryKind: 'file' },
      }, {
        offset: 10,
        target: { kind: 'node', nodeId: NODE_ID },
      }],
    });
  });

  test('degrades private structured Node references to display text without exposing internal ids', () => {
    expect(richTextToReferenceMarkup({
      text: '',
      inlineRefs: [{
        offset: 0,
        target: { kind: 'node', nodeId: 'date:550e8400-e29b-41d4-a716-446655440000' },
        displayName: 'Today',
      }],
    })).toBe('Today');
    expect(richTextToReferenceMarkup({
      text: 'Today',
      inlineRefs: [{
        offset: 0,
        target: { kind: 'node', nodeId: 'date:550e8400-e29b-41d4-a716-446655440000' },
        displayName: 'Today',
      }],
    })).toBe('Today');
  });
});
