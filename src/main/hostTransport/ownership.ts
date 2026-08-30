import type {
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  Protocol,
} from 'electron';

export interface TransportOwner {
  readonly name: string;
  readonly disposed: boolean;
  dispose(): void;
}

type Release = () => void;

export class RegistrationOwner implements TransportOwner {
  readonly name: string;
  private releases: Release[] = [];
  private isDisposed = false;

  constructor(name: string) {
    this.name = name;
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  add(release: Release): void {
    if (this.isDisposed) throw new Error(`Transport owner ${this.name} is already disposed.`);
    this.releases.push(release);
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    const failures: unknown[] = [];
    for (const release of this.releases.reverse()) {
      try {
        release();
      } catch (error) {
        failures.push(error);
      }
    }
    this.releases = [];
    if (failures.length > 0) {
      throw new AggregateError(failures, `Transport owner ${this.name} failed to dispose cleanly.`);
    }
  }
}

export function createTransportOwner(
  name: string,
  register: (owner: RegistrationOwner) => void,
): RegistrationOwner {
  const owner = new RegistrationOwner(name);
  try {
    register(owner);
    return owner;
  } catch (error) {
    try {
      owner.dispose();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Transport owner ${name} failed during registration and rollback.`,
      );
    }
    throw error;
  }
}

export function disposeTransportOwners(name: string, owners: readonly (TransportOwner | null)[]): void {
  const failures: unknown[] = [];
  for (const owner of owners) {
    if (!owner) continue;
    try {
      owner.dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Transport owner set ${name} failed to dispose cleanly.`);
  }
}

type IpcRegistrationTarget = Pick<IpcMain, 'handle' | 'on' | 'removeHandler' | 'removeListener'>;
type ProtocolRegistrationTarget = Pick<Protocol, 'handle' | 'unhandle'>;

export type OwnedIpcMain = Pick<IpcMain, 'handle' | 'on'>;
export type OwnedProtocol = Pick<Protocol, 'handle'>;

export interface HostTransportTargets {
  readonly ipcMain: IpcRegistrationTarget;
  readonly protocol: ProtocolRegistrationTarget;
}

export class HostTransportComposition implements TransportOwner {
  readonly name: string;
  private readonly targets: HostTransportTargets;
  private readonly owners: RegistrationOwner[] = [];
  private readonly claims = new Map<string, string>();
  private isDisposed = false;

  constructor(name: string, targets: HostTransportTargets) {
    this.name = name;
    this.targets = targets;
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  registerOwner(name: string, register: (owner: RegistrationOwner) => void): void {
    this.assertOpen();
    const owner = createTransportOwner(name, register);
    this.owners.push(owner);
  }

  registerIpcOwner(name: string, register: (ipc: OwnedIpcMain) => void): void {
    this.registerOwner(name, (owner) => {
      const handle = ((channel: string, listener: (
        event: IpcMainInvokeEvent,
        ...args: unknown[]
      ) => unknown) => {
        const releaseClaim = this.claim(`ipc:${channel}`, name);
        try {
          this.targets.ipcMain.handle(channel, listener);
        } catch (error) {
          releaseClaim();
          throw error;
        }
        owner.add(() => {
          try {
            this.targets.ipcMain.removeHandler(channel);
          } finally {
            releaseClaim();
          }
        });
      }) as IpcMain['handle'];

      const on = ((channel: string, listener: (
        event: IpcMainEvent,
        ...args: unknown[]
      ) => void) => {
        const releaseClaim = this.claim(`ipc:${channel}`, name);
        try {
          this.targets.ipcMain.on(channel, listener);
        } catch (error) {
          releaseClaim();
          throw error;
        }
        owner.add(() => {
          try {
            this.targets.ipcMain.removeListener(channel, listener);
          } finally {
            releaseClaim();
          }
        });
        return this.targets.ipcMain;
      }) as IpcMain['on'];

      register({ handle, on });
    });
  }

  registerProtocolOwner(name: string, register: (protocol: OwnedProtocol) => void): void {
    this.registerOwner(name, (owner) => {
      const handle = ((scheme: string, handler: Parameters<Protocol['handle']>[1]) => {
        const releaseClaim = this.claim(`protocol:${scheme}`, name);
        try {
          this.targets.protocol.handle(scheme, handler);
        } catch (error) {
          releaseClaim();
          throw error;
        }
        owner.add(() => {
          try {
            this.targets.protocol.unhandle(scheme);
          } finally {
            releaseClaim();
          }
        });
      }) as Protocol['handle'];
      register({ handle });
    });
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    const failures: unknown[] = [];
    for (const owner of this.owners.reverse()) {
      try {
        owner.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    this.owners.length = 0;
    if (failures.length > 0) {
      throw new AggregateError(failures, `Transport composition ${this.name} failed to dispose cleanly.`);
    }
  }

  private assertOpen(): void {
    if (this.isDisposed) throw new Error(`Transport composition ${this.name} is already disposed.`);
  }

  private claim(key: string, owner: string): Release {
    const existing = this.claims.get(key);
    if (existing) throw new Error(`${key} is already owned by ${existing}; ${owner} cannot register it.`);
    this.claims.set(key, owner);
    return () => {
      if (this.claims.get(key) === owner) this.claims.delete(key);
    };
  }
}
