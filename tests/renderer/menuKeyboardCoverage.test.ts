import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(import.meta.dir, '..', '..');
const UI_DIR = join(ROOT, 'src', 'renderer', 'ui');

describe('menu keyboard coverage', () => {
  test('JSX menu surfaces use the shared keyboard model', () => {
    const offenders = tsxFiles(UI_DIR)
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return /\brole\s*=\s*["']menu["']/.test(source) && !/\buseMenuKeyboard\s*\(/.test(source);
      })
      .map((file) => relative(ROOT, file))
      .sort();

    expect(offenders).toEqual([]);
  });
});

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return tsxFiles(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}
