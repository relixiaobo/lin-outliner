#!/usr/bin/env bun
/**
 * docs:check — guards that docs/TASKS.md stays structurally consistent with the
 * plan files it points to.
 *
 * Doc model: docs/TASKS.md is the SINGLE source of truth for plan todo + status +
 * priority and links out to plan files; plan files are pure design and carry no
 * frontmatter/status. Single-sourcing makes status *divergence* impossible by
 * construction, so this guard only enforces the two structural invariants it
 * cannot cover on its own:
 *
 *   C1 link integrity — every `docs/plans/<...>.md` link in TASKS.md resolves to a
 *      file at that exact location. A shipped plan moved to `archive/` while its
 *      board link still points at `plans/` is a dangling link → caught here.
 *   C2 no orphan plans — every active (non-archive) `docs/plans/*.md` is referenced
 *      somewhere in TASKS.md, so a new plan can't be silently missing from the board.
 *   C3 spec link integrity — every local Markdown link and heading anchor in
 *      the recursive docs/spec Markdown tree resolves, so specs cannot point at moved/deleted
 *      documents or stale sections.
 *
 * Offline + deterministic (no network / gh). Exits 1 on any violation.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const PLANS_DIR = join(ROOT, 'docs', 'plans');
const SPEC_DIR = join(ROOT, 'docs', 'spec');
const TASKS_PATH = join(ROOT, 'docs', 'TASKS.md');

const tasks = readFileSync(TASKS_PATH, 'utf8');
const errors: string[] = [];

function markdownFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...markdownFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(path);
    }
  }
  return files.sort();
}

function stripMarkdownCode(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/`+[^`\n]*`+/g, (span) => span.replace(/[^\n]/g, ' '));
}

function normalizeMarkdownLinkTarget(target: string): { path: string; anchor: string | null } | null {
  const trimmed = target.trim();
  if (!trimmed) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;

  const unwrapped = trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed;
  const [pathWithQuery, rawAnchor] = unwrapped.split('#', 2);
  const pathOnly = pathWithQuery!.split('?', 1)[0]!;

  try {
    return {
      path: pathOnly ? decodeURIComponent(pathOnly) : '',
      anchor: rawAnchor ? decodeURIComponent(rawAnchor) : null,
    };
  } catch {
    return { path: pathOnly, anchor: rawAnchor ?? null };
  }
}

function markdownHeadingSlug(heading: string): string {
  return heading
    .replace(/^#+\s*/, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/\s/g, '-');
}

const headingAnchorCache = new Map<string, Set<string>>();

function markdownHeadingAnchors(file: string): Set<string> {
  const cached = headingAnchorCache.get(file);
  if (cached) return cached;

  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  const source = stripMarkdownCode(readFileSync(file, 'utf8'));
  for (const match of source.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = markdownHeadingSlug(match[0]!);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  headingAnchorCache.set(file, anchors);
  return anchors;
}

// C1 — every docs/plans/...md link in TASKS.md resolves (incl. archive/ links).
const linkRe = /docs\/plans\/([A-Za-z0-9._/-]+\.md)/g;
const linkedRelPaths = new Set<string>();
for (const match of tasks.matchAll(linkRe)) linkedRelPaths.add(match[1]);
for (const rel of [...linkedRelPaths].sort()) {
  if (!existsSync(join(PLANS_DIR, rel))) {
    errors.push(
      `C1 dangling link: TASKS.md references docs/plans/${rel}, but no such file ` +
        `exists (shipped → moved to archive/? update the link).`,
    );
  }
}

// C2 — every active (non-archive) plan is referenced in TASKS.md.
const activePlanSlugs = readdirSync(PLANS_DIR)
  .filter((name) => name.endsWith('.md'))
  .map((name) => name.slice(0, -'.md'.length))
  .sort();
for (const slug of activePlanSlugs) {
  if (!tasks.includes(slug)) {
    errors.push(
      `C2 orphan plan: docs/plans/${slug}.md is on disk but not referenced anywhere ` +
        `in TASKS.md (put it on the board, or move it to archive/).`,
    );
  }
}

// C3 — every local Markdown link and heading anchor in docs/spec/**/*.md resolves.
let checkedSpecLinks = 0;
const markdownLinkRe = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g;
for (const file of markdownFiles(SPEC_DIR)) {
  const source = stripMarkdownCode(readFileSync(file, 'utf8'));
  const sourceRel = relative(ROOT, file);
  for (const match of source.matchAll(markdownLinkRe)) {
    const target = normalizeMarkdownLinkTarget(match[1] ?? '');
    if (!target) continue;
    checkedSpecLinks += 1;
    const resolved = target.path ? resolve(dirname(file), target.path) : file;
    if (!existsSync(resolved)) {
      errors.push(
        `C3 dangling spec link: ${sourceRel} links to ${target.path}, but ` +
          `${relative(ROOT, resolved)} does not exist.`,
      );
      continue;
    }
    if (target.anchor && resolved.endsWith('.md')) {
      const anchors = markdownHeadingAnchors(resolved);
      if (!anchors.has(target.anchor)) {
        errors.push(
          `C3 dangling spec anchor: ${sourceRel} links to ${target.path}#${target.anchor}, ` +
            `but ${relative(ROOT, resolved)} has no matching heading.`,
        );
      }
    }
  }
}

if (errors.length > 0) {
  console.error(`docs:check FAILED — ${errors.length} issue(s):\n`);
  for (const error of errors) console.error(`  • ${error}`);
  console.error(
    `\ndocs/TASKS.md is the single source of plan status; keep it consistent with docs/plans/.`,
  );
  process.exit(1);
}

console.log(
  `docs:check OK — ${linkedRelPaths.size} plan link(s) resolve, ` +
    `${activePlanSlugs.length} active plan(s) on the board, ` +
    `${checkedSpecLinks} spec link(s) resolve.`,
);
