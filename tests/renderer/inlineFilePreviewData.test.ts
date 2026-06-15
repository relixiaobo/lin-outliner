import { describe, expect, test } from 'bun:test';
import {
  LOCAL_FILE_REFERENCE_LINK_PREFIX,
  localFileReferenceFromHref,
  localFileReferenceHref,
} from '../../src/renderer/ui/editor/inlineFilePreviewData';

// This href pair is the bridge an agent-emitted `[[file:Label^/path]]` marker
// crosses to become a clickable inline file chip: the markdown transform encodes
// the path as a `#lin-file:` href, and the `<a>` override decodes it back to open
// the file through the trusted-local-file gate. A drift here silently breaks the
// "agent surfaces a produced deliverable inline" capability, so the round-trip —
// especially for paths the encoding has to protect — is guarded directly.

describe('localFileReferenceHref ⇄ localFileReferenceFromHref', () => {
  test('a file path round-trips, entryKind defaulting to file', () => {
    const href = localFileReferenceHref('/work/report.pptx');
    expect(href.startsWith(`#${LOCAL_FILE_REFERENCE_LINK_PREFIX}`)).toBe(true);
    expect(localFileReferenceFromHref(href)).toEqual({ entryKind: 'file', path: '/work/report.pptx' });
  });

  test('a directory round-trips with its entryKind', () => {
    const href = localFileReferenceHref('/work/outputs', 'directory');
    expect(localFileReferenceFromHref(href)).toEqual({ entryKind: 'directory', path: '/work/outputs' });
  });

  test('a path with a colon, spaces, and unicode round-trips (percent-encoded before the separator scan)', () => {
    // The decode finds the entryKind/path separator via the FIRST ':' in the body;
    // it survives a ':' inside the path only because the path is percent-encoded.
    const path = '/work/My Report: 美国政府限制Fable5事件分析.pptx';
    expect(localFileReferenceFromHref(localFileReferenceHref(path))).toEqual({ entryKind: 'file', path });
  });

  test('a non-local-file href is not a file reference', () => {
    expect(localFileReferenceFromHref('#lin-node:node_alice')).toBeNull();
    expect(localFileReferenceFromHref('https://example.com')).toBeNull();
    expect(localFileReferenceFromHref(undefined)).toBeNull();
  });

  test('an empty decoded path is rejected', () => {
    expect(localFileReferenceFromHref(`#${LOCAL_FILE_REFERENCE_LINK_PREFIX}file:`)).toBeNull();
  });
});
