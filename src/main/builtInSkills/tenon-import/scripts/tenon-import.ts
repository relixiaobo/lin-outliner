#!/usr/bin/env bun
import { request as httpRequest } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateImportPack } from '../../../agent/capabilities/agentDataImportPack';
import { errorMessage } from '../../../agent/capabilities/agentNodeToolUtils';
import {
  TENON_IMPORT_CAUSATION_TOKEN_ENV,
  TENON_IMPORT_CAUSATION_TOKEN_HEADER,
} from '../../../tenonImportProtocol';
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

type ImportMode = 'stage' | 'native_daily';

interface DailyPreviewSummary {
  dateSectionCount: number;
  dateCount: number;
  nonDateSectionCount: number;
  existingDateCount?: number;
  newDateCount?: number;
  firstDate?: string;
  lastDate?: string;
}

const USAGE = [
  'Usage:',
  '  tenon-import inspect <source> --out <profile.json>',
  '  tenon-import tana <tana-export.json> --out <pack.json> --coverage-out <coverage.json> [--fidelity content|clean|full]',
  '  tenon-import validate <pack.json> [--out <report.json>]',
  '  tenon-import preview <pack.json> --out <preview.md> [--mode stage|native_daily] [--parent-id <node-id>] [--json] [--offline-preview]',
  '  tenon-import commit <pack.json> --preview-id <preview:id> [--mode stage|native_daily] [--parent-id <node-id>] [--json]',
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
      dateGrouping: 'native_daily',
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
  const mode = importModeOption(args);
  const offline = optionFlag(args, '--offline-preview');
  const packContent = await readFile(packFile, 'utf8');
  const validation = validatePackContent(packContent);
  if (!validation.ok) throw new CliFailure(validation.code, validation.message);
  validateSelectedMode(mode, validation.pack);

  const api = offline
    ? null
    : await callImportApi('/preview', {
      packContent,
      packLabel: path.resolve(packFile),
      ...(parentId ? { parentId } : {}),
      ...(mode ? { mode } : {}),
    });
  const previewId = previewIdFromApi(api);
  const selectedMode = importModeFromApi(api) ?? mode ?? defaultImportMode(validation.pack);
  await writePreviewFile(out, validation.pack, previewId, selectedMode, api?.data);
  return {
    out,
    previewId,
    mode: selectedMode,
    stats: validation.pack.stats,
    warnings: warningsFromApi(api) ?? validation.pack.warnings,
    dailySummary: dailySummaryFromApi(api),
    api: api?.data,
    offline,
  };
}

async function runCommit(args: string[]): Promise<unknown> {
  assertCommitArgs(args);
  const packFile = requiredArg(args, 0, USAGE);
  const previewId = optionValue(args, '--preview-id');
  if (!previewId) throw new CliFailure('invalid_args', '--preview-id is required for commit.', USAGE);
  const parentId = optionValue(args, '--parent-id');
  const mode = importModeOption(args);
  const packContent = await readFile(packFile, 'utf8');
  const validation = validatePackContent(packContent);
  if (!validation.ok) throw new CliFailure(validation.code, validation.message);
  validateSelectedMode(mode, validation.pack);
  const api = await callImportApi('/commit', {
    packContent,
    packLabel: path.resolve(packFile),
    previewId,
    ...(parentId ? { parentId } : {}),
    ...(mode ? { mode } : {}),
  });
  return api.data;
}

function assertCommitArgs(args: string[]): void {
  const packFile = args[0];
  if (!packFile || packFile.startsWith('-')) {
    throw new CliFailure('invalid_args', 'commit requires one Import Pack path before its options.', USAGE);
  }
  const valueOptions = new Set(['--preview-id', '--parent-id', '--mode']);
  const flagOptions = new Set(['--json']);
  const seenOptions = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (valueOptions.has(argument)) {
      if (seenOptions.has(argument)) {
        throw new CliFailure('invalid_args', `Duplicate commit option: ${argument}`, USAGE);
      }
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new CliFailure('invalid_args', `${argument} requires a value.`, USAGE);
      }
      seenOptions.add(argument);
      index += 1;
      continue;
    }
    if (flagOptions.has(argument)) {
      if (seenOptions.has(argument)) {
        throw new CliFailure('invalid_args', `Duplicate commit option: ${argument}`, USAGE);
      }
      seenOptions.add(argument);
      continue;
    }
    throw new CliFailure('invalid_args', `Unexpected commit argument: ${argument}`, USAGE);
  }
}

async function writePreviewFile(
  out: string,
  pack: ImportPack,
  previewId: string | undefined,
  mode: ImportMode,
  apiData?: unknown,
): Promise<void> {
  const base = renderPreview(pack, 8);
  const lines = base.trimEnd().split('\n');
  const report = [`Mode: ${mode}`];
  if (previewId) report.push(`Preview id: ${previewId}`);
  if (mode === 'native_daily') {
    const summary = asDailySummary(apiData) ?? dailySummaryFromPack(pack);
    report.push(`Daily targets: ${summary.dateSectionCount} section(s) across ${summary.dateCount} date(s)`);
    if (summary.firstDate && summary.lastDate) report.push(`Date range: ${summary.firstDate} to ${summary.lastDate}`);
    if (summary.existingDateCount !== undefined && summary.newDateCount !== undefined) {
      report.push(`Canonical days: ${summary.existingDateCount} existing; ${summary.newDateCount} new`);
    }
    report.push(`Non-date sections staged: ${summary.nonDateSectionCount}`);
    report.push('Re-import behavior: append-only; repeated imports create another copy.');
  }
  lines.splice(3, 0, ...report, '');
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${lines.join('\n')}\n`, 'utf8');
}

function importModeOption(args: readonly string[]): ImportMode | undefined {
  if (!args.includes('--mode')) return undefined;
  const mode = optionValue([...args], '--mode');
  if (mode !== 'stage' && mode !== 'native_daily') {
    throw new CliFailure('invalid_args', '--mode must be stage or native_daily.', USAGE);
  }
  return mode;
}

function defaultImportMode(pack: ImportPack): ImportMode {
  return pack.options.dateGrouping === 'native_daily' && pack.sections.some((section) => section.kind === 'date')
    ? 'native_daily'
    : 'stage';
}

function validateSelectedMode(mode: ImportMode | undefined, pack: ImportPack): void {
  if (mode === 'native_daily' && !pack.sections.some((section) => section.kind === 'date')) {
    throw new CliFailure(
      'native_daily_requires_dates',
      'native_daily mode requires at least one validated date section.',
      'Use stage mode for packs without date sections.',
    );
  }
}

function importModeFromApi(response: ImportApiResponse | null): ImportMode | undefined {
  const data = asRecord(response?.data);
  return data.mode === 'stage' || data.mode === 'native_daily' ? data.mode : undefined;
}

function warningsFromApi(response: ImportApiResponse | null): ImportPack['warnings'] | undefined {
  const warnings = asRecord(response?.data).warnings;
  return Array.isArray(warnings) ? warnings as ImportPack['warnings'] : undefined;
}

function dailySummaryFromApi(response: ImportApiResponse | null): DailyPreviewSummary | undefined {
  return asDailySummary(response?.data);
}

function asDailySummary(value: unknown): DailyPreviewSummary | undefined {
  const summary = asRecord(asRecord(value).dailySummary);
  if (
    typeof summary.dateSectionCount !== 'number'
    || typeof summary.dateCount !== 'number'
    || typeof summary.nonDateSectionCount !== 'number'
    || (summary.existingDateCount !== undefined && typeof summary.existingDateCount !== 'number')
    || (summary.newDateCount !== undefined && typeof summary.newDateCount !== 'number')
    || (summary.firstDate !== undefined && typeof summary.firstDate !== 'string')
    || (summary.lastDate !== undefined && typeof summary.lastDate !== 'string')
  ) return undefined;
  return {
    dateSectionCount: summary.dateSectionCount,
    dateCount: summary.dateCount,
    nonDateSectionCount: summary.nonDateSectionCount,
    ...(typeof summary.existingDateCount === 'number' ? { existingDateCount: summary.existingDateCount } : {}),
    ...(typeof summary.newDateCount === 'number' ? { newDateCount: summary.newDateCount } : {}),
    ...(typeof summary.firstDate === 'string' ? { firstDate: summary.firstDate } : {}),
    ...(typeof summary.lastDate === 'string' ? { lastDate: summary.lastDate } : {}),
  };
}

function dailySummaryFromPack(pack: ImportPack): DailyPreviewSummary {
  const dateSections = pack.sections.filter((section) => section.kind === 'date' && section.date);
  const dates = [...new Set(dateSections.flatMap((section) => section.date ? [section.date] : []))].sort();
  return {
    dateSectionCount: dateSections.length,
    dateCount: dates.length,
    nonDateSectionCount: pack.sections.length - dateSections.length,
    ...(dates[0] ? { firstDate: dates[0] } : {}),
    ...(dates.at(-1) ? { lastDate: dates.at(-1) } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
  const causationToken = pathname === '/commit'
    ? process.env[TENON_IMPORT_CAUSATION_TOKEN_ENV]
    : undefined;
  const response = await new Promise<ImportApiResponse>((resolve, reject) => {
    const request = httpRequest({
      socketPath: descriptor.socketPath,
      path: pathname,
      method: 'POST',
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        ...(causationToken ? { [TENON_IMPORT_CAUSATION_TOKEN_HEADER]: causationToken } : {}),
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
