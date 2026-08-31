export type ResourceDisposer = () => void | Promise<void>;

interface ResourceEntry {
  readonly name: string;
  readonly dispose: ResourceDisposer;
}

export class ResourceScope {
  private readonly entries: ResourceEntry[] = [];
  private disposal: Promise<void> | null = null;
  private accepting = true;

  constructor(readonly name: string) {}

  defer(name: string, dispose: ResourceDisposer): void {
    if (!this.accepting) {
      throw new Error(`Resource scope ${this.name} is already disposing; cannot add ${name}.`);
    }
    this.entries.push({ name, dispose });
  }

  child(name: string): ResourceScope {
    const child = new ResourceScope(`${this.name}/${name}`);
    this.defer(name, () => child.dispose());
    return child;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.accepting = false;
    this.disposal = this.disposeEntries();
    return this.disposal;
  }

  private async disposeEntries(): Promise<void> {
    const failures: Error[] = [];
    for (const entry of this.entries.reverse()) {
      try {
        await entry.dispose();
      } catch (error) {
        failures.push(new ResourceDisposalError(this.name, entry.name, error));
      }
    }
    this.entries.length = 0;
    if (failures.length > 0) {
      throw new AggregateError(failures, `Resource scope ${this.name} failed to dispose cleanly.`);
    }
  }
}

export class ResourceDisposalError extends Error {
  readonly cause: unknown;

  constructor(scope: string, resource: string, cause: unknown) {
    super(`Resource ${resource} in scope ${scope} failed to dispose.`);
    this.name = 'ResourceDisposalError';
    this.cause = cause;
  }
}
