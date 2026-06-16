#!/usr/bin/env node
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PLACEHOLDER_RE = /\b(lorem|ipsum|todo|placeholder|sample|dummy|xxxx)\b/gi;
const REGISTERED_LAYOUTS = new Set([
  'cover',
  'section',
  'split',
  'metric',
  'compare',
  'timeline',
  'diagram',
  'chart',
  'gallery',
  'quote',
  'close',
]);
const TEXT_ONLY_LAYOUTS = new Set(['section', 'quote', 'close']);
const VISUAL_MARKER_RE = /<(img|svg|canvas|video|figure)\b|class\s*=\s*["'][^"']*\b(metric|visual-frame|timeline|quote|gallery|compare|diagram|signal|panel|number|chart)\b/i;
const TINY_FONT_RE = /font-size\s*:\s*((?:[0-9](?:\.\d+)?)|(?:1[0-3](?:\.\d+)?))px\b/gi;

function usage() {
  console.error('Usage: node scripts/html_tool.mjs inspect deck.html [--out report.json]');
}

function attrValues(html, attr) {
  const values = [];
  const re = new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, 'gi');
  for (const match of html.matchAll(re)) values.push(match[1]);
  return values;
}

function attrValue(html, attr) {
  return attrValues(html, attr)[0];
}

function classList(tag) {
  return (attrValue(tag, 'class') ?? '').split(/\s+/).filter(Boolean);
}

function slideElements(html) {
  const slides = [];
  const re = /<(section|article)\b([^>]*)>[\s\S]*?<\/\1>/gi;
  for (const match of html.matchAll(re)) {
    const tag = match[0].match(/^<[^>]+>/)?.[0] ?? '';
    const attrs = match[2] ?? '';
    const classes = classList(tag);
    if (classes.includes('slide') || /\bdata-slide\b/i.test(attrs)) {
      slides.push({
        index: slides.length + 1,
        html: match[0],
        tag,
        layout: attrValue(tag, 'data-layout') ?? '',
        classes,
      });
    }
  }
  return slides;
}

function slideElementCount(html) {
  const slides = slideElements(html);
  if (slides.length > 0) return slides.length;

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

function remoteDependencies(html) {
  const remoteSrcs = attrValues(html, 'src').filter((value) => /^https?:/i.test(value.trim()));
  const remoteCssUrls = [];
  const cssUrlRe = /url\(\s*["']?(https?:[^"')\s]+)["']?\s*\)/gi;
  for (const match of html.matchAll(cssUrlRe)) remoteCssUrls.push(match[1]);

  const remoteLinks = [];
  const linkRe = /<link\b[^>]*>/gi;
  for (const match of html.matchAll(linkRe)) {
    const href = attrValues(match[0], 'href')[0];
    if (href && /^https?:/i.test(href.trim())) remoteLinks.push(href);
  }
  return sortedUnique([...remoteSrcs, ...remoteCssUrls, ...remoteLinks]);
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
  const slides = slideElements(html);
  const slideCount = slides.length || slideElementCount(html);
  const localRefs = [
    ...attrValues(html, 'src'),
    ...attrValues(html, 'href'),
  ].filter((value) => {
    if (!value || value.startsWith('#')) return false;
    if (/^(https?:|data:|mailto:|tel:)/i.test(value)) return false;
    return true;
  });
  const placeholders = sortedUnique([...html.matchAll(PLACEHOLDER_RE)].map((match) => match[0].toLowerCase()));
  const remoteDependencyRefs = remoteDependencies(html);
  const errors = [];
  const warnings = [];
  const layouts = slides.map((slide) => slide.layout).filter(Boolean);
  const missingLayoutSlides = slides.filter((slide) => !slide.layout).map((slide) => slide.index);
  const unknownLayouts = sortedUnique(layouts.filter((layout) => !REGISTERED_LAYOUTS.has(layout)));
  const textOnlySlides = slides
    .filter((slide) => !TEXT_ONLY_LAYOUTS.has(slide.layout) && !VISUAL_MARKER_RE.test(slide.html))
    .map((slide) => slide.index);
  const bulletDenseSlides = slides
    .filter((slide) => (slide.html.match(/<li\b/gi) ?? []).length >= 5)
    .map((slide) => slide.index);
  const tinyTextHits = sortedUnique([...html.matchAll(TINY_FONT_RE)].map((match) => `${match[1]}px`));
  const brokenLocalReferences = [];
  for (const ref of localRefs) {
    if (!(await existingLocalReference(filePath, ref))) brokenLocalReferences.push(ref);
  }
  if (slideCount === 0) errors.push('no_slide_elements_found');
  if (placeholders.length > 0) warnings.push('placeholder_text_found');
  if (brokenLocalReferences.length > 0) errors.push('broken_local_asset_reference_found');
  if (remoteDependencyRefs.length > 0) warnings.push('remote_dependency_reference_found');
  if (!/keydown|data-deck|data-slide/i.test(html)) warnings.push('navigation_not_obvious');
  if (!/aspect-ratio\s*:\s*16\s*\/\s*9/i.test(html)) warnings.push('missing_16_9_aspect_ratio_hint');
  if (missingLayoutSlides.length > 0) warnings.push('missing_registered_layout_found');
  if (unknownLayouts.length > 0) warnings.push('unknown_layout_found');
  if (slideCount >= 4 && new Set(layouts).size <= 2) warnings.push('low_layout_variety');
  if (textOnlySlides.length > 0) warnings.push('text_only_slide_found');
  if (bulletDenseSlides.length > 0) warnings.push('bullet_dump_risk');
  if (tinyTextHits.length > 0) warnings.push('tiny_text_risk');

  return {
    file: filePath,
    ok: errors.length === 0,
    errors,
    slide_count: slideCount,
    layouts: sortedUnique(layouts),
    missing_layout_slides: missingLayoutSlides,
    unknown_layouts: unknownLayouts,
    visual_slide_count: slideCount - textOnlySlides.length,
    text_only_slides: textOnlySlides,
    bullet_dense_slides: bulletDenseSlides,
    tiny_text_hits: tinyTextHits,
    local_references: sortedUnique(localRefs),
    remote_dependency_references: remoteDependencyRefs,
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
