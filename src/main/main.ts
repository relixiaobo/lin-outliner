import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DocumentService } from './documentService';
import { AssetService } from './assetService';
import { AgentRuntime } from './agentRuntime';
import { MAC_TRAFFIC_LIGHT_POSITION } from '../core/chromeGeometry';
import { LIN_DOCUMENT_EVENT_CHANNEL, type AssetIngestInput } from '../core/types';
import {
  deleteProviderApiKey,
  deleteProviderConfig,
  getProviderSecretStatus,
  getProviderSettings,
  setActiveProvider,
  setProviderApiKey,
  updateAgentRuntimeSettings,
  upsertProviderConfig,
} from './agentSettings';
import { isAgentCommand, isAssetCommand, isDocumentCommand, type AgentCommand, type AssetCommand } from '../core/commands';
import type { AgentProviderConfigInput, AgentRuntimeSettingsInput } from '../core/types';

if (process.env.ELECTRON_USER_DATA_DIR) {
  app.setPath('userData', process.env.ELECTRON_USER_DATA_DIR);
}

// Must run before the app `ready` event so the renderer can load assets with
// regular <img>/<video> tags via `lin-asset://<id>`.
protocol.registerSchemesAsPrivileged([
  { scheme: 'lin-asset', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

const IMAGE_FILE_FILTERS = [
  { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'heic'] },
];

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const documentService = new DocumentService();
const assetService = new AssetService(() => join(app.getPath('userData'), 'assets'));
let mainWindow: BrowserWindow | null = null;
let quitAfterFlush = false;
const agentRuntime = new AgentRuntime(() => mainWindow, documentService, {
  localFileRoot: process.env.LIN_AGENT_LOCAL_ROOT ?? process.cwd(),
});

documentService.onProjectionChanged((event) => {
  mainWindow?.webContents.send(LIN_DOCUMENT_EVENT_CHANNEL, event);
});

function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'Lin Outliner',
    width: 1120,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#f7f6f1',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: MAC_TRAFFIC_LIGHT_POSITION,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL ?? process.env.VITE_DEV_SERVER_URL;
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.once('did-finish-load', () => agentRuntime.ready());
}

function registerIpc() {
  ipcMain.handle('lin:invoke', async (_event, command: string, args?: Record<string, unknown>) => {
    if (isAgentCommand(command)) return handleAgentCommand(command, args ?? {});
    if (isAssetCommand(command)) return handleAssetCommand(command, args ?? {});
    if (isDocumentCommand(command)) return documentService.handle(command, args);
    throw new Error(`Unknown command: ${command}`);
  });

  ipcMain.handle('lin:window', (_event, command: string) => {
    const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
    if (!window) return;
    if (command === 'minimize') window.minimize();
    if (command === 'toggle_maximize') {
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
    }
    if (command === 'close') window.close();
  });
}

async function handleAssetCommand(command: AssetCommand, args: Record<string, unknown>) {
  switch (command) {
    case 'ingest_asset':
      return assetService.ingest(args as unknown as AssetIngestInput);
    case 'lookup_asset':
      return assetService.lookup(String(args.id));
    case 'delete_asset':
      return assetService.delete(String(args.id));
    case 'pick_image_files': {
      const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
      const options = {
        title: 'Insert image',
        properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
        filters: IMAGE_FILE_FILTERS,
      };
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled) return [];
      return Promise.all(result.filePaths.map((path) => assetService.ingest({ kind: 'path', path })));
    }
    default:
      throw new Error(`Unknown asset command: ${command}`);
  }
}

async function handleAgentCommand(command: AgentCommand, args: Record<string, unknown>) {
  switch (command) {
    case 'agent_restore_latest_session':
      return agentRuntime.restoreLatestSession();
    case 'agent_restore_session':
      return agentRuntime.restoreSession(String(args.sessionId));
    case 'agent_create_session':
      return agentRuntime.createSession();
    case 'agent_list_sessions':
      return agentRuntime.listSessions();
    case 'agent_rename_session':
      return agentRuntime.renameSession(String(args.sessionId), String(args.title ?? ''));
    case 'agent_delete_session':
      return agentRuntime.deleteSession(String(args.sessionId));
    case 'agent_debug_snapshot':
      return agentRuntime.debugSnapshot(String(args.sessionId));
    case 'agent_debug_history':
      return agentRuntime.debugHistory(String(args.sessionId));
    case 'agent_debug_totals':
      return agentRuntime.debugTotals(String(args.sessionId));
    case 'agent_debug_payload':
      return agentRuntime.debugPayload(String(args.sessionId), String(args.payloadId));
    case 'agent_payload_text':
      return agentRuntime.payloadText(String(args.sessionId), String(args.payloadId));
    case 'agent_subagent_status':
      return agentRuntime.subagentStatus(String(args.sessionId), String(args.agentId), {
        wait: args.wait === true,
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      });
    case 'agent_subagent_send':
      return agentRuntime.subagentSend(String(args.sessionId), String(args.agentId), String(args.message ?? ''));
    case 'agent_subagent_stop':
      return agentRuntime.subagentStop(String(args.sessionId), String(args.agentId));
    case 'agent_send_message':
      return agentRuntime.sendMessage(
        String(args.sessionId),
        String(args.message ?? ''),
        args.attachments,
        args.userViewContext,
      );
    case 'agent_edit_message':
      return agentRuntime.editMessage(
        String(args.sessionId),
        String(args.nodeId),
        String(args.message ?? ''),
      );
    case 'agent_regenerate_message':
      return agentRuntime.regenerateMessage(String(args.sessionId), String(args.nodeId));
    case 'agent_retry_message':
      return agentRuntime.retryMessage(String(args.sessionId), String(args.nodeId));
    case 'agent_switch_branch':
      return agentRuntime.switchBranch(String(args.sessionId), String(args.nodeId));
    case 'agent_queue_follow_up':
      return agentRuntime.queueFollowUp(
        String(args.sessionId),
        String(args.message ?? ''),
        args.userViewContext,
      );
    case 'agent_clear_follow_up':
      return agentRuntime.clearFollowUp(String(args.sessionId));
    case 'agent_steer_session':
      return agentRuntime.steerSession(
        String(args.sessionId),
        String(args.message ?? ''),
      );
    case 'agent_clear_steer':
      return agentRuntime.clearSteer(String(args.sessionId));
    case 'agent_stop_session':
      return agentRuntime.stopSession(String(args.sessionId));
    case 'agent_reset_session':
      return agentRuntime.resetSession(String(args.sessionId));
    case 'agent_close_session':
      return agentRuntime.closeSession(String(args.sessionId));
    case 'agent_get_provider_settings':
      return getProviderSettings();
    case 'agent_update_runtime_settings':
      return updateAgentRuntimeSettings(args.settings as AgentRuntimeSettingsInput);
    case 'agent_upsert_provider_config':
      return upsertProviderConfig(args.provider as AgentProviderConfigInput);
    case 'agent_delete_provider_config':
      return deleteProviderConfig(String(args.providerId));
    case 'agent_set_active_provider':
      return setActiveProvider(String(args.providerId));
    case 'agent_set_provider_api_key':
      return setProviderApiKey(String(args.providerId), String(args.apiKey ?? ''));
    case 'agent_delete_provider_api_key':
      return deleteProviderApiKey(String(args.providerId));
    case 'agent_get_provider_secret_status':
      return getProviderSecretStatus(String(args.providerId));
    default:
      throw new Error(`Unknown agent command: ${command}`);
  }
}

app.whenReady().then(() => {
  protocol.handle('lin-asset', (request) => {
    const id = new URL(request.url).hostname;
    return assetService.serve(id);
  });
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (quitAfterFlush) return;
  event.preventDefault();
  quitAfterFlush = true;
  void documentService.flushPendingChanges()
    .catch((error) => console.error(error))
    .finally(() => app.quit());
});
