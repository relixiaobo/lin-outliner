#!/usr/bin/env node
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PLACEHOLDER_RE = /\b(lorem|ipsum|todo|placeholder|sample|dummy|xxxx)\b/gi;
const IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/g;
const LINK_RE = /(?<!!)\[[^\]]+\]\(([^)]+)\)/g;
const TABLE_ROW_RE = /^\s*\|(.+)\|\s*$/;

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
  const proseMarkdown = stripFencedCodeBlocks(markdown);
  const headings = [...proseMarkdown.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((match) => ({
    level: match[1].length,
    text: match[2].trim(),
  }));
  const headingLevelJumps = [];
  let previousLevel = 0;
  headings.forEach((heading, index) => {
    if (heading.level > previousLevel + 1) {
      headingLevelJumps.push({ heading_index: index + 1, level: heading.level, previous_level: previousLevel });
    }
    previousLevel = heading.level;
  });

  const paragraphs = proseMarkdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => {
      if (!block) return false;
      if (/^#{1,6}\s+/m.test(block)) return false;
      if (/^```/.test(block)) return false;
      if (/^\s*[-*+]\s+/m.test(block)) return false;
      if (TABLE_ROW_RE.test(block.split('\n')[0] ?? '')) return false;
      return true;
    });
  const longParagraphs = paragraphs
    .map((text, index) => ({ index: index + 1, word_count: text.split(/\s+/).filter(Boolean).length }))
    .filter((item) => item.word_count > 120);

  const tableRows = markdown.split('\n').filter((line) => TABLE_ROW_RE.test(line));
  const tableCount = countMarkdownTables(markdown);
  const wideTableRows = tableRows
    .map((line, index) => ({ row_index: index + 1, column_count: line.split('|').length - 2 }))
    .filter((row) => row.column_count > 6);
  const refs = localReferences(markdown);
  const externalRefs = externalReferences(markdown);
  const remoteImageRefs = remoteImageReferences(markdown);
  const brokenLocalReferences = [];
  for (const ref of refs) {
    if (!(await existingLocalReference(filePath, ref))) brokenLocalReferences.push(ref);
  }
  const placeholders = sortedUnique([...markdown.matchAll(PLACEHOLDER_RE)].map((match) => match[0].toLowerCase()));
  const errors = [];
  const warnings = [];
  if (headings.length === 0) warnings.push('no_headings_found');
  if (headings[0] && headings[0].level !== 1) warnings.push('first_heading_not_h1');
  if (headingLevelJumps.length > 0) warnings.push('heading_level_jump_found');
  if (longParagraphs.length > 0) warnings.push('long_paragraph_found');
  if (wideTableRows.length > 0) warnings.push('wide_table_found');
  if (placeholders.length > 0) warnings.push('placeholder_text_found');
  if (brokenLocalReferences.length > 0) errors.push('broken_local_asset_reference_found');
  if (remoteImageRefs.length > 0) warnings.push('remote_image_reference_found');

  return {
    file: filePath,
    ok: errors.length === 0,
    errors,
    word_count: markdown.split(/\s+/).filter(Boolean).length,
    paragraph_count: paragraphs.length,
    long_paragraphs: longParagraphs,
    heading_count: headings.length,
    headings,
    heading_level_jumps: headingLevelJumps,
    table_count: tableCount,
    wide_table_rows: wideTableRows,
    local_references: sortedUnique(refs),
    external_references: sortedUnique(externalRefs),
    remote_image_references: sortedUnique(remoteImageRefs),
    broken_local_references: sortedUnique(brokenLocalReferences),
    placeholder_hits: placeholders,
    warnings,
  };
}

function stripFencedCodeBlocks(markdown) {
  return markdown.replace(/^```[\s\S]*?^```/gm, '');
}

function sortedUnique(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function countMarkdownTables(markdown) {
  const lines = markdown.split('\n');
  let count = 0;
  let inTable = false;
  for (const line of lines) {
    const isRow = TABLE_ROW_RE.test(line);
    if (isRow && !inTable) {
      count += 1;
      inTable = true;
    } else if (!isRow) {
      inTable = false;
    }
  }
  return count;
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
