import { Lexer } from 'marked';
import remend from 'remend';
import {
  createStreamingMarkdownBlockParser,
  splitMarkdownBlocks,
} from '../src/renderer/agent/components/ThreadMarkdown';
import { repairStreamingMarkdown } from '../src/renderer/agent/streamingMarkdownRepair';

const TARGET_BYTES = [2_500, 10_000, 20_000, 40_000] as const;
const SAMPLE_COUNT = 7;

interface ProbeRow {
  readonly adapterMs: number;
  readonly appendBytes: number;
  readonly bytes: number;
  readonly canonicalMs: number;
  readonly parserCommitMs: number;
  readonly repairSpeedup: number;
}

const rows = TARGET_BYTES.map(probeSize);
console.table(rows);

function probeSize(targetBytes: number): ProbeRow {
  const parts = buildFixture(targetBytes);
  const appended = parts.at(-1)!;
  const before = parts.slice(0, -1).join('');
  const source = before + appended;
  const canonical = remend(source);
  const repaired = repairStreamingMarkdown(source);
  if (repaired !== canonical) {
    throw new Error(`Repair mismatch at ${source.length} bytes`);
  }

  const expectedBlocks = splitMarkdownBlocks(canonical);
  const parser = createStreamingMarkdownBlockParser();
  parser.parse(before);
  const actualBlocks = parser.parse(source);
  if (JSON.stringify(actualBlocks) !== JSON.stringify(expectedBlocks)) {
    throw new Error(`Parser mismatch at ${source.length} bytes`);
  }

  remend(source);
  repairStreamingMarkdown(source);
  Lexer.lex(canonical);

  Bun.gc(true);
  const adapterMs = medianDurationMs(() => repairStreamingMarkdown(source));
  const warmedParsers = Array.from({ length: SAMPLE_COUNT }, () => {
    const warmed = createStreamingMarkdownBlockParser();
    warmed.parse(before);
    return warmed;
  });
  Bun.gc(true);
  const parserCommitMs = median(warmedParsers.map((sampleParser) => {
    const startedAt = performance.now();
    sampleParser.parse(source);
    return performance.now() - startedAt;
  }));
  Bun.gc(true);
  const canonicalMs = medianDurationMs(() => remend(source));

  return {
    adapterMs: roundMs(adapterMs),
    appendBytes: appended.length,
    bytes: source.length,
    canonicalMs: roundMs(canonicalMs),
    parserCommitMs: roundMs(parserCommitMs),
    repairSpeedup: roundMs(canonicalMs / adapterMs),
  };
}

function buildFixture(targetBytes: number): string[] {
  const parts: string[] = [];
  let size = 0;
  let index = 0;
  while (size < targetBytes) {
    const part = `Paragraph ${index} compares *streamed emphasis* with $5 and _another marker_ safely.\n\n`;
    parts.push(part);
    size += part.length;
    index += 1;
  }
  return parts;
}

function medianDurationMs(run: () => unknown): number {
  const samples: number[] = [];
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const startedAt = performance.now();
    run();
    samples.push(performance.now() - startedAt);
  }
  return median(samples);
}

function median(samples: number[]): number {
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)]!;
}

function roundMs(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
