import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ingestPptxAsMarkdown,
  type PptxIngestionBudgets,
} from '../../src/main/agent/capabilities/agentPptxIngestion';
import { buildStoredZip, pptxFixtureEntries, type StoredZipEntry } from '../helpers/pptxFixture';

describe('PPTX structural ingestion', () => {
  test('follows presentation order and extracts slide, note, and chart text', async () => {
    await withPptx(pptxFixtureEntries({
      firstSlideText: 'First target',
      secondSlideText: 'Displayed first',
      notesText: 'Speaker context',
      chartValues: ['North', '42'],
    }), async (filePath) => {
      const result = await ingestPptxAsMarkdown(filePath);

      expect(result.converter).toBe('pptx-structural');
      expect(result.totalSlides).toBe(2);
      expect(result.notesSlides).toBe(1);
      expect(result.chartCount).toBe(1);
      expect(result.slidesWithoutText).toEqual([]);
      expect(result.content.indexOf('Displayed first')).toBeLessThan(result.content.indexOf('First target'));
      expect(result.content).toContain('### Speaker notes\n\nSpeaker context');
      expect(result.content).toContain('### Chart 1\n\nNorth\n42');
      expect(result.content).toContain('Images, visual layout, animations, embedded files, and OCR are not included.');
    });
  });

  test('reports an empty-text slide without dropping its position', async () => {
    await withPptx(pptxFixtureEntries({ secondSlideText: null }), async (filePath) => {
      const result = await ingestPptxAsMarkdown(filePath);

      expect(result.totalSlides).toBe(2);
      expect(result.slidesWithoutText).toEqual([1]);
      expect(result.content).toContain('## Slide 1\n\n[No structured text found. This slide may contain only visual content.]');
      expect(result.content).toContain('## Slide 2\n\nFirst slide');
    });
  });

  test('ignores large media entries because budgets cover selected XML only', async () => {
    const media = new Uint8Array(2 * 1024 * 1024).fill(0xab);
    await withPptx(pptxFixtureEntries({
      extraEntries: [{ name: 'ppt/media/image1.png', data: media }],
    }), async (filePath) => {
      const result = await ingestPptxAsMarkdown(filePath, undefined, {
        maxPartBytes: 4_096,
        maxSelectedXmlBytes: 16_384,
      });

      expect(result.content).toContain('First slide');
    });
  });

  test('rejects non-ZIP and incomplete OOXML as invalid PPTX before converter discovery', async () => {
    await withRawFile(Buffer.from('not a zip'), async (filePath) => {
      await expect(ingestPptxAsMarkdown(filePath)).rejects.toMatchObject({ code: 'invalid_pptx' });
    });
    await withPptx([{ name: '[Content_Types].xml', data: '<Types />' }], async (filePath) => {
      await expect(ingestPptxAsMarkdown(filePath)).rejects.toMatchObject({ code: 'invalid_pptx' });
    });
  });

  test('enforces archive, part, total XML, slide, and elapsed-time budgets', async () => {
    const entries = pptxFixtureEntries({ secondSlideText: 'Second slide' });
    await withPptx(entries, async (filePath) => {
      await expectBudgetFailure(filePath, { maxArchiveEntries: 1 });
      await expectBudgetFailure(filePath, { maxPartBytes: 64 });
      await expectBudgetFailure(filePath, { maxSelectedXmlBytes: 256 });
      await expectBudgetFailure(filePath, { maxSlides: 1 });
      await expect(ingestPptxAsMarkdown(filePath, undefined, { timeoutMs: 0 })).rejects.toMatchObject({
        code: 'pptx_timeout',
      });
    });
  });

  test('bounds final Markdown while retaining explicit truncation metadata', async () => {
    await withPptx(pptxFixtureEntries({ firstSlideText: 'x'.repeat(2_000) }), async (filePath) => {
      const result = await ingestPptxAsMarkdown(filePath, undefined, { maxOutputChars: 300 });

      expect(result.truncated).toBe(true);
      expect(result.contentChars).toBeGreaterThan(300);
      expect(result.content).toEndWith('[PPTX structural text output truncated]');
      expect(result.content.length).toBeLessThan(400);
    });
  });

  test('propagates cancellation instead of converting it to an invalid-file error', async () => {
    await withPptx(pptxFixtureEntries(), async (filePath) => {
      const controller = new AbortController();
      controller.abort();
      await expect(ingestPptxAsMarkdown(filePath, controller.signal)).rejects.toMatchObject({
        name: 'AbortError',
      });
    });
  });
});

async function expectBudgetFailure(filePath: string, budgets: Partial<PptxIngestionBudgets>): Promise<void> {
  await expect(ingestPptxAsMarkdown(filePath, undefined, budgets)).rejects.toMatchObject({
    code: 'pptx_budget_exceeded',
  });
}

async function withPptx(entries: StoredZipEntry[], fn: (filePath: string) => Promise<void>): Promise<void> {
  await withRawFile(buildStoredZip(entries), fn);
}

async function withRawFile(data: Uint8Array, fn: (filePath: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'lin-pptx-ingestion-'));
  const filePath = path.join(root, 'fixture.pptx');
  try {
    await writeFile(filePath, data);
    await fn(filePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
