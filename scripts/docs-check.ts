#!/usr/bin/env bun
/**
 * docs:check — guards the repository's documentation lifecycle and link graph.
 *
 * Doc model: docs/TASKS.md is the SINGLE source of truth for plan todo + status +
 * priority and links out to plan files; plan files are pure design and carry no
 * frontmatter/status. Single-sourcing makes status *divergence* impossible by
 * construction; this guard enforces the remaining structural invariants:
 *
 *   C1 link integrity — every plan mention in TASKS.md resolves: prose mentions of
 *      `docs/plans/<...>.md` must name a file that exists, and Markdown links must
 *      resolve file-relative (the way GitHub renders them from docs/TASKS.md);
 *      root-relative link targets (`](docs/…)`) are rejected because they render 404.
 *   C2 no orphan plans — every active (top-level `docs/plans/*.md`; `archive/` and
 *      `reference/` are exempt) is referenced in TASKS.md as a real board reference
 *      (`<slug>.md`), not a substring — `settings-redesign` must not be satisfied by a
 *      historical `native-settings-redesign` mention. A plan not yet on `origin/main`
 *      is a branch introducing it; boarding is the integration gate's job at merge,
 *      so it is exempt until it lands.
 *   C3 spec link integrity — every local Markdown link and heading anchor in
 *      the recursive docs/spec Markdown tree resolves, so specs cannot point at moved/deleted
 *      documents or stale sections.
 *   C4 root doc links — every local Markdown link and heading anchor in README.md and
 *      AGENTS.md resolves; these are the first files outside readers and every agent load.
 *   C5 maintained doc links — the same for plans, lessons, module READMEs, and
 *      built-in Skill documentation (historical CHANGELOG prose and fixtures are exempt).
 *   C6 plan shape — plan files carry no frontmatter; active plans expose the
 *      Goal / Non-goals / Design / Open questions contract with unique headings.
 *   C7 durable references — active/reference plans and TASKS use symbols or test
 *      titles instead of line-number anchors that rot after ordinary edits.
 *   C8 changelog shape — the current Unreleased block has at most one section per
 *      category.
 *   C9 aliases and indexes — AGENT.md / CLAUDE.md remain AGENTS.md symlinks and
 *      every current spec is routed by its owning index.
 *   C10 current authority paths — root, board, specs, active/reference plans, and
 *      module docs do not name moved or deleted docs/plans or docs/spec Markdown files.
 *
 * Offline + deterministic (no network / gh; git is used only against local refs).
 * Exits 1 on any violation.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, lstatSync, readlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const DOCS_DIR = join(ROOT, 'docs');
const PLANS_DIR = join(ROOT, 'docs', 'plans');
const SPEC_DIR = join(ROOT, 'docs', 'spec');
const TASKS_PATH = join(ROOT, 'docs', 'TASKS.md');
const CHANGELOG_PATH = join(ROOT, 'CHANGELOG.md');

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

// C1 — every plan mention in TASKS.md resolves.
// Prose mentions (`docs/plans/<...>.md` anywhere in the text) must name real files.
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
// Markdown links must resolve file-relative — that is how GitHub renders them from
// docs/TASKS.md — and must not be written root-relative, which renders as docs/docs/….
const markdownLinkRe = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g;
let checkedTasksLinks = 0;
for (const match of stripMarkdownCode(tasks).matchAll(markdownLinkRe)) {
  const target = normalizeMarkdownLinkTarget(match[1] ?? '');
  if (!target || !target.path) continue;
  checkedTasksLinks += 1;
  if (target.path.startsWith('docs/')) {
    errors.push(
      `C1 root-relative link: TASKS.md links to ${target.path}; write it relative ` +
        `to docs/ (e.g. plans/…) so GitHub renders it.`,
    );
    continue;
  }
  const resolved = resolve(dirname(TASKS_PATH), target.path);
  if (!existsSync(resolved)) {
    errors.push(
      `C1 dangling link: TASKS.md links to ${target.path}, but ` +
        `${relative(ROOT, resolved)} does not exist.`,
    );
  }
}

// C2 — every active plan is referenced in TASKS.md as a real board reference.
// Top-level files only: archive/ holds terminal plans and reference/ holds standing
// authorities; neither is a unit of active work the board must carry.
// `git cat-file -e` exits 128 for BOTH a missing path and a missing ref, so the
// two cases cannot be told apart by its status. Probe the ref separately with
// `rev-parse --verify`, which exits non-zero only when the ref itself is absent.
function originMainIsAvailable(): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'origin/main^{commit}'], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}
function existsOnOriginMain(repoRelPath: string): boolean | null {
  if (!originMainIsAvailable()) return null;
  try {
    execFileSync('git', ['cat-file', '-e', `origin/main:${repoRelPath}`], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}
const activePlanFiles = readdirSync(PLANS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
  .map((entry) => join(PLANS_DIR, entry.name))
  .sort();
const activePlanSlugs = activePlanFiles.map((file) =>
  file.slice(PLANS_DIR.length + 1, -'.md'.length),
);
for (const slug of activePlanSlugs) {
  // A real reference is the file name (`<slug>.md`), not the slug as a substring of
  // other prose — `settings-redesign` was once "on the board" only because
  // `native-settings-redesign` appeared in a historical entry.
  if (tasks.includes(`${slug}.md`)) continue;
  // A plan file this branch is introducing has no board entry yet by design: dev
  // agents never edit TASKS.md; the integration gate boards it at merge.
  if (existsOnOriginMain(`docs/plans/${slug}.md`) === false) continue;
  errors.push(
    `C2 orphan plan: docs/plans/${slug}.md is on disk but not referenced as ` +
      `${slug}.md anywhere in TASKS.md (put it on the board, or move it to archive/).`,
  );
}

// C3 — every local Markdown link and heading anchor in docs/spec/**/*.md resolves.
// C4 — the same, for the root docs every reader and agent hits first.
function checkLocalLinks(rule: string, kind: string, files: string[]): number {
  let checked = 0;
  for (const file of files) {
    const source = stripMarkdownCode(readFileSync(file, 'utf8'));
    const sourceRel = relative(ROOT, file);
    for (const match of source.matchAll(markdownLinkRe)) {
      const target = normalizeMarkdownLinkTarget(match[1] ?? '');
      if (!target) continue;
      checked += 1;
      const resolved = target.path ? resolve(dirname(file), target.path) : file;
      if (!existsSync(resolved)) {
        errors.push(
          `${rule} dangling ${kind} link: ${sourceRel} links to ${target.path}, but ` +
            `${relative(ROOT, resolved)} does not exist.`,
        );
        continue;
      }
      if (target.anchor && resolved.endsWith('.md')) {
        const anchors = markdownHeadingAnchors(resolved);
        if (!anchors.has(target.anchor)) {
          errors.push(
            `${rule} dangling ${kind} anchor: ${sourceRel} links to ${target.path}#${target.anchor}, ` +
              `but ${relative(ROOT, resolved)} has no matching heading.`,
          );
        }
      }
    }
  }
  return checked;
}
const checkedSpecLinks = checkLocalLinks('C3', 'spec', markdownFiles(SPEC_DIR));
const checkedRootLinks = checkLocalLinks(
  'C4',
  'root doc',
  [join(ROOT, 'README.md'), join(ROOT, 'AGENTS.md')].filter((file) => existsSync(file)),
);

// C5 — every maintained Markdown link resolves. CHANGELOG is append-only history,
// while vendor docs and test fixtures are not Tenon-owned documentation surfaces.
const rootDocFiles = [join(ROOT, 'README.md'), join(ROOT, 'AGENTS.md')].filter((file) =>
  existsSync(file),
);
const specFiles = markdownFiles(SPEC_DIR);
const maintainedDocFiles = [
  ...markdownFiles(DOCS_DIR),
  ...(existsSync(join(ROOT, 'native')) ? markdownFiles(join(ROOT, 'native')) : []),
  ...(existsSync(join(ROOT, 'src')) ? markdownFiles(join(ROOT, 'src')) : []),
];
const alreadyChecked = new Set([...rootDocFiles, ...specFiles]);
const checkedMaintainedLinks = checkLocalLinks(
  'C5',
  'maintained doc',
  maintainedDocFiles.filter((file) => !alreadyChecked.has(file)),
);

// C6 — plan files are design-only, and active plans expose the standard reader contract.
const allPlanFiles = markdownFiles(PLANS_DIR);
for (const file of allPlanFiles) {
  const source = readFileSync(file, 'utf8');
  if (/^---\r?\n/.test(source)) {
    errors.push(`C6 plan frontmatter: ${relative(ROOT, file)} must keep lifecycle metadata in TASKS.md.`);
  }
  if (!/^#\s+\S/.test(source)) {
    errors.push(`C6 plan title: ${relative(ROOT, file)} must begin with its H1 title.`);
  }
}

const requiredActiveHeadings = ['Goal', 'Non-goals', 'Design', 'Open questions'];
for (const file of activePlanFiles) {
  const source = stripMarkdownCode(readFileSync(file, 'utf8'));
  for (const heading of requiredActiveHeadings) {
    const headingRe = new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}(?:\\s|$)`, 'm');
    if (!headingRe.test(source)) {
      errors.push(`C6 active plan shape: ${relative(ROOT, file)} is missing "## ${heading}".`);
    }
  }

  const headingCounts = new Map<string, number>();
  for (const match of source.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const slug = markdownHeadingSlug(match[0]!);
    headingCounts.set(slug, (headingCounts.get(slug) ?? 0) + 1);
  }
  for (const [slug, count] of headingCounts) {
    if (count > 1) {
      errors.push(
        `C6 duplicate active-plan heading: ${relative(ROOT, file)} repeats "${slug}" ${count} times.`,
      );
    }
  }
}

// C7 — numeric line anchors become wrong silently; current planning references use symbols.
const referencePlanFiles = markdownFiles(join(PLANS_DIR, 'reference'));
const durableReferenceFiles = [TASKS_PATH, ...activePlanFiles, ...referencePlanFiles];
const fileLineRefRe = /[A-Za-z0-9_./-]+\.(?:[cm]?[jt]sx?|css|md|json|sh):\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*\b/g;
for (const file of durableReferenceFiles) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(fileLineRefRe)) {
    const line = source.slice(0, match.index).split('\n').length;
    errors.push(
      `C7 unstable line reference: ${relative(ROOT, file)}:${line} contains ` +
        `${match[0]}; use a symbol or test title.`,
    );
  }
}

// C8 — one current category section only; released historical blocks remain append-only.
const changelog = readFileSync(CHANGELOG_PATH, 'utf8');
const unreleasedMarker = '## [Unreleased]';
const unreleasedStart = changelog.indexOf(unreleasedMarker);
if (unreleasedStart < 0) {
  errors.push('C8 missing Unreleased block: CHANGELOG.md must contain ## [Unreleased].');
}
const unreleasedTail =
  unreleasedStart >= 0 ? changelog.slice(unreleasedStart + unreleasedMarker.length) : '';
const nextReleaseOffset = unreleasedTail.search(/^## \[/m);
const unreleased = nextReleaseOffset >= 0 ? unreleasedTail.slice(0, nextReleaseOffset) : unreleasedTail;
const categoryCounts = new Map<string, number>();
for (const match of unreleased.matchAll(/^###\s+(.+)$/gm)) {
  const category = match[1]!.trim();
  categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
}
for (const [category, count] of categoryCounts) {
  if (count > 1) {
    errors.push(`C8 duplicate Unreleased category: CHANGELOG.md has ${count} "### ${category}" sections.`);
  }
}

// C9 — keep the single instruction source and complete current-spec routing.
for (const alias of ['AGENT.md', 'CLAUDE.md']) {
  const path = join(ROOT, alias);
  if (!existsSync(path) || !lstatSync(path).isSymbolicLink() || readlinkSync(path) !== 'AGENTS.md') {
    errors.push(`C9 instruction alias: ${alias} must be a symlink to AGENTS.md.`);
  }
}

const specIndex = readFileSync(join(SPEC_DIR, 'README.md'), 'utf8');
for (const entry of readdirSync(SPEC_DIR, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'README.md') continue;
  if (!specIndex.includes(`](${entry.name})`)) {
    errors.push(`C9 unindexed spec: docs/spec/${entry.name} is missing from docs/spec/README.md.`);
  }
}
const designSystemIndex = readFileSync(join(SPEC_DIR, 'design-system.md'), 'utf8');
for (const entry of readdirSync(join(SPEC_DIR, 'design-system'), { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
  if (!designSystemIndex.includes(`](./design-system/${entry.name})`)) {
    errors.push(
      `C9 unindexed design-system spec: docs/spec/design-system/${entry.name} is missing ` +
        `from design-system.md.`,
    );
  }
}

// C10 — raw path mentions in current authorities must follow moved specs/plans.
const currentAuthorityFiles = [
  ...rootDocFiles,
  TASKS_PATH,
  join(DOCS_DIR, 'lessons.md'),
  ...specFiles,
  ...activePlanFiles,
  ...referencePlanFiles,
  ...maintainedDocFiles.filter(
    (file) => file.startsWith(join(ROOT, 'native')) || file.startsWith(join(ROOT, 'src')),
  ),
];
const currentDocPathRe = /docs\/(?:plans|spec)\/[A-Za-z0-9._/-]+\.md/g;
for (const file of new Set(currentAuthorityFiles)) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(currentDocPathRe)) {
    if (!existsSync(join(ROOT, match[0]))) {
      const line = source.slice(0, match.index).split('\n').length;
      errors.push(
        `C10 stale authority path: ${relative(ROOT, file)}:${line} names missing ${match[0]}.`,
      );
    }
  }
}

for (const file of markdownFiles(join(PLANS_DIR, 'archive'))) {
  const source = readFileSync(file, 'utf8').split('\n').slice(0, 40).join('\n');
  for (const match of source.matchAll(currentDocPathRe)) {
    if (!existsSync(join(ROOT, match[0]))) {
      const line = source.slice(0, match.index).split('\n').length;
      errors.push(
        `C10 stale archive entry path: ${relative(ROOT, file)}:${line} names missing ${match[0]}.`,
      );
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
  `docs:check OK — ${linkedRelPaths.size} plan mention(s) and ${checkedTasksLinks} board ` +
    `link(s) resolve, ${activePlanSlugs.length} active plan(s) on the board, ` +
    `${checkedSpecLinks} spec, ${checkedRootLinks} root, and ${checkedMaintainedLinks} maintained-doc ` +
    `link(s) resolve; plan shape, durable references, changelog categories, aliases, and spec indexes pass.`,
);
