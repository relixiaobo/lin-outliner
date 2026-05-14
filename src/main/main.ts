import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DocumentService } from './documentService';
import { AgentRuntime } from './agentRuntime';
import {
  deleteProviderApiKey,
  deleteProviderConfig,
  getProviderSecretStatus,
  getProviderSettings,
  setActiveProvider,
  setProviderApiKey,
  upsertProviderConfig,
} from './agentSettings';
import type { AgentProviderConfigInput } from '../core/types';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const documentService = new DocumentService();
let mainWindow: BrowserWindow | null = null;
const agentRuntime = new AgentRuntime(() => mainWindow);

function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'Lin Outliner',
    width: 1120,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#f7f6f1',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 13, y: 8 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
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
    if (command.startsWith('agent_')) return handleAgentCommand(command, args ?? {});
    return documentService.handle(command, args);
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

async function handleAgentCommand(command: string, args: Record<string, unknown>) {
  switch (command) {
    case 'agent_create_session':
      return agentRuntime.createSession();
    case 'agent_send_message':
      return agentRuntime.sendMessage(String(args.sessionId), String(args.message ?? ''));
    case 'agent_stop_session':
      return agentRuntime.stopSession(String(args.sessionId));
    case 'agent_reset_session':
      return agentRuntime.resetSession(String(args.sessionId));
    case 'agent_close_session':
      return agentRuntime.closeSession(String(args.sessionId));
    case 'agent_get_provider_settings':
      return getProviderSettings();
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

