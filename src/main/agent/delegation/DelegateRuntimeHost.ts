import { createHash } from 'node:crypto';
import {
  canonicalDelegateArgv,
  decodeDelegateLaunchCapability,
  type DelegateStateCommand,
} from '../../../delegate/contract';
import type { DelegateCliRuntimeConfig } from '../../delegateRuntime';
import type { DelegateCommandRuntime } from '../capabilities/agentLocalTools';
import type { ToolTaskSchedulerLimits, ToolTaskSchedulingPolicy } from '../tasks/toolTaskTypes';
import {
  DelegateCapabilityBroker,
  type DelegateCapabilityAdmission,
  type DelegateCapabilityBrokerOptions,
  type DelegateCapabilityPolicyBinding,
  type DelegateCapabilitySessionBinding,
} from './DelegateCapabilityBroker';

export interface DelegateRuntimeAdmissionResolution {
  readonly rootUserIntentRevision: number | null;
  readonly policy: DelegateCapabilityPolicyBinding;
  readonly session: DelegateCapabilitySessionBinding;
}

export interface DelegateRuntimeHostOptions {
  readonly cli: DelegateCliRuntimeConfig;
  readonly socketPath: string;
  readonly currentConfigurationRevision: DelegateCapabilityBrokerOptions['currentConfigurationRevision'];
  readonly resolveAdmission: (
    input: Omit<DelegateCapabilityAdmission, 'policy' | 'session' | 'source'> & {
      readonly source: Omit<DelegateCapabilityAdmission['source'], 'rootUserIntentRevision'>;
    },
  ) => Promise<DelegateRuntimeAdmissionResolution>;
  readonly execute: DelegateCapabilityBrokerOptions['execute'];
}

export interface DelegateRuntimeScheduling {
  readonly scheduling: ToolTaskSchedulingPolicy;
  readonly schedulerLimits: ToolTaskSchedulerLimits;
  readonly timeoutMs: number;
}

const DELEGATE_CLI_ENV_KEYS = new Set([
  'COMSPEC',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TZ',
  'WINDIR',
]);

export class DelegateRuntimeHost {
  private readonly broker: DelegateCapabilityBroker;

  constructor(private readonly options: DelegateRuntimeHostOptions) {
    this.broker = new DelegateCapabilityBroker({
      socketPath: options.socketPath,
      currentConfigurationRevision: options.currentConfigurationRevision,
      execute: options.execute,
    });
  }

  async start(): Promise<void> {
    await this.broker.start();
  }

  async stop(): Promise<void> {
    await this.broker.stop();
  }

  commandRuntime(
    resolveScheduling: (
      input: { readonly command: DelegateStateCommand; readonly stdin?: string }
    ) => DelegateRuntimeScheduling | Promise<DelegateRuntimeScheduling>,
  ): DelegateCommandRuntime {
    return {
      resolveScheduling: async (input) => resolveScheduling(input),
      prepare: async (input) => {
        const directEnv = delegateCliProcessEnvironment(input.env, this.options.cli.runAsNode);
        const args = [this.options.cli.cliEntry, ...canonicalDelegateArgv(input.command)];
        const processSha256 = delegateProcessDigest({
          executable: this.options.cli.cliRuntime,
          args,
          cwd: input.cwd,
          env: directEnv,
        });
        const unresolved = {
          toolTaskId: input.taskId,
          toolTaskNonce: input.nonce,
          command: input.command,
          stdin: input.stdin,
          cwd: input.cwd,
          processSha256,
          source: {
            rootThreadId: input.ownerThreadId,
            sourceTurnId: input.sourceTurnId,
            sourceItemId: input.sourceItemId,
          },
        };
        const resolved = await this.options.resolveAdmission(unresolved);
        if (resolved.policy.configurationRevision !== input.scheduling.configurationRevision) {
          throw new Error('Delegation scheduling and capability configuration revisions do not match');
        }
        if (resolved.policy.schedulingPolicyDigest !== schedulingPolicyDigest(input.scheduling)) {
          throw new Error('Delegation scheduling and capability policy do not match');
        }
        const capability = this.broker.issue({
          ...unresolved,
          source: {
            ...unresolved.source,
            rootUserIntentRevision: resolved.rootUserIntentRevision,
          },
          policy: resolved.policy,
          session: resolved.session,
        });
        const capabilityId = decodeDelegateLaunchCapability(
          JSON.parse(capability.toString('utf8')) as unknown,
        ).capabilityId;
        return {
          process: {
            kind: 'exec',
            executable: this.options.cli.cliRuntime,
            args,
            env: directEnv,
            privateControl: true,
          },
          privateControlInput: capability,
          disposePrivateControl: () => this.broker.revoke(capabilityId),
        };
      },
    };
  }
}

export function schedulingPolicyDigest(scheduling: ToolTaskSchedulingPolicy): string {
  return createHash('sha256').update(JSON.stringify(scheduling)).digest('hex');
}

export function delegateProcessDigest(input: {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}): string {
  const environment = Object.entries(input.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256').update(JSON.stringify({
    executable: input.executable,
    args: input.args,
    cwd: input.cwd,
    env: environment,
  })).digest('hex');
}

export function delegateCliProcessEnvironment(
  source: NodeJS.ProcessEnv,
  runAsNode: boolean,
): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && DELEGATE_CLI_ENV_KEYS.has(key.toUpperCase())) env[key] = value;
  }
  if (runAsNode) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}
