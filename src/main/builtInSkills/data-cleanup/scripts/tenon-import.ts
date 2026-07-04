#!/usr/bin/env bun
import { request as httpRequest } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateImportPack } from '../../../agentDataImportPack';
import { errorMessage } from '../../../agentNodeToolUtils';
import {
  optionFlag,
  optionValue,
  readJson,
  requiredArg,
  writeJson,
  type ImportPack,
} from './import-pack-lib';
import { inspectSource } from './inspect-source';
import { renderPreview } from './import-pack-preview';
import { convertTanaExport, lastTanaPackCoverageEntries } from './tana-to-import-pack';

interface CliResult {
  ok: boolean;
  command?: string;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    instructions?: string;
  };
}

interface ImportApiDescriptor {
  version: 1;
  transport: 'unix-socket';
  socketPath: string;
  token: string;
}

interface ImportApiResponse {
  ok: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    instructions?: string;
  };
  warnings?: readonly string[];
}

const USAGE = [
  'Usage:',
  '  tenon-import inspect <source> --out <profile.json>',
  '  tenon-import tana <tana-export.json> --out <pack.json> --coverage-out <coverage.json> [--fidelity content|clean|full]',
  '  tenon-import validate <pack.json> [--out <report.json>]',
  '  tenon-import preview <pack.json> --out <preview.md> [--parent-id <node-id>] [--json] [--offline-preview]',
  '  tenon-import commit <pack.json> --preview-id <preview:id> [--parent-id <node-id>] [--json]',
].join('\n');

const API_DESCRIPTOR_ENV = 'TENON_IMPORT_API_DESCRIPTOR';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }

  switch (command) {
    case 'inspect':
      await writeResult({ ok: true, command, data: await runInspect(args) });
      return;
    case 'tana':
      await writeResult({ ok: true, command, data: await runTana(args) });
      return;
    case 'validate':
      await writeResult({ ok: true, command, data: await runValidate(args) });
      return;
    case 'preview':
      await writeResult({ ok: true, command, data: await runPreview(args) });
      return;
    case 'commit':
      await writeResult({ ok: true, command, data: await runCommit(args) });
      return;
    default:
      throw new CliFailure('invalid_command', `Unknown tenon-import command: ${command}`, USAGE);
  }
}

async function runInspect(args: string[]): Promise<unknown> {
  const source = requiredArg(args, 0, USAGE);
  const out = optionValue(args, '--out');
  if (!out) throw new CliFailure('invalid_args', '--out is required for inspect.', USAGE);
  const profile = await inspectSource(source);
  await writeJson(out, profile);
  return profile;
}

async function runTana(args: string[]): Promise<unknown> {
  const source = requiredArg(args, 0, USAGE);
  const out = optionValue(args, '--out');
  if (!out) throw new CliFailure('invalid_args', '--out is required for tana.', USAGE);
  const coverageOut = optionValue(args, '--coverage-out') ?? `${out.replace(/\.json$/u, '')}.coverage.json`;
  const fidelity = optionValue(args, '--fidelity') ?? 'clean';
  if (fidelity !== 'content' && fidelity !== 'clean' && fidelity !== 'full') {
    throw new CliFailure('invalid_args', '--fidelity must be content, clean, or full.');
  }
  const includeTrash = optionFlag(args, '--include-trash');
  const pack = await convertTanaExport(await readJson(source), {
    source,
    coverageOut,
    includeTrash,
    options: {
      fidelity,
      dateGrouping: 'stage_headings',
      tags: fidelity !== 'content',
      fields: fidelity === 'full' ? 'field_rows' : fidelity === 'clean' ? 'text_children' : 'omit',
      doneState: fidelity !== 'content',
    },
  });
  await writeJson(pack.coverage.entriesFile ?? coverageOut, lastTanaPackCoverageEntries());
  await writeJson(out, pack);
  return {
    out,
    coverageOut: pack.coverage.entriesFile,
    stats: pack.stats,
    warnings: pack.warnings,
  };
}

async function runValidate(args: string[]): Promise<unknown> {
  const packFile = requiredArg(args, 0, USAGE);
  const out = optionValue(args, '--out');
  const validation = validatePackContent(await readFile(packFile, 'utf8'));
  if (!validation.ok) {
    if (out) await writeJson(out, validation);
    throw new CliFailure(validation.code, validation.message);
  }
  const report = {
    ok: true,
    stats: validation.pack.stats,
    coverage: validation.pack.coverage,
    warnings: validation.pack.warnings,
  };
  if (out) await writeJson(out, report);
  return report;
}

async function runPreview(args: string[]): Promise<unknown> {
  const packFile = requiredArg(args, 0, USAGE);
  const out = optionValue(args, '--out');
  if (!out) throw new CliFailure('invalid_args', '--out is required for preview.', USAGE);
  const parentId = optionValue(args, '--parent-id');
  const offline = optionFlag(args, '--offline-preview');
  const packContent = await readFile(packFile, 'utf8');
  const validation = validatePackContent(packContent);
  if (!validation.ok) throw new CliFailure(validation.code, validation.message);

  const api = offline
    ? null
    : await callImportApi('/preview', {
      packContent,
      packLabel: path.resolve(packFile),
      ...(parentId ? { parentId } : {}),
    });
  const previewId = previewIdFromApi(api);
  await writePreviewFile(out, validation.pack, previewId);
  return {
    out,
    previewId,
    stats: validation.pack.stats,
    warnings: validation.pack.warnings,
    api: api?.data,
    offline,
  };
}

async function runCommit(args: string[]): Promise<unknown> {
  const packFile = requiredArg(args, 0, USAGE);
  const previewId = optionValue(args, '--preview-id');
  if (!previewId) throw new CliFailure('invalid_args', '--preview-id is required for commit.', USAGE);
  const parentId = optionValue(args, '--parent-id');
  const packContent = await readFile(packFile, 'utf8');
  const validation = validatePackContent(packContent);
  if (!validation.ok) throw new CliFailure(validation.code, validation.message);
  const api = await callImportApi('/commit', {
    packContent,
    packLabel: path.resolve(packFile),
    previewId,
    ...(parentId ? { parentId } : {}),
  });
  return api.data;
}

async function writePreviewFile(out: string, pack: ImportPack, previewId?: string): Promise<void> {
  const base = renderPreview(pack, 8);
  const lines = base.trimEnd().split('\n');
  if (previewId) {
    lines.splice(3, 0, `Preview id: ${previewId}`, '');
  }
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${lines.join('\n')}\n`, 'utf8');
}

function validatePackContent(packContent: string): (
  | { ok: true; pack: ImportPack; stats: ImportPack['stats']; warnings: ImportPack['warnings'] }
  | { ok: false; code: string; message: string }
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packContent);
  } catch (error) {
    return { ok: false, code: 'invalid_json', message: `Import Pack is not valid JSON: ${errorMessage(error)}` };
  }
  const validation = validateImportPack(parsed);
  if (!validation.ok) return { ok: false, code: validation.code, message: validation.message };
  return {
    ok: true,
    pack: validation.pack as unknown as ImportPack,
    stats: validation.pack.stats,
    warnings: validation.pack.warnings,
  };
}

async function callImportApi(pathname: '/preview' | '/commit', body: Record<string, unknown>): Promise<ImportApiResponse> {
  const descriptor = await readApiDescriptor();
  const payload = `${JSON.stringify(body)}\n`;
  const response = await new Promise<ImportApiResponse>((resolve, reject) => {
    const request = httpRequest({
      socketPath: descriptor.socketPath,
      path: pathname,
      method: 'POST',
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
      },
    }, (incoming) => {
      let text = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk: string) => {
        text += chunk;
      });
      incoming.on('end', () => {
        try {
          resolve(JSON.parse(text) as ImportApiResponse);
        } catch (error) {
          reject(new CliFailure('invalid_api_response', `Import API returned invalid JSON: ${errorMessage(error)}`));
        }
      });
    });
    request.once('error', (error) => {
      reject(new CliFailure('app_unavailable', `Tenon import API is unavailable: ${error.message}`, 'Open Tenon and retry the import command.'));
    });
    request.end(payload);
  });
  if (!response.ok) {
    throw new CliFailure(
      response.error?.code ?? 'import_api_failed',
      response.error?.message ?? 'Import API request failed.',
      response.error?.instructions,
      response,
    );
  }
  return response;
}

async function readApiDescriptor(): Promise<ImportApiDescriptor> {
  const descriptorPath = process.env[API_DESCRIPTOR_ENV];
  if (!descriptorPath) {
    throw new CliFailure('app_unavailable', `${API_DESCRIPTOR_ENV} is not set.`, 'Run tenon-import from a Tenon agent shell while the app is open.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(descriptorPath, 'utf8'));
  } catch (error) {
    throw new CliFailure('app_unavailable', `Cannot read Tenon import API descriptor: ${errorMessage(error)}`, 'Open Tenon and retry the import command.');
  }
  const descriptor = parsed && typeof parsed === 'object' ? parsed as Partial<ImportApiDescriptor> : {};
  if (descriptor.version !== 1 || descriptor.transport !== 'unix-socket' || !descriptor.socketPath || !descriptor.token) {
    throw new CliFailure('app_unavailable', 'Tenon import API descriptor is invalid.', 'Open Tenon and retry the import command.');
  }
  return descriptor as ImportApiDescriptor;
}

function previewIdFromApi(response: ImportApiResponse | null): string | undefined {
  const data = response?.data && typeof response.data === 'object' ? response.data as { previewId?: unknown } : {};
  return typeof data.previewId === 'string' ? data.previewId : undefined;
}

class CliFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly instructions?: string,
    readonly response?: ImportApiResponse,
  ) {
    super(message);
    this.name = 'CliFailure';
  }
}

async function writeResult(result: CliResult, exitCode = 0): Promise<void> {
  console.log(JSON.stringify(result, null, 2));
  if (exitCode !== 0) process.exitCode = exitCode;
}

main().catch(async (error) => {
  const result = error instanceof CliFailure
    ? {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        instructions: error.instructions,
      },
      data: error.response?.data,
      warnings: error.response?.warnings,
    }
    : {
      ok: false,
      error: {
        code: 'tenon_import_failed',
        message: errorMessage(error),
      },
    };
  await writeResult(result, 1);
});
