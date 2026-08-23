import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentMutationCausation } from '../../../core/agent/protocol';
import { TENON_IMPORT_CAUSATION_TOKEN_HEADER } from '../../tenonImportProtocol';
import { AgentImportService, ImportServiceFailure, type ImportServiceResult } from './agentImportService';
import { LocalToolFailure } from './agentLocalTools';
import { errorMessage } from './agentNodeToolUtils';

export interface ImportApiDescriptor {
  version: 1;
  transport: 'unix-socket';
  socketPath: string;
  token: string;
}

export interface ImportApiResponse {
  ok: boolean;
  data?: ImportServiceResult;
  error?: {
    code: string;
    message: string;
    instructions?: string;
  };
  warnings?: readonly string[];
}

export interface ImportApiServerOptions {
  userDataDir: string;
  descriptorFileName?: string;
  now?: () => number;
  causationTokenTtlMs?: number;
  maxCausationTokens?: number;
}

interface ImportCausationTokenRecord {
  readonly causation: AgentMutationCausation;
  readonly expiresAt: number;
}

const IMPORT_API_DIR = 'import-api';
const IMPORT_API_SOCKET = 'tenon-import.sock';
const IMPORT_API_DESCRIPTOR = 'tenon-import-api.json';
const MAX_API_BODY_BYTES = 55 * 1024 * 1024;
export const IMPORT_CAUSATION_TOKEN_TTL_MS = 60_000;
const MAX_IMPORT_CAUSATION_TOKENS = 256;

export class AgentImportApiServer {
  private server: Server | null = null;
  private descriptor: ImportApiDescriptor | null = null;
  private descriptorPathValue: string;
  private readonly causationTokens = new Map<string, ImportCausationTokenRecord>();
  private readonly now: () => number;
  private readonly causationTokenTtlMs: number;
  private readonly maxCausationTokens: number;

  constructor(
    private readonly service: AgentImportService,
    private readonly options: ImportApiServerOptions,
  ) {
    this.descriptorPathValue = path.join(
      options.userDataDir,
      IMPORT_API_DIR,
      options.descriptorFileName ?? IMPORT_API_DESCRIPTOR,
    );
    this.now = options.now ?? Date.now;
    this.causationTokenTtlMs = positiveSafeInteger(
      options.causationTokenTtlMs ?? IMPORT_CAUSATION_TOKEN_TTL_MS,
      'causationTokenTtlMs',
    );
    this.maxCausationTokens = positiveSafeInteger(
      options.maxCausationTokens ?? MAX_IMPORT_CAUSATION_TOKENS,
      'maxCausationTokens',
    );
  }

  get descriptorPath(): string {
    return this.descriptorPathValue;
  }

  issueCausationToken(causation: AgentMutationCausation): string {
    this.deleteExpiredCausationTokens();
    const token = randomUUID();
    this.causationTokens.set(token, {
      causation: { ...causation },
      expiresAt: this.now() + this.causationTokenTtlMs,
    });
    while (this.causationTokens.size > this.maxCausationTokens) {
      const oldest = this.causationTokens.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.causationTokens.delete(oldest);
    }
    return token;
  }

  async start(): Promise<ImportApiDescriptor> {
    if (this.descriptor) return this.descriptor;
    const apiDir = path.dirname(this.descriptorPathValue);
    await mkdir(apiDir, { recursive: true });
    const socketPath = path.join(apiDir, IMPORT_API_SOCKET);
    await rm(socketPath, { force: true });
    const token = randomUUID();
    const server = createServer((request, response) => {
      void this.handleRequest(request, response, token);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.descriptor = { version: 1, transport: 'unix-socket', socketPath, token };
    await writeFile(this.descriptorPathValue, `${JSON.stringify(this.descriptor, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(this.descriptorPathValue, 0o600).catch(() => undefined);
    await chmod(socketPath, 0o600).catch(() => undefined);
    return this.descriptor;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.descriptor = null;
    this.causationTokens.clear();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(this.descriptorPathValue, { force: true }).catch(() => undefined);
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
    if (request.method !== 'POST') {
      writeApiResponse(response, 405, { ok: false, error: { code: 'method_not_allowed', message: 'Use POST.' } });
      return;
    }
    const auth = request.headers.authorization ?? '';
    if (auth !== `Bearer ${token}`) {
      writeApiResponse(response, 401, { ok: false, error: { code: 'unauthorized', message: 'Import API token is missing or invalid.' } });
      return;
    }

    let commitCausation: AgentMutationCausation | undefined;
    if (request.url === '/commit') {
      try {
        commitCausation = this.consumeCausationToken(request);
      } catch (error) {
        writeApiResponse(response, 200, normalizeImportApiError(error));
        return;
      }
    }

    let body: unknown;
    try {
      body = JSON.parse(await readRequestBody(request));
    } catch (error) {
      writeApiResponse(response, 400, normalizeImportApiError(error));
      return;
    }

    try {
      if (request.url === '/preview') {
        const input = normalizePackBody(body);
        const data = await this.service.previewFromContent(input);
        writeApiResponse(response, 200, { ok: true, data });
        return;
      }
      if (request.url === '/commit') {
        const input = normalizePackBody(body);
        const previewId = typeof (body as { previewId?: unknown }).previewId === 'string'
          ? (body as { previewId: string }).previewId
          : undefined;
        const data = await this.service.commitFromContent({
          ...input,
          ...(previewId ? { previewId } : {}),
          causation: commitCausation!,
        });
        if (data.status === 'staged_with_errors' || data.status === 'imported_daily_with_errors') {
          writeApiResponse(response, 200, {
            ok: false,
            data,
            error: {
              code: 'verification_failed',
              message: 'Import completed, but post-import verification found mismatched counts.',
              instructions: 'Stop without retrying or manually deleting nodes. Report the created roots and operation id so the parent Agent can inspect or request an exact undo.',
            },
          });
          return;
        }
        writeApiResponse(response, 200, { ok: true, data });
        return;
      }
      writeApiResponse(response, 404, { ok: false, error: { code: 'not_found', message: 'Unknown import API endpoint.' } });
    } catch (error) {
      writeApiResponse(response, 200, normalizeImportApiError(error));
    }
  }

  private consumeCausationToken(request: IncomingMessage): AgentMutationCausation {
    const header = request.headers[TENON_IMPORT_CAUSATION_TOKEN_HEADER];
    if (typeof header !== 'string' || !header) {
      throw new ImportServiceFailure(
        'causation_token_required',
        'Import commit requires a causation token issued for the current Agent Item.',
      );
    }
    const record = this.causationTokens.get(header);
    if (!record) {
      throw new ImportServiceFailure(
        'causation_token_invalid',
        'Import commit causation token is invalid or has already been used.',
      );
    }
    this.causationTokens.delete(header);
    if (record.expiresAt <= this.now()) {
      throw new ImportServiceFailure(
        'causation_token_expired',
        'Import commit causation token has expired.',
      );
    }
    return record.causation;
  }

  private deleteExpiredCausationTokens(): void {
    const now = this.now();
    for (const [token, record] of this.causationTokens) {
      if (record.expiresAt <= now) this.causationTokens.delete(token);
    }
  }
}

function normalizePackBody(body: unknown): {
  packContent: string;
  packLabel?: string;
  parentId?: string;
  mode?: 'stage' | 'native_daily';
} {
  const value = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const rawCausationKey = [
    'causation',
    'threadId',
    'turnId',
    'itemId',
    'thread_id',
    'turn_id',
    'item_id',
  ].find((key) => value[key] !== undefined);
  if (rawCausationKey) {
    throw new ImportServiceFailure(
      'invalid_args',
      `Import API request bodies must not provide raw causation field "${rawCausationKey}".`,
    );
  }
  const packContent = typeof value.packContent === 'string' ? value.packContent : '';
  if (!packContent.trim()) throw new ImportServiceFailure('invalid_args', 'packContent is required.');
  const packLabel = typeof value.packLabel === 'string' && value.packLabel.trim() ? value.packLabel.trim() : undefined;
  const parentId = typeof value.parentId === 'string' && value.parentId.trim() ? value.parentId.trim() : undefined;
  const mode = value.mode === undefined ? undefined : value.mode;
  if (mode !== undefined && mode !== 'stage' && mode !== 'native_daily') {
    throw new ImportServiceFailure('invalid_args', 'mode must be "stage" or "native_daily".');
  }
  return {
    packContent,
    ...(packLabel ? { packLabel } : {}),
    ...(parentId ? { parentId } : {}),
    ...(mode ? { mode } : {}),
  };
}

function normalizeImportApiError(error: unknown): ImportApiResponse {
  if (error instanceof ImportServiceFailure) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        instructions: error.instructions,
      },
      data: error.data,
      warnings: error.warnings,
    };
  }
  if (error instanceof LocalToolFailure) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        instructions: error.instructions,
      },
    };
  }
  return {
    ok: false,
    error: {
      code: 'import_api_failed',
      message: errorMessage(error),
    },
  };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  let body = '';
  let bytes = 0;
  request.setEncoding('utf8');
  for await (const chunk of request) {
    const text = String(chunk);
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_API_BODY_BYTES) throw new ImportServiceFailure('request_too_large', 'Import API request body is too large.');
    body += text;
  }
  return body;
}

function writeApiResponse(response: ServerResponse, statusCode: number, body: ImportApiResponse): void {
  const text = `${JSON.stringify(body)}\n`;
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

function positiveSafeInteger(value: number, optionName: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${optionName} must be a positive safe integer.`);
  }
  return value;
}
