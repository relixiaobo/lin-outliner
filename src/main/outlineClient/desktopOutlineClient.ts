import { OutlineContractError, outlineError } from '../../outline/contract/errors';
import type {
  OutlineResponse,
  OutlineStreamRecord,
  WatchRequest,
} from '../../outline/contract/schemas';
import { OUTLINE_PROTOCOL_VERSION } from '../../outline/contract/version';

export interface DesktopOutlineTransportClient {
  requestResponse(command: string, input: unknown, signal?: AbortSignal): Promise<OutlineResponse>;
  watch(input: WatchRequest, signal?: AbortSignal): AsyncGenerator<OutlineStreamRecord>;
  close(): void;
}

export interface DesktopOutlineClientOptions {
  readonly connect: () => Promise<DesktopOutlineTransportClient>;
}

interface ActiveOperation {
  readonly ownerId: number;
  readonly controller: AbortController;
}

export class DesktopOutlineClient {
  private client: DesktopOutlineTransportClient | null = null;
  private connecting: Promise<DesktopOutlineTransportClient> | null = null;
  private readonly requests = new Map<string, ActiveOperation>();
  private readonly subscriptions = new Map<string, ActiveOperation>();

  constructor(private readonly options: DesktopOutlineClientOptions) {}

  async request(
    ownerId: number,
    requestId: string,
    command: string,
    input: unknown,
  ): Promise<OutlineResponse> {
    const key = operationKey(ownerId, requestId);
    if (this.requests.has(key)) throw new Error(`Desktop Outline request is already active: ${requestId}`);
    const controller = new AbortController();
    this.requests.set(key, { ownerId, controller });
    try {
      const client = await this.connect();
      return await client.requestResponse(command, input, controller.signal);
    } catch (error) {
      this.invalidateClientAfterTransportFailure(error);
      throw error;
    } finally {
      this.requests.delete(key);
    }
  }

  subscribe(
    ownerId: number,
    subscriptionId: string,
    input: WatchRequest,
    emit: (record: OutlineStreamRecord) => void,
  ): void {
    const key = operationKey(ownerId, subscriptionId);
    if (this.subscriptions.has(key)) {
      throw new Error(`Desktop Outline subscription is already active: ${subscriptionId}`);
    }
    const controller = new AbortController();
    this.subscriptions.set(key, { ownerId, controller });
    void this.runSubscription(key, subscriptionId, input, controller, emit);
  }

  cancel(ownerId: number, operationId: string): void {
    const key = operationKey(ownerId, operationId);
    this.requests.get(key)?.controller.abort();
    this.subscriptions.get(key)?.controller.abort();
  }

  releaseOwner(ownerId: number): void {
    for (const operation of [...this.requests.values(), ...this.subscriptions.values()]) {
      if (operation.ownerId === ownerId) operation.controller.abort();
    }
  }

  close(): void {
    for (const operation of [...this.requests.values(), ...this.subscriptions.values()]) {
      operation.controller.abort();
    }
    this.requests.clear();
    this.subscriptions.clear();
    this.connecting = null;
    this.client?.close();
    this.client = null;
  }

  private async connect(): Promise<DesktopOutlineTransportClient> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = this.options.connect().then((client) => {
        this.client = client;
        return client;
      }).finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async runSubscription(
    key: string,
    subscriptionId: string,
    input: WatchRequest,
    controller: AbortController,
    emit: (record: OutlineStreamRecord) => void,
  ): Promise<void> {
    try {
      const client = await this.connect();
      for await (const record of client.watch(input, controller.signal)) emit(record);
    } catch (error) {
      if (!controller.signal.aborted) {
        this.invalidateClientAfterTransportFailure(error);
        emit(streamErrorRecord(subscriptionId, error));
      }
    } finally {
      this.subscriptions.delete(key);
    }
  }

  private invalidateClientAfterTransportFailure(error: unknown): void {
    if (error instanceof OutlineContractError) return;
    this.client?.close();
    this.client = null;
  }
}

function streamErrorRecord(subscriptionId: string, error: unknown): OutlineStreamRecord {
  return {
    protocolVersion: OUTLINE_PROTOCOL_VERSION,
    requestId: `desktop:${subscriptionId}`,
    sequence: 0,
    type: 'error',
    error: error instanceof OutlineContractError
      ? error.outlineError
      : outlineError(
          'runtime_unavailable',
          'unavailable',
          'The desktop lost its connection to Outline Runtime.',
          {
            retryable: true,
            details: error instanceof Error ? error.message : String(error),
          },
        ),
  } as unknown as OutlineStreamRecord;
}

function operationKey(ownerId: number, operationId: string): string {
  return `${ownerId}:${operationId}`;
}
