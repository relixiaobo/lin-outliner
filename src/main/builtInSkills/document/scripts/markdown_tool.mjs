#!/usr/bin/env node
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PLACEHOLDER_RE = /\b(lorem|ipsum|todo|placeholder|sample|dummy|xxxx)\b/gi;
const IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/g;
const LINK_RE = /(?<!!)\[[^\]]+\]\(([^)]+)\)/g;

function usage() {
  console.error('Usage: node scripts/markdown_tool.mjs inspect draft.md [--out report.json]');
}

function localReferences(markdown) {
  const refs = [];
  for (const match of markdown.matchAll(IMAGE_RE)) refs.push(match[1]);
  for (const match of markdown.matchAll(LINK_RE)) refs.push(match[1]);
  return refs.filter((value) => {
    const clean = value.trim();
    if (!clean || clean.startsWith('#')) return false;
    if (/^(https?:|data:|mailto:|tel:)/i.test(clean)) return false;
    return true;
  });
}

function externalReferences(markdown) {
  const refs = [];
  for (const match of markdown.matchAll(IMAGE_RE)) refs.push(match[1]);
  for (const match of markdown.matchAll(LINK_RE)) refs.push(match[1]);
  return refs.filter((value) => /^https?:/i.test(value.trim()));
}

function remoteImageReferences(markdown) {
  const refs = [];
  for (const match of markdown.matchAll(IMAGE_RE)) refs.push(match[1]);
  return refs.filter((value) => /^https?:/i.test(value.trim()));
}

async function existingLocalReference(filePath, ref) {
  const cleanRef = ref.split('#')[0].split('?')[0].replace(/^<|>$/g, '');
  if (!cleanRef) return true;
  try {
    await access(path.resolve(path.dirname(filePath), cleanRef));
    return true;
  } catch {
    return false;
  }
}

async function inspectMarkdown(filePath, markdown) {
  const headings = [...markdown.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((match) => ({
    level: match[1].length,
    text: match[2].trim(),
  }));
  const refs = localReferences(markdown);
  const externalRefs = externalReferences(markdown);
  const remoteImageRefs = remoteImageReferences(markdown);
  const brokenLocalReferences = [];
  for (const ref of refs) {
    if (!(await existingLocalReference(filePath, ref))) brokenLocalReferences.push(ref);
  }
  const placeholders = sortedUnique([...markdown.matchAll(PLACEHOLDER_RE)].map((match) => match[0].toLowerCase()));
  const warnings = [];
  if (headings.length === 0) warnings.push('no_headings_found');
  if (headings[0] && headings[0].level !== 1) warnings.push('first_heading_not_h1');
  if (placeholders.length > 0) warnings.push('placeholder_text_found');
  if (brokenLocalReferences.length > 0) warnings.push('broken_local_asset_reference_found');
  if (remoteImageRefs.length > 0) warnings.push('remote_image_reference_found');

  return {
    file: filePath,
    ok: warnings.length === 0,
    heading_count: headings.length,
    headings,
    local_references: sortedUnique(refs),
    external_references: sortedUnique(externalRefs),
    remote_image_references: sortedUnique(remoteImageRefs),
    broken_local_references: sortedUnique(brokenLocalReferences),
    placeholder_hits: placeholders,
    warnings,
  };
}

function sortedUnique(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

const [command, input, ...rest] = process.argv.slice(2);
if (command !== 'inspect' || !input) {
  usage();
  process.exit(2);
}

let out = '-';
for (let index = 0; index < rest.length; index += 1) {
  if (rest[index] === '--out') {
    out = rest[index + 1] ?? '-';
    index += 1;
  }
}

const inputPath = path.resolve(input);
const markdown = await readFile(inputPath, 'utf8');
const report = await inspectMarkdown(inputPath, markdown);
const json = `${JSON.stringify(report, null, 2)}\n`;
if (out === '-') {
  process.stdout.write(json);
} else {
  await writeFile(path.resolve(out), json, 'utf8');
}
process.exit(report.ok ? 0 : 1);
