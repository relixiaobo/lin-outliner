import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OutlineContractError, outlineError } from '../contract/errors';
import { OUTLINE_DEFAULT_STARTUP_TIMEOUT_MS } from '../contract/version';
import { OutlineClient } from './client';
import { readOutlineRuntimeDescriptor } from './descriptor';

export interface OutlineRuntimeLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly detached?: boolean;
}

export interface OutlineClientSupervisorOptions {
  readonly root: string;
  readonly noStart?: boolean;
  readonly startupTimeoutMs?: number;
  readonly launch?: OutlineRuntimeLaunch;
  readonly origin?: 'desktop' | 'local-user' | 'external-client' | 'built-in-agent';
  readonly agentAttestation?: string;
}

export class OutlineClientSupervisor {
  constructor(private readonly options: OutlineClientSupervisorOptions) {}

  async connect(): Promise<OutlineClient> {
    const existing = await this.tryConnect();
    if (existing) return existing;
    if (this.options.noStart) throw runtimeUnavailable('Outline Runtime is not running and automatic start is disabled.');
    this.launchRuntime();
    const deadline = Date.now() + Math.max(1, this.options.startupTimeoutMs ?? OUTLINE_DEFAULT_STARTUP_TIMEOUT_MS);
    let lastError: unknown;
    while (Date.now() < deadline) {
      await delay(25);
      try {
        const client = await this.tryConnect();
        if (client) return client;
      } catch (error) {
        lastError = error;
      }
    }
    throw runtimeUnavailable(
      'Outline Runtime did not become available before the startup timeout.',
      lastError,
    );
  }

  async status(): Promise<{ running: boolean; runtime?: unknown }> {
    const client = await this.tryConnect();
    if (!client) return { running: false };
    try {
      const response = await client.request('status', {});
      if (isRecord(response.data) && typeof response.data.running === 'boolean') {
        return response.data as { running: boolean; runtime?: unknown };
      }
      return { running: true, runtime: response.data };
    } finally {
      client.close();
    }
  }

  private async tryConnect(): Promise<OutlineClient | null> {
    const descriptor = await readOutlineRuntimeDescriptor(this.options.root);
    if (!descriptor) return null;
    const client = new OutlineClient(descriptor, {
      ...(this.options.origin ? { origin: this.options.origin } : {}),
      ...(this.options.agentAttestation ? { agentAttestation: this.options.agentAttestation } : {}),
    });
    try {
      await client.request('status', {});
      return client;
    } catch (error) {
      client.close();
      if (isUnavailableConnection(error)) return null;
      throw error;
    }
  }

  private launchRuntime(): void {
    const launch = this.options.launch ?? defaultLaunch(this.options.root);
    const child = spawn(launch.command, [...launch.args], {
      detached: launch.detached ?? true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ...launch.env,
      },
    });
    child.unref();
  }
}

function defaultLaunch(root: string): OutlineRuntimeLaunch {
  const entry = process.env.TENON_OUTLINE_RUNTIME_ENTRY
    ?? fileURLToPath(new URL('../runtime/server/entry.ts', import.meta.url));
  return {
    command: process.execPath,
    args: [entry, '--root', root],
  };
}

function runtimeUnavailable(message: string, detail?: unknown): OutlineContractError {
  return new OutlineContractError(outlineError(
    'runtime_unavailable',
    'unavailable',
    message,
    {
      retryable: true,
      ...(detail === undefined ? {} : {
        details: detail instanceof Error ? detail.message : String(detail),
      }),
    },
  ));
}

function isUnavailableConnection(error: unknown): boolean {
  if (error instanceof OutlineContractError && error.outlineError.code === 'runtime_unavailable') return true;
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
