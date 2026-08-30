import { describe, expect, test } from 'bun:test';
import type { IpcMain, Protocol } from 'electron';
import { registerDesktopOutlineIpc } from '../../src/main/outlineClient';
import type { DesktopOutlineClient } from '../../src/main/outlineClient';
import {
  OUTLINE_DESKTOP_CANCEL_CHANNEL,
  OUTLINE_DESKTOP_COMMIT_CHANNEL,
  OUTLINE_DESKTOP_REQUEST_CHANNEL,
  OUTLINE_DESKTOP_SUBSCRIBE_CHANNEL,
  OUTLINE_DESKTOP_UNSUBSCRIBE_CHANNEL,
} from '../../src/main/outlineClient/protocol';
import {
  HostTransportComposition,
  RegistrationOwner,
  createTransportOwner,
  disposeTransportOwners,
} from '../../src/main/hostTransport/ownership';

interface TargetFixture {
  readonly target: ConstructorParameters<typeof HostTransportComposition>[1];
  readonly handlers: Map<string, (...args: unknown[]) => unknown>;
  readonly listeners: Map<string, (...args: unknown[]) => unknown>;
  readonly protocols: Map<string, (...args: unknown[]) => unknown>;
  readonly releases: string[];
}

function targetFixture(options: { failHandle?: string; failRelease?: string } = {}): TargetFixture {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const protocols = new Map<string, (...args: unknown[]) => unknown>();
  const releases: string[] = [];
  const ipcMain = {
    handle(channel: string, listener: (...args: unknown[]) => unknown) {
      if (channel === options.failHandle) throw new Error(`register:${channel}`);
      handlers.set(channel, listener);
    },
    on(channel: string, listener: (...args: unknown[]) => unknown) {
      listeners.set(channel, listener);
      return ipcMain;
    },
    removeHandler(channel: string) {
      releases.push(`ipc:${channel}`);
      handlers.delete(channel);
      if (`ipc:${channel}` === options.failRelease) throw new Error(`release:${channel}`);
    },
    removeListener(channel: string) {
      releases.push(`listener:${channel}`);
      listeners.delete(channel);
      if (`listener:${channel}` === options.failRelease) throw new Error(`release:${channel}`);
      return ipcMain;
    },
  } as unknown as IpcMain;
  const protocol = {
    handle(scheme: string, handler: (...args: unknown[]) => unknown) {
      protocols.set(scheme, handler);
    },
    unhandle(scheme: string) {
      releases.push(`protocol:${scheme}`);
      protocols.delete(scheme);
      if (`protocol:${scheme}` === options.failRelease) throw new Error(`release:${scheme}`);
    },
  } as unknown as Protocol;
  return { target: { ipcMain, protocol }, handlers, listeners, protocols, releases };
}

describe('host transport ownership', () => {
  test('releases every IPC and protocol registration exactly once in reverse owner order', () => {
    const fixture = targetFixture();
    const transport = new HostTransportComposition('main', fixture.target);
    transport.registerIpcOwner('outline', (ipc) => {
      ipc.handle('outline:request', () => undefined);
      ipc.on('outline:cancel', () => undefined);
    });
    transport.registerProtocolOwner('assets', (ownedProtocol) => {
      ownedProtocol.handle('asset', () => new Response());
    });

    transport.dispose();
    transport.dispose();

    expect(fixture.handlers.size).toBe(0);
    expect(fixture.listeners.size).toBe(0);
    expect(fixture.protocols.size).toBe(0);
    expect(fixture.releases).toEqual([
      'protocol:asset',
      'listener:outline:cancel',
      'ipc:outline:request',
    ]);
  });

  test('rolls back a partially registered owner without disturbing prior owners', () => {
    const fixture = targetFixture({ failHandle: 'agent:request' });
    const transport = new HostTransportComposition('main', fixture.target);
    transport.registerIpcOwner('outline', (ipc) => ipc.handle('outline:request', () => undefined));

    expect(() => transport.registerIpcOwner('agent', (ipc) => {
      ipc.handle('agent:notification', () => undefined);
      ipc.handle('agent:request', () => undefined);
    })).toThrow('register:agent:request');
    expect([...fixture.handlers.keys()]).toEqual(['outline:request']);
    expect(fixture.releases).toEqual(['ipc:agent:notification']);

    transport.dispose();
    expect(fixture.releases).toEqual(['ipc:agent:notification', 'ipc:outline:request']);
  });

  test('rejects duplicate channel ownership before replacing the live handler', () => {
    const fixture = targetFixture();
    const transport = new HostTransportComposition('main', fixture.target);
    const original = () => 'outline';
    transport.registerIpcOwner('outline', (ipc) => ipc.handle('shared', original));

    expect(() => transport.registerIpcOwner('agent', (ipc) => {
      ipc.handle('shared', () => 'agent');
    })).toThrow('ipc:shared is already owned by outline');
    expect(fixture.handlers.get('shared')).toBe(original);
  });

  test('continues disposal after a release failure and reports the aggregate once', () => {
    const fixture = targetFixture({ failRelease: 'ipc:first' });
    const transport = new HostTransportComposition('main', fixture.target);
    transport.registerIpcOwner('one', (ipc) => ipc.handle('first', () => undefined));
    transport.registerIpcOwner('two', (ipc) => ipc.handle('second', () => undefined));

    expect(() => transport.dispose()).toThrow(AggregateError);
    expect(fixture.releases).toEqual(['ipc:second', 'ipc:first']);
    expect(() => transport.dispose()).not.toThrow();
  });

  test('createTransportOwner rolls back registration and preserves both failures', () => {
    expect(() => createTransportOwner('native', (owner) => {
      owner.add(() => {
        throw new Error('rollback');
      });
      throw new Error('registration');
    })).toThrow(AggregateError);
  });

  test('RegistrationOwner rejects additions after idempotent disposal', () => {
    const owner = new RegistrationOwner('closed');
    owner.dispose();
    owner.dispose();
    expect(() => owner.add(() => undefined)).toThrow('already disposed');
  });

  test('disposeTransportOwners continues after owner failures', () => {
    const calls: string[] = [];
    const failed = createTransportOwner('failed', (owner) => owner.add(() => {
      calls.push('failed');
      throw new Error('failed release');
    }));
    const healthy = createTransportOwner('healthy', (owner) => owner.add(() => {
      calls.push('healthy');
    }));
    expect(() => disposeTransportOwners('all', [failed, null, healthy])).toThrow(AggregateError);
    expect(calls).toEqual(['failed', 'healthy']);
  });

  test('owns the complete Outline adapter and preserves admission before decode', () => {
    const fixture = targetFixture();
    const transport = new HostTransportComposition('main', fixture.target);
    const admittedSender = { id: 41 };
    let clientCalls = 0;
    transport.registerIpcOwner('outline', (ipcMain) => registerDesktopOutlineIpc({
      ipcMain,
      client: {
        request: () => { clientCalls += 1; },
        commit: () => { clientCalls += 1; },
        subscribe: () => { clientCalls += 1; },
        cancel: () => { clientCalls += 1; },
      } as unknown as DesktopOutlineClient,
      authorize: (event) => {
        if (event.sender !== admittedSender) throw new Error('denied');
      },
    }));

    expect([...fixture.handlers.keys()].sort()).toEqual([
      OUTLINE_DESKTOP_COMMIT_CHANNEL,
      OUTLINE_DESKTOP_REQUEST_CHANNEL,
      OUTLINE_DESKTOP_SUBSCRIBE_CHANNEL,
    ].sort());
    expect([...fixture.listeners.keys()].sort()).toEqual([
      OUTLINE_DESKTOP_CANCEL_CHANNEL,
      OUTLINE_DESKTOP_UNSUBSCRIBE_CHANNEL,
    ].sort());
    expect(() => fixture.handlers.get(OUTLINE_DESKTOP_REQUEST_CHANNEL)?.(
      { sender: { id: 42 } },
      { invalid: true },
    )).toThrow('denied');
    expect(clientCalls).toBe(0);

    transport.dispose();
    expect(fixture.handlers.size).toBe(0);
    expect(fixture.listeners.size).toBe(0);
  });
});
