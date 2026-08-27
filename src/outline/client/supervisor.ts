import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OutlineContractError, outlineError } from '../contract/errors';
import { OUTLINE_DEFAULT_STARTUP_TIMEOUT_MS } from '../contract/version';
import { outlineCapabilityContractDigest } from '../contract/capabilities';
import { OutlineClient } from './client';
import {
  descriptorHasMatchingRuntimeOwner,
  readOutlineRuntimeDescriptor,
} from './descriptor';
import type { RuntimeDescriptor, RuntimeStatus } from '../contract/schemas';
import { acquireOutlineRuntimeRetirementClaim } from './retirement';

export interface OutlineRuntimeLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly detached?: boolean;
}

export interface OutlineClientSupervisorOptions {
  readonly root: string;
  readonly contentRoot?: string;
  readonly noStart?: boolean;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly launch?: OutlineRuntimeLaunch;
  readonly expectedDevelopmentSessionId?: string;
  readonly origin?: 'desktop' | 'local-user' | 'external-client' | 'built-in-agent';
  readonly agentAttestation?: string;
}

export class OutlineClientSupervisor {
  constructor(private readonly options: OutlineClientSupervisorOptions) {
    const value = options.expectedDevelopmentSessionId;
    if (value !== undefined && (value.length < 1 || value.length > 128)) {
      throw new RangeError('Expected Outline Runtime development session ID must contain between 1 and 128 characters.');
    }
  }

  async connect(signal?: AbortSignal): Promise<OutlineClient> {
    outlineCapabilityContractDigest();
    const timeoutMs = Math.max(1, this.options.startupTimeoutMs ?? OUTLINE_DEFAULT_STARTUP_TIMEOUT_MS);
    const deadline = Date.now() + timeoutMs;
    let existing: OutlineClient | null;
    try {
      existing = await this.tryConnectBefore(deadline, signal);
    } catch (error) {
      if (this.options.noStart
        || !isProtocolIncompatible(error)
        || !await this.retireMismatchedRuntime(deadline, signal)) throw error;
      existing = await this.tryConnectBefore(deadline, signal);
    }
    if (existing) return existing;
    if (this.options.noStart) throw runtimeUnavailable('Outline Runtime is not running and automatic start is disabled.');
    this.launchRuntime();
    let lastError: unknown;
    while (Date.now() < deadline) {
      await delay(25, signal);
      try {
        const client = await this.tryConnectBefore(deadline, signal);
        if (client) return client;
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof OutlineContractError) throw error;
        lastError = error;
      }
    }
    throw runtimeUnavailable(
      'Outline Runtime did not become available before the startup timeout.',
      lastError,
    );
  }

  async status(signal?: AbortSignal): Promise<RuntimeStatus> {
    outlineCapabilityContractDigest();
    const deadline = Date.now() + Math.max(
      1,
      this.options.startupTimeoutMs ?? OUTLINE_DEFAULT_STARTUP_TIMEOUT_MS,
    );
    const client = await this.tryConnectBefore(deadline, signal);
    if (!client) return { running: false };
    const probe = deadlineSignal(signal, Math.max(1, deadline - Date.now()));
    try {
      const response = await client.request('status', {}, probe.signal);
      if (isRecord(response.data) && typeof response.data.running === 'boolean') {
        assertLiveContractDigest(response.data);
        return response.data as RuntimeStatus;
      }
      throw new OutlineContractError(outlineError(
        'protocol_incompatible',
        'protocol',
        'Outline Runtime returned an invalid status result.',
      ));
    } catch (error) {
      if (probe.timedOut() && !signal?.aborted) {
        throw runtimeUnavailable('Outline Runtime status probe exceeded the startup timeout.', error);
      }
      throw error;
    } finally {
      probe.cleanup();
      client.close();
    }
  }

  private async tryConnectBefore(deadline: number, signal?: AbortSignal): Promise<OutlineClient | null> {
    const remaining = Math.max(1, deadline - Date.now());
    const probe = deadlineSignal(signal, remaining);
    try {
      return await this.tryConnect(probe.signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (probe.timedOut()) return null;
      throw error;
    } finally {
      probe.cleanup();
    }
  }

  private async tryConnect(signal?: AbortSignal): Promise<OutlineClient | null> {
    const descriptor = await readOutlineRuntimeDescriptor(this.options.root);
    if (!descriptor) return null;
    const expectedDigest = outlineCapabilityContractDigest();
    if (descriptor.contractDigest !== expectedDigest) {
      throw protocolIncompatible(
        'Bundled CLI contract does not match the Outline Runtime descriptor.',
        { expectedDigest, actualDigest: descriptor.contractDigest },
      );
    }
    const expectedDevelopmentSessionId = this.options.expectedDevelopmentSessionId;
    if (expectedDevelopmentSessionId
      && descriptor.developmentSessionId !== expectedDevelopmentSessionId) {
      throw protocolIncompatible(
        'The Outline Runtime belongs to a different development session.',
        {
          expectedDevelopmentSessionId,
          actualDevelopmentSessionId: descriptor.developmentSessionId,
        },
      );
    }
    const client = new OutlineClient(descriptor, {
      ...(this.options.origin ? { origin: this.options.origin } : {}),
      ...(this.options.agentAttestation ? { agentAttestation: this.options.agentAttestation } : {}),
      ...(this.options.requestTimeoutMs ? { requestTimeoutMs: this.options.requestTimeoutMs } : {}),
    });
    try {
      const response = await client.request('status', {}, signal);
      assertLiveContractDigest(response.data);
      return client;
    } catch (error) {
      client.close();
      if (isUnavailableConnection(error)) return null;
      throw error;
    }
  }

  private async retireMismatchedRuntime(deadline: number, signal?: AbortSignal): Promise<boolean> {
    const descriptor = await readOutlineRuntimeDescriptor(this.options.root);
    if (!descriptor) return true;
    const expectedDigest = outlineCapabilityContractDigest();
    const expectedDevelopmentSessionId = this.options.expectedDevelopmentSessionId;
    if (descriptor.contractDigest === expectedDigest
      && (!expectedDevelopmentSessionId
        || descriptor.developmentSessionId === expectedDevelopmentSessionId)) return false;
    if (!await descriptorHasMatchingRuntimeOwner(this.options.root, descriptor)) return false;

    const probe = deadlineSignal(signal, Math.max(1, deadline - Date.now()));
    const client = new OutlineClient(descriptor);
    try {
      const identity = await client.probeRuntimeIdentity(probe.signal);
      if (identity.instanceId !== descriptor.instanceId
        || identity.contractDigest !== descriptor.contractDigest
        || !await this.descriptorStillOwned(descriptor)) return false;

      const claim = await acquireOutlineRuntimeRetirementClaim(this.options.root, descriptor.instanceId);
      try {
        if (claim.owned) {
          await this.requestRuntimeRetirement(
            client,
            descriptor,
            expectedDigest,
            expectedDevelopmentSessionId,
            probe.signal,
          );
        }
        await this.waitForRuntimeRelease(descriptor, deadline, probe.signal);
        return true;
      } finally {
        await claim.release();
      }
    } catch (error) {
      if (probe.timedOut() && !signal?.aborted) {
        throw runtimeUnavailable('Outline Runtime replacement exceeded the startup timeout.', error);
      }
      throw error;
    } finally {
      probe.cleanup();
      client.close();
    }
  }

  private async requestRuntimeRetirement(
    client: OutlineClient,
    descriptor: RuntimeDescriptor,
    expectedDigest: string,
    expectedDevelopmentSessionId: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    let retirementRequested = false;
    try {
      retirementRequested = await client.requestRuntimeRetirement(
        descriptor.instanceId,
        {
          contractDigest: expectedDigest,
          ...(expectedDevelopmentSessionId ? {
            developmentSessionId: expectedDevelopmentSessionId,
          } : {}),
        },
        signal,
      );
    } catch (error) {
      const oldRuntimeCannotRetireSameContract = descriptor.contractDigest === expectedDigest
        && expectedDevelopmentSessionId !== undefined
        && isUnsupportedDevelopmentRetirement(error);
      if (!isUnavailableConnection(error) && !oldRuntimeCannotRetireSameContract) throw error;
    }
    if (!retirementRequested && await this.descriptorStillOwned(descriptor)) {
      try {
        process.kill(descriptor.pid, 'SIGTERM');
      } catch (error) {
        if (!isMissingProcess(error)) throw error;
      }
    }
  }

  private async waitForRuntimeRelease(
    descriptor: RuntimeDescriptor,
    deadline: number,
    signal: AbortSignal,
  ): Promise<void> {
    while (Date.now() < deadline) {
      const [current, ownerStillMatches] = await Promise.all([
        readOutlineRuntimeDescriptor(this.options.root),
        descriptorHasMatchingRuntimeOwner(this.options.root, descriptor),
      ]);
      if ((!current || current.instanceId !== descriptor.instanceId) && !ownerStillMatches) return;
      await delay(Math.min(25, Math.max(1, deadline - Date.now())), signal);
    }
    throw runtimeUnavailable(
      'The incompatible Outline Runtime did not retire before the startup timeout.',
      JSON.stringify({ pid: descriptor.pid, instanceId: descriptor.instanceId }),
    );
  }

  private async descriptorStillOwned(descriptor: RuntimeDescriptor): Promise<boolean> {
    const current = await readOutlineRuntimeDescriptor(this.options.root);
    return current !== null
      && sameRuntimeDescriptor(current, descriptor)
      && await descriptorHasMatchingRuntimeOwner(this.options.root, descriptor);
  }

  private launchRuntime(): void {
    if (!this.options.contentRoot) {
      throw runtimeUnavailable('Automatic Runtime start requires an explicit ContentStore root.');
    }
    const launch = this.options.launch ?? defaultLaunch(this.options.root, this.options.contentRoot);
    const child = spawn(launch.command, [...launch.args], {
      detached: launch.detached ?? true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        TENON_CONTENT_ROOT: this.options.contentRoot,
        ...launch.env,
        ...(this.options.expectedDevelopmentSessionId ? {
          TENON_OUTLINE_RUNTIME_DEVELOPMENT_SESSION_ID: this.options.expectedDevelopmentSessionId,
        } : {}),
      },
    });
    child.unref();
  }
}

function assertLiveContractDigest(value: unknown): void {
  const expectedDigest = outlineCapabilityContractDigest();
  const runtime = isRecord(value) && value.running === true && isRecord(value.runtime)
    ? value.runtime
    : undefined;
  const actualDigest = runtime?.contractDigest;
  if (actualDigest !== expectedDigest) {
    throw protocolIncompatible(
      'Bundled CLI contract does not match the connected Outline Runtime.',
      { expectedDigest, actualDigest },
    );
  }
}

function protocolIncompatible(message: string, details: unknown): OutlineContractError {
  return new OutlineContractError(outlineError(
    'protocol_incompatible',
    'protocol',
    message,
    { details },
  ));
}

function defaultLaunch(root: string, contentRoot: string): OutlineRuntimeLaunch {
  const entry = process.env.TENON_OUTLINE_RUNTIME_ENTRY
    ?? fileURLToPath(new URL('../runtime/server/entry.ts', import.meta.url));
  return {
    command: process.execPath,
    args: [entry, '--root', root, '--content-root', contentRoot],
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

function isProtocolIncompatible(error: unknown): boolean {
  return error instanceof OutlineContractError
    && error.outlineError.code === 'protocol_incompatible';
}

function isUnsupportedDevelopmentRetirement(error: unknown): boolean {
  return error instanceof OutlineContractError
    && (error.outlineError.code === 'invalid_input'
      || error.outlineError.code === 'protocol_incompatible');
}

function isMissingProcess(error: unknown): boolean {
  return isRecord(error) && error.code === 'ESRCH';
}

function sameRuntimeDescriptor(left: RuntimeDescriptor, right: RuntimeDescriptor): boolean {
  return left.pid === right.pid
    && left.instanceId === right.instanceId
    && left.createdAt === right.createdAt
    && left.socketPath === right.socketPath
    && left.bearerToken === right.bearerToken
    && left.contractDigest === right.contractDigest
    && left.runtimeVersion === right.runtimeVersion
    && left.developmentSessionId === right.developmentSessionId
    && left.storageVersion === right.storageVersion;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new Error('Outline Runtime connection was aborted.'));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

function deadlineSignal(signal: AbortSignal | undefined, timeoutMs: number): {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Outline Runtime attach probe exceeded ${timeoutMs} ms.`));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
