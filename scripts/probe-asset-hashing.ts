import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { sha256Bytes, sha256File } from '../src/main/fileHashing';

const MIB = 1024 * 1024;
const HEARTBEAT_MS = 5;

interface ProbeResult {
  source: 'buffer' | 'file';
  elapsedMs: number;
  maxEventLoopStallMs: number;
  heartbeatCount: number;
  throughputMiBPerSecond: number;
  sha256: string;
}

async function measure(
  source: ProbeResult['source'],
  sizeMiB: number,
  task: () => Promise<string>,
): Promise<ProbeResult> {
  let heartbeatCount = 0;
  let maxEventLoopStallMs = 0;
  let lastHeartbeatAt = performance.now();
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maxEventLoopStallMs = Math.max(maxEventLoopStallMs, now - lastHeartbeatAt - HEARTBEAT_MS);
    lastHeartbeatAt = now;
    heartbeatCount += 1;
  }, HEARTBEAT_MS);

  await new Promise<void>((resolve) => setImmediate(resolve));
  const startedAt = performance.now();
  try {
    const sha256 = await task();
    const elapsedMs = performance.now() - startedAt;
    await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS * 2));
    return {
      source,
      elapsedMs,
      maxEventLoopStallMs,
      heartbeatCount,
      throughputMiBPerSecond: sizeMiB / (elapsedMs / 1000),
      sha256,
    };
  } finally {
    clearInterval(heartbeat);
  }
}

async function main(): Promise<void> {
  const sizeMiB = Number(process.env.ASSET_HASH_PROBE_MIB ?? 512);
  if (!Number.isSafeInteger(sizeMiB) || sizeMiB <= 0) {
    throw new Error('ASSET_HASH_PROBE_MIB must be a positive integer.');
  }

  const bytes = Buffer.alloc(sizeMiB * MIB, 0x42);
  const root = await mkdtemp(join(tmpdir(), 'tenon-asset-hash-probe-'));
  const filePath = join(root, 'asset.bin');
  try {
    await writeFile(filePath, bytes);
    const results = [
      await measure('buffer', sizeMiB, () => sha256Bytes(bytes)),
      await measure('file', sizeMiB, () => sha256File(filePath)),
    ];
    console.log(JSON.stringify({ sizeMiB, heartbeatMs: HEARTBEAT_MS, results }, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
