import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const RETIRED_HELPERS = [
  ['format', 'LocalFile', 'ReferenceUrl'].join(''),
  ['parse', 'LocalFile', 'ReferenceUrl'].join(''),
  ['sanitize', 'FileReferenceRef'].join(''),
];
const CARET_MARKER = new RegExp(String.raw`\[\[(?:node|file):[^\]\r\n]*\x5e`, 'u');
const PSEUDO_FILE_URL = new RegExp(String.raw`file:(?:directory|file)?\x5e`, 'u');

describe('reference URI cutover guard', () => {
  test('keeps retired helpers and grammars out of product authority', () => {
    const sourceFindings = filesUnder('src', SOURCE_EXTENSIONS).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return RETIRED_HELPERS.filter((helper) => source.includes(helper)).map((helper) => `${file}: ${helper}`);
    });
    const grammarFiles = [
      ...filesUnder('src', SOURCE_EXTENSIONS),
      ...filesUnder('docs/spec', new Set(['.md'])),
      'tests/fixtures/__snapshots__/agentToolCatalogStability.test.ts.snap',
    ];
    const grammarFindings = grammarFiles.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return CARET_MARKER.test(source) || PSEUDO_FILE_URL.test(source) ? [file] : [];
    });

    expect({ sourceFindings, grammarFindings }).toEqual({
      sourceFindings: [],
      grammarFindings: [],
    });
  });
});

function filesUnder(root: string, extensions: ReadonlySet<string>): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) files.push(...filesUnder(path, extensions));
    else if ([...extensions].some((extension) => path.endsWith(extension))) files.push(path);
  }
  return files;
}
