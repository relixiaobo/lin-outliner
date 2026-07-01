import { mkdir, readdir, rm, stat, copyFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BUILT_IN_SKILL_SOURCE_DIR,
  ENABLED_LINLAB_BUILT_IN_SKILLS,
  GENERATED_BUILT_IN_SKILL_RESOURCE_DIR,
  LINLAB_SKILLS_ROOT_ENV,
} from '../src/main/builtInSkillConfig';

const repoRoot = path.resolve(import.meta.dir, '..');
const localBuiltInRoot = path.join(repoRoot, BUILT_IN_SKILL_SOURCE_DIR);
const generatedRoot = path.join(repoRoot, GENERATED_BUILT_IN_SKILL_RESOURCE_DIR);
const linlabSkillsRoot = process.env[LINLAB_SKILLS_ROOT_ENV]
  ? path.resolve(process.env[LINLAB_SKILLS_ROOT_ENV] ?? '')
  : path.resolve(repoRoot, '..', 'linlab-skills');

const SKIP_NAMES = new Set([
  '.DS_Store',
  '.git',
  '.gitignore',
  '__pycache__',
  'evals',
  'node_modules',
]);

await rm(generatedRoot, { recursive: true, force: true });
await mkdir(generatedRoot, { recursive: true });

await copyLocalBuiltIns();
for (const name of ENABLED_LINLAB_BUILT_IN_SKILLS) {
  await copyExternalSkill(name, path.join(linlabSkillsRoot, name));
}

console.log(`Synced built-in skills to ${path.relative(repoRoot, generatedRoot)}`);

async function copyLocalBuiltIns(): Promise<void> {
  const entries = await readdir(localBuiltInRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (ENABLED_LINLAB_BUILT_IN_SKILLS.includes(entry.name as typeof ENABLED_LINLAB_BUILT_IN_SKILLS[number])) {
      continue;
    }
    await copyDirectory(path.join(localBuiltInRoot, entry.name), path.join(generatedRoot, entry.name));
  }
}

async function copyExternalSkill(name: string, sourceRoot: string): Promise<void> {
  const skillFile = path.join(sourceRoot, 'SKILL.md');
  if (!(await fileExists(skillFile))) {
    throw new Error(`Enabled linlab skill "${name}" is missing at ${skillFile}. Set ${LINLAB_SKILLS_ROOT_ENV} to the linlab-skills checkout.`);
  }
  await copyDirectory(sourceRoot, path.join(generatedRoot, name));
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldSkip(entry.name)) continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await copyFile(sourcePath, destinationPath);
    }
  }
}

function shouldSkip(name: string): boolean {
  return SKIP_NAMES.has(name) || name.endsWith('.pyc') || name.endsWith('.pyo');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

