import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
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

interface ImportApiServerOptions {
  userDataDir: string;
  descriptorFileName?: string;
}

const IMPORT_API_DIR = 'import-api';
const IMPORT_API_SOCKET = 'tenon-import.sock';
const IMPORT_API_DESCRIPTOR = 'tenon-import-api.json';
const MAX_API_BODY_BYTES = 55 * 1024 * 1024;

export class AgentImportApiServer {
  private server: Server | null = null;
  private descriptor: ImportApiDescriptor | null = null;
  private descriptorPathValue: string;

  constructor(
    private readonly service: AgentImportService,
    private readonly options: ImportApiServerOptions,
  ) {
    this.descriptorPathValue = path.join(
      options.userDataDir,
      IMPORT_API_DIR,
      options.descriptorFileName ?? IMPORT_API_DESCRIPTOR,
    );
  }

  get descriptorPath(): string {
    return this.descriptorPathValue;
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
        const data = await this.service.commitFromContent({ ...input, ...(previewId ? { previewId } : {}) });
        writeApiResponse(response, 200, { ok: true, data });
        return;
      }
      writeApiResponse(response, 404, { ok: false, error: { code: 'not_found', message: 'Unknown import API endpoint.' } });
    } catch (error) {
      writeApiResponse(response, 200, normalizeImportApiError(error));
    }
  }
}

function normalizePackBody(body: unknown): {
  packContent: string;
  packLabel?: string;
  parentId?: string;
  mode?: 'stage';
} {
  const value = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const packContent = typeof value.packContent === 'string' ? value.packContent : '';
  if (!packContent.trim()) throw new ImportServiceFailure('invalid_args', 'packContent is required.');
  const packLabel = typeof value.packLabel === 'string' && value.packLabel.trim() ? value.packLabel.trim() : undefined;
  const parentId = typeof value.parentId === 'string' && value.parentId.trim() ? value.parentId.trim() : undefined;
  const mode = value.mode === undefined ? undefined : value.mode;
  if (mode !== undefined && mode !== 'stage') throw new ImportServiceFailure('invalid_args', 'mode must be "stage".');
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
