import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { Value } from 'typebox/value';
import { WatchRequestSchema } from '../../outline/contract/schemas';
import type { DesktopOutlineClient } from './desktopOutlineClient';
import {
  OUTLINE_DESKTOP_CANCEL_CHANNEL,
  OUTLINE_DESKTOP_REQUEST_CHANNEL,
  OUTLINE_DESKTOP_STREAM_CHANNEL,
  OUTLINE_DESKTOP_SUBSCRIBE_CHANNEL,
  OUTLINE_DESKTOP_UNSUBSCRIBE_CHANNEL,
  decodeOutlineDesktopId,
  decodeOutlineDesktopRequest,
  decodeOutlineDesktopSubscription,
  type OutlineDesktopStreamMessage,
} from './protocol';

export interface DesktopOutlineIpcOptions {
  readonly ipcMain: Pick<IpcMain, 'handle' | 'on'>;
  readonly client: DesktopOutlineClient;
  readonly authorize: (event: IpcMainInvokeEvent | IpcMainEvent) => void;
}

export function registerDesktopOutlineIpc(options: DesktopOutlineIpcOptions): void {
  options.ipcMain.handle(OUTLINE_DESKTOP_REQUEST_CHANNEL, (event, raw: unknown) => {
    options.authorize(event);
    const request = decodeOutlineDesktopRequest(raw);
    return options.client.request(
      event.sender.id,
      request.requestId,
      request.command,
      request.input,
    );
  });

  options.ipcMain.handle(OUTLINE_DESKTOP_SUBSCRIBE_CHANNEL, (event, raw: unknown): void => {
    options.authorize(event);
    const subscription = decodeOutlineDesktopSubscription(raw);
    if (!Value.Check(WatchRequestSchema, subscription.input)) {
      throw new Error('Invalid desktop Outline watch request.');
    }
    options.client.subscribe(event.sender.id, subscription.subscriptionId, subscription.input, (record) => {
      if (event.sender.isDestroyed()) return;
      const message: OutlineDesktopStreamMessage = {
        subscriptionId: subscription.subscriptionId,
        record,
      };
      event.sender.send(OUTLINE_DESKTOP_STREAM_CHANNEL, message);
    });
  });

  options.ipcMain.on(OUTLINE_DESKTOP_CANCEL_CHANNEL, (event, raw: unknown) => {
    options.authorize(event);
    options.client.cancel(event.sender.id, decodeOutlineDesktopId(raw));
  });

  options.ipcMain.on(OUTLINE_DESKTOP_UNSUBSCRIBE_CHANNEL, (event, raw: unknown) => {
    options.authorize(event);
    options.client.cancel(event.sender.id, decodeOutlineDesktopId(raw));
  });
}
