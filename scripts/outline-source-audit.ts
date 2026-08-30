import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface RetiredSurfaceCheck {
  readonly label: string;
  readonly pattern: string;
  readonly roots: readonly string[];
  readonly globs?: readonly string[];
}

const ROOT = resolve(import.meta.dir, '..');
const SOURCE_ROOTS = ['src/core', 'src/outline', 'src/main', 'src/renderer/ui'] as const;
const TEST_ROOTS = ['tests/core', 'tests/renderer', 'tests/e2e'] as const;

const retiredSurfaceChecks: readonly RetiredSurfaceCheck[] = [
  {
    label: 'retired Outline Node variants',
    pattern: String.raw`\b(ImageNode|AttachmentNode)\b|type:\s*['"](?:image|attachment)['"]|\.type\s*===\s*['"](?:image|attachment)['"]|case\s*['"](?:image|attachment)['"]`,
    roots: [...SOURCE_ROOTS, ...TEST_ROOTS],
    globs: [
      '!src/core/agent/**',
      '!src/main/agent/**',
      '!src/renderer/agent/**',
      '!src/main/main.ts',
      '!src/main/piImageModels.ts',
      '!tests/core/agent*.test.ts',
      '!tests/renderer/thread*.test.*',
      '!tests/e2e/agent-thread.spec.ts',
    ],
  },
  {
    label: 'retired Outline Node commands',
    pattern: String.raw`create_(?:image|attachment)_node|set_node_image|create(?:Image|Attachment)Node|setNodeImage`,
    roots: [...SOURCE_ROOTS, ...TEST_ROOTS],
    globs: [
      '!src/core/agent/**',
      '!src/main/agent/**',
      '!src/renderer/agent/**',
      '!src/main/main.ts',
      '!src/main/piImageModels.ts',
      '!tests/core/agent*.test.ts',
      '!tests/renderer/thread*.test.*',
      '!tests/e2e/agent-thread.spec.ts',
    ],
  },
  {
    label: 'retired Outline file-node adapters',
    pattern: String.raw`\b(fileNodeTarget|fileNodeMeta|fileNodePreviewMeta|fileNodePreviewControls|boundFileNode)\b`,
    roots: ['src/renderer/ui', 'tests/renderer', 'tests/e2e'],
  },
  {
    label: 'legacy URL field type',
    pattern: String.raw`['"]url['"]`,
    roots: [
      'src/core/types.ts',
      'src/core/configSchema.ts',
      'src/core/fieldTypeRegistry.ts',
      'src/outline/contract',
      'src/renderer/ui/fields',
      'src/renderer/ui/outliner/fieldTypePresentation.tsx',
      'tests/core/configSchema.test.ts',
      'tests/renderer/definitionConfig.test.ts',
    ],
  },
];

const previewEvidence: readonly [label: string, file: string, pattern: RegExp][] = [
  ['shared preview shell', 'src/renderer/ui/preview/previewRenderers.tsx', /export function FilePreviewShell/],
  ['ordered preview renderer registry', 'src/renderer/ui/preview/previewRenderers.tsx', /PREVIEW_RENDERERS/],
  ['PDF summary and reader', 'src/renderer/ui/preview/previewRenderers.tsx', /PdfPreview/],
  ['EPUB reader', 'src/renderer/ui/preview/EpubPreview.tsx', /export function EpubPreview/],
  ['HTML reader', 'src/renderer/ui/preview/previewRenderers.tsx', /function HtmlPreview/],
  ['media chrome', 'src/renderer/ui/preview/previewRenderers.tsx', /<MediaController/],
  ['reading-position persistence', 'src/renderer/ui/preview/readingPositionStore.ts', /previewReadingPositionKey/],
  ['preview shell renderer coverage', 'tests/renderer/filePreviewShell.test.tsx', /FilePreviewShell/],
  ['preview preference coverage', 'tests/renderer/previewPreferenceStores.test.tsx', /describe\('preview preference stores'/],
  ['workspace preview history coverage', 'tests/renderer/workspaceLayoutHistory.test.tsx', /file-preview/],
];

let failed = false;
for (const check of retiredSurfaceChecks) {
  const args = ['--line-number', '--color', 'never', '--glob', '*.{ts,tsx}', check.pattern];
  for (const glob of check.globs ?? []) args.push('--glob', glob);
  args.push(...check.roots);
  const result = Bun.spawnSync(['rg', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  const output = result.stdout.toString().trim();
  if (!output) continue;
  failed = true;
  console.error(`\n[${check.label}]`);
  console.error(output);
}

for (const [label, file, pattern] of previewEvidence) {
  const path = resolve(ROOT, file);
  if (existsSync(path) && pattern.test(readFileSync(path, 'utf8'))) continue;
  failed = true;
  console.error(`\n[missing preview evidence] ${label}: ${file}`);
}

if (failed) process.exit(1);
