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
 *
 * Offline + deterministic (no network / gh). Exits 1 on any violation.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const PLANS_DIR = join(ROOT, 'docs', 'plans');
const TASKS_PATH = join(ROOT, 'docs', 'TASKS.md');

const tasks = readFileSync(TASKS_PATH, 'utf8');
const errors: string[] = [];

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
    `${activePlanSlugs.length} active plan(s) on the board.`,
);
