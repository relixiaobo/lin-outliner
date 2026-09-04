import { createHash } from 'node:crypto';
import {
  canonicalDelegateArgv,
  type DelegateStateCommand,
} from '../../../delegate/contract';
import type { DelegateCliRuntimeConfig } from '../../delegateRuntime';
import type { DelegateCommandRuntime } from '../capabilities/agentLocalTools';
import type { ToolTaskSchedulingPolicy } from '../tasks/toolTaskTypes';
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

  commandRuntime(scheduling: ToolTaskSchedulingPolicy): DelegateCommandRuntime {
    return {
      scheduling,
      prepare: async (input) => {
        const directEnv: Readonly<Record<string, string>> = this.options.cli.runAsNode
          ? { ELECTRON_RUN_AS_NODE: '1' }
          : {};
        const args = [this.options.cli.cliEntry, ...canonicalDelegateArgv(input.command)];
        const finalEnv = directProcessEnvironment(input.env, directEnv);
        const processSha256 = delegateProcessDigest({
          executable: this.options.cli.cliRuntime,
          args,
          cwd: input.cwd,
          env: finalEnv,
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
        if (resolved.policy.configurationRevision !== scheduling.configurationRevision) {
          throw new Error('Delegation scheduling and capability configuration revisions do not match');
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
        return {
          process: {
            kind: 'exec',
            executable: this.options.cli.cliRuntime,
            args,
            env: directEnv,
            privateControl: true,
          },
          privateControlInput: capability,
        };
      },
    };
  }
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

function directProcessEnvironment(
  source: NodeJS.ProcessEnv,
  overlay: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const env = { ...source };
  delete env.ELECTRON_RUN_AS_NODE;
  return { ...env, ...overlay };
}
