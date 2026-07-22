import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATED_RENDERER_FILES = [
  'src/renderer/ui/agent/AgentSettingsView.tsx',
  'src/renderer/agent/components/ThreadDock.tsx',
  'src/renderer/agent/components/ThreadView.tsx',
  'src/renderer/agent/components/items/ThreadItemView.tsx',
  'src/renderer/ui/primitives/CalendarMonthGrid.tsx',
  'src/renderer/ui/preview/previewRenderers.tsx',
  'src/renderer/ui/editor/InlineFilePreviewLayer.tsx',
] as const;

const DENIED_FORMATTING_PATTERNS = [
  'new Intl.DateTimeFormat',
  'new Intl.NumberFormat',
  '.toLocaleString(',
  '.toLocaleTimeString(',
  '.toLocaleDateString(',
] as const;

describe('renderer formatting static guard', () => {
  test('migrated render helpers use the shared formatter cache', () => {
    const violations: string[] = [];

    for (const file of MIGRATED_RENDERER_FILES) {
      const text = readFileSync(resolve(file), 'utf8');
      for (const pattern of DENIED_FORMATTING_PATTERNS) {
        if (text.includes(pattern)) violations.push(`${file}: ${pattern}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
