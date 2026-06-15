#!/usr/bin/env node
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PLACEHOLDER_RE = /\b(lorem|ipsum|todo|placeholder|sample|dummy|xxxx)\b/gi;

function usage() {
  console.error('Usage: node scripts/html_tool.mjs inspect deck.html [--out report.json]');
}

function attrValues(html, attr) {
  const values = [];
  const re = new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, 'gi');
  for (const match of html.matchAll(re)) values.push(match[1]);
  return values;
}

function slideElementCount(html) {
  const elementRe = /<(section|article|div)\b([^>]*)>/gi;
  let count = 0;
  for (const match of html.matchAll(elementRe)) {
    const attrs = match[2] ?? '';
    const classMatch = attrs.match(/\bclass\s*=\s*["']([^"']+)["']/i);
    const classes = classMatch ? classMatch[1].split(/\s+/).filter(Boolean) : [];
    if (classes.includes('slide') || /\bdata-slide\b/i.test(attrs)) count += 1;
  }
  return count;
}

async function existingLocalReference(filePath, ref) {
  const cleanRef = ref.split('#')[0].split('?')[0];
  if (!cleanRef) return true;
  try {
    await access(path.resolve(path.dirname(filePath), cleanRef));
    return true;
  } catch {
    return false;
  }
}

async function inspectHtml(filePath, html) {
  const slideCount = slideElementCount(html);
  const localRefs = [
    ...attrValues(html, 'src'),
    ...attrValues(html, 'href'),
  ].filter((value) => {
    if (!value || value.startsWith('#')) return false;
    if (/^(https?:|data:|mailto:|tel:)/i.test(value)) return false;
    return true;
  });
  const placeholders = sortedUnique([...html.matchAll(PLACEHOLDER_RE)].map((match) => match[0].toLowerCase()));
  const warnings = [];
  const brokenLocalReferences = [];
  for (const ref of localRefs) {
    if (!(await existingLocalReference(filePath, ref))) brokenLocalReferences.push(ref);
  }
  if (slideCount === 0) warnings.push('no_slide_elements_found');
  if (placeholders.length > 0) warnings.push('placeholder_text_found');
  if (brokenLocalReferences.length > 0) warnings.push('broken_local_asset_reference_found');
  if (/https?:\/\/|cdn\./i.test(html)) warnings.push('remote_dependency_reference_found');
  if (!/keydown|data-deck|data-slide/i.test(html)) warnings.push('navigation_not_obvious');
  if (!/aspect-ratio\s*:\s*16\s*\/\s*9/i.test(html)) warnings.push('missing_16_9_aspect_ratio_hint');

  return {
    file: filePath,
    ok: warnings.length === 0,
    slide_count: slideCount,
    local_references: sortedUnique(localRefs),
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
const html = await readFile(inputPath, 'utf8');
const report = await inspectHtml(inputPath, html);
const json = `${JSON.stringify(report, null, 2)}\n`;
if (out === '-') {
  process.stdout.write(json);
} else {
  await writeFile(path.resolve(out), json, 'utf8');
}
process.exit(report.ok ? 0 : 1);
