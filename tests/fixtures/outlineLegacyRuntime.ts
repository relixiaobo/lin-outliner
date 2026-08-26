#!/usr/bin/env node
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  OutlineRuntimeLock,
  ensurePrivateDirectory,
  resolveOutlineRuntimePaths,
  writePrivateJson,
} from '../../src/outline/runtime/server/runtimePaths';

const root = argumentValue('--root');
const contractDigest = argumentValue('--contract-digest');
if (!root || !contractDigest || !/^[a-f0-9]{64}$/.test(contractDigest)) {
  process.stderr.write('outline-legacy-runtime: --root and --contract-digest are required\n');
  process.exit(2);
}

const paths = resolveOutlineRuntimePaths(root);
const instanceId = `runtime:legacy-${randomUUID()}`;
const createdAt = new Date().toISOString();
const lock = await OutlineRuntimeLock.acquire(paths, { pid: process.pid, instanceId, createdAt });
if (!lock) process.exit(0);

const descriptor = {
  descriptorVersion: 1 as const,
  transport: 'unix-http' as const,
  socketPath: paths.socketPath,
  bearerToken: randomBytes(32).toString('hex'),
  pid: process.pid,
  instanceId,
  protocolMajors: [1] as [1],
  contractDigest,
  runtimeVersion: 'legacy-test',
  storageVersion: 1 as const,
  createdAt,
};

await ensurePrivateDirectory(paths.root);
await ensurePrivateDirectory(path.dirname(paths.socketPath));
await rm(paths.socketPath, { force: true });
const server = http.createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${descriptor.bearerToken}`) {
    writeJson(response, 401, { error: { code: 'unauthorized' } });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/request') {
    writeJson(response, 404, { error: { code: 'not_found' } });
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { requestId?: unknown; command?: unknown };
  writeJson(response, 200, {
    protocolVersion: 1,
    requestId: body.requestId,
    ok: true,
    command: body.command,
    revision: 0,
    data: {
      running: true,
      runtime: { instanceId, contractDigest },
    },
  });
});

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(paths.socketPath, resolve);
});
await chmod(paths.socketPath, 0o600);
await writePrivateJson(paths.descriptorPath, descriptor);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(paths.descriptorPath, { force: true });
  await rm(paths.socketPath, { force: true });
  await lock.release();
  process.exit(0);
};
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function writeJson(response: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    connection: 'close',
  });
  response.end(body);
}
