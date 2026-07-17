import { mkdir, readdir, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BUILT_IN_SKILL_SOURCE_DIR,
  GENERATED_BUILT_IN_SKILL_RESOURCE_DIR,
} from '../src/main/builtInSkillConfig';

const repoRoot = path.resolve(import.meta.dir, '..');
const localBuiltInRoot = path.join(repoRoot, BUILT_IN_SKILL_SOURCE_DIR);
const generatedRoot = path.join(repoRoot, GENERATED_BUILT_IN_SKILL_RESOURCE_DIR);

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

console.log(`Synced built-in skills to ${path.relative(repoRoot, generatedRoot)}`);

async function copyLocalBuiltIns(): Promise<void> {
  const entries = await readdir(localBuiltInRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await copyDirectory(path.join(localBuiltInRoot, entry.name), path.join(generatedRoot, entry.name));
  }
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
