import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CC_SWITCH_LOCAL_PROVIDER_ID } from '../core/localGatewayProviders';

export type CcSwitchAppType =
  | 'codex'
  | 'claude'
  | 'claude-desktop'
  | 'gemini'
  | 'opencode'
  | 'openclaw'
  | 'hermes';

export type CcSwitchRouteKind = 'direct' | 'proxy-required' | 'unsupported';
export type CcSwitchRegistryStatus = 'ready' | 'proxy-required' | 'unsupported' | 'not-detected';
export type CcSwitchAuthKind = 'api-key' | 'oauth' | 'managed' | 'none' | 'unknown';
export type CcSwitchOpenAICompatibleApiId = 'openai-completions' | 'openai-responses';

export interface CcSwitchModelDescriptor {
  id: string;
  name?: string;
  api?: CcSwitchOpenAICompatibleApiId;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface CcSwitchProviderSource {
  appType: CcSwitchAppType;
  providerId: string;
  name: string;
  isCurrent: boolean;
  endpoints: string[];
  meta: Record<string, unknown>;
  settingsConfig: Record<string, unknown>;
  authKind: CcSwitchAuthKind;
  apiFormat: string | null;
  modelId: string | null;
  modelCatalog: CcSwitchModelDescriptor[];
  routeKind: CcSwitchRouteKind;
  disabledReason?: string;
}

export interface CcSwitchProxyConfig {
  appType: CcSwitchAppType;
  listenAddress: string;
  listenPort: number;
  enabled: boolean;
  proxyEnabled: boolean;
}

export interface CcSwitchRegistrySnapshot {
  dbPath?: string;
  detected: boolean;
  status: CcSwitchRegistryStatus;
  statusMessage?: string;
  sources: CcSwitchProviderSource[];
  proxyConfigs: CcSwitchProxyConfig[];
}

interface CcSwitchProviderRow {
  id: unknown;
  app_type: unknown;
  name: unknown;
  settings_config: unknown;
  meta: unknown;
  is_current: unknown;
  sort_index: unknown;
}

interface CcSwitchEndpointRow {
  provider_id: unknown;
  app_type: unknown;
  url: unknown;
  added_at: unknown;
}

interface CcSwitchProxyRow {
  app_type: unknown;
  listen_address: unknown;
  listen_port: unknown;
  enabled: unknown;
  proxy_enabled: unknown;
}

export interface CcSwitchRegistryRows {
  providers: CcSwitchProviderRow[];
  endpoints: CcSwitchEndpointRow[];
  proxyConfigs: CcSwitchProxyRow[];
  dbPath?: string;
}

const REQUIRED_COLUMNS = {
  providers: ['id', 'app_type', 'name', 'settings_config', 'meta', 'is_current', 'sort_index'],
  provider_endpoints: ['provider_id', 'app_type', 'url', 'added_at'],
  proxy_config: ['app_type', 'listen_address', 'listen_port', 'enabled', 'proxy_enabled'],
} as const;

const APP_TYPE_LABELS: Record<CcSwitchAppType, string> = {
  codex: 'Codex',
  claude: 'Claude',
  'claude-desktop': 'Claude Desktop',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
};

const KNOWN_APP_TYPES = new Set<CcSwitchAppType>([
  'codex',
  'claude',
  'claude-desktop',
  'gemini',
  'opencode',
  'openclaw',
  'hermes',
]);

const CC_SWITCH_SOURCE_PROVIDER_PREFIX = `${CC_SWITCH_LOCAL_PROVIDER_ID}:`;
const CC_SWITCH_MODEL_SEPARATOR = '::';

let registryReaderOverride: ((homePath: string | undefined) => Promise<CcSwitchRegistrySnapshot>) | null = null;

export function setCcSwitchRegistryReaderForTests(
  reader: ((homePath: string | undefined) => Promise<CcSwitchRegistrySnapshot>) | null,
): void {
  registryReaderOverride = reader;
}

export async function readCcSwitchRegistrySnapshot(homePath: string | undefined): Promise<CcSwitchRegistrySnapshot> {
  if (registryReaderOverride) return registryReaderOverride(homePath);
  const dbPath = ccSwitchDbPath(homePath);
  if (!dbPath || !existsSync(dbPath)) {
    return notDetectedSnapshot(dbPath, 'CC Switch database was not found.');
  }
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      validateCcSwitchSchema(db);
      const providers = db.prepare('select id, app_type, name, settings_config, meta, is_current, sort_index from providers order by sort_index asc, name asc').all() as unknown as CcSwitchProviderRow[];
      const endpoints = db.prepare('select provider_id, app_type, url, added_at from provider_endpoints order by added_at asc').all() as unknown as CcSwitchEndpointRow[];
      const proxyConfigs = db.prepare('select app_type, listen_address, listen_port, enabled, proxy_enabled from proxy_config').all() as unknown as CcSwitchProxyRow[];
      return buildCcSwitchRegistryFromRows({ providers, endpoints, proxyConfigs, dbPath });
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      dbPath,
      detected: true,
      status: 'unsupported',
      statusMessage: error instanceof Error ? error.message : String(error),
      sources: [],
      proxyConfigs: [],
    };
  }
}

export function buildCcSwitchRegistryFromRows(rows: CcSwitchRegistryRows): CcSwitchRegistrySnapshot {
  const endpointsBySource = groupEndpoints(rows.endpoints);
  const proxyConfigs = rows.proxyConfigs
    .map(normalizeProxyConfig)
    .filter((config): config is CcSwitchProxyConfig => Boolean(config));
  const sources = rows.providers
    .map((row) => normalizeProviderSource(row, endpointsBySource, proxyConfigs))
    .filter((source): source is CcSwitchProviderSource => Boolean(source));

  const directSources = sources.filter((source) => source.routeKind === 'direct');
  const proxyRequiredSources = sources.filter((source) => source.routeKind === 'proxy-required');
  const unsupportedSources = sources.filter((source) => source.routeKind === 'unsupported');
  const status: CcSwitchRegistryStatus = directSources.length > 0
    ? 'ready'
    : (proxyRequiredSources.length > 0
      ? 'proxy-required'
      : (sources.length > 0 || rows.providers.length > 0 ? 'unsupported' : 'not-detected'));
  const statusMessage = directSources.length > 0
    ? undefined
    : proxyRequiredSources[0]?.disabledReason
      ?? unsupportedSources[0]?.disabledReason
      ?? (rows.providers.length > 0 ? 'CC Switch providers were found, but none can run directly in Tenon.' : 'CC Switch database contains no provider rows.');
  return {
    dbPath: rows.dbPath,
    detected: status !== 'not-detected',
    status,
    statusMessage,
    sources,
    proxyConfigs,
  };
}

export function ccSwitchDbPath(homePath: string | undefined): string | undefined {
  return homePath ? join(homePath, '.cc-switch', 'cc-switch.db') : undefined;
}

export function ccSwitchRunnableSources(snapshot: CcSwitchRegistrySnapshot): CcSwitchProviderSource[] {
  return snapshot.sources.filter((source) => source.routeKind === 'direct');
}

export function ccSwitchSourceRuntimeProviderId(source: Pick<CcSwitchProviderSource, 'appType' | 'providerId'>): string {
  return `${CC_SWITCH_SOURCE_PROVIDER_PREFIX}${encodeURIComponent(source.appType)}:${encodeURIComponent(source.providerId)}`;
}

export function parseCcSwitchRuntimeProviderId(providerId: string): { appType: CcSwitchAppType; providerId: string } | null {
  if (!providerId.startsWith(CC_SWITCH_SOURCE_PROVIDER_PREFIX)) return null;
  const rest = providerId.slice(CC_SWITCH_SOURCE_PROVIDER_PREFIX.length);
  const separatorIndex = rest.indexOf(':');
  if (separatorIndex <= 0) return null;
  const appType = decodeURIComponent(rest.slice(0, separatorIndex));
  const sourceProviderId = decodeURIComponent(rest.slice(separatorIndex + 1));
  if (!isCcSwitchAppType(appType) || !sourceProviderId) return null;
  return { appType, providerId: sourceProviderId };
}

export function ccSwitchModelOptionId(sourceRuntimeProviderId: string, modelId: string): string {
  return `${encodeURIComponent(sourceRuntimeProviderId)}${CC_SWITCH_MODEL_SEPARATOR}${encodeURIComponent(modelId)}`;
}

export function parseCcSwitchModelOptionId(modelId: string): { sourceRuntimeProviderId: string; modelId: string } | null {
  const separatorIndex = modelId.indexOf(CC_SWITCH_MODEL_SEPARATOR);
  if (separatorIndex <= 0) return null;
  try {
    const sourceRuntimeProviderId = decodeURIComponent(modelId.slice(0, separatorIndex));
    const rawModelId = decodeURIComponent(modelId.slice(separatorIndex + CC_SWITCH_MODEL_SEPARATOR.length));
    if (!parseCcSwitchRuntimeProviderId(sourceRuntimeProviderId) || !rawModelId) return null;
    return { sourceRuntimeProviderId, modelId: rawModelId };
  } catch {
    return null;
  }
}

export function ccSwitchSourceApiKey(source: CcSwitchProviderSource): string | undefined {
  if (source.authKind !== 'api-key') return undefined;
  return extractCcSwitchApiKey(source.settingsConfig);
}

export function ccSwitchSourceBaseUrl(source: CcSwitchProviderSource): string | undefined {
  return source.endpoints[0] ?? extractEndpointFromSettings(source.settingsConfig);
}

export function ccSwitchSourceModels(source: CcSwitchProviderSource): CcSwitchModelDescriptor[] {
  const models = source.modelCatalog.length > 0
    ? source.modelCatalog
    : (source.modelId ? [{ id: source.modelId, api: ccSwitchPiApiForSource(source) }] : []);
  return models.map((model) => ({
    ...model,
    api: model.api ?? ccSwitchPiApiForSource(source),
  }));
}

export function ccSwitchSourceLabel(source: CcSwitchProviderSource, model: CcSwitchModelDescriptor): string {
  return `${APP_TYPE_LABELS[source.appType]} / ${source.name} / ${model.name ?? formatDiscoveredModelName(model.id)}`;
}

export function ccSwitchPiApiForSource(source: CcSwitchProviderSource): CcSwitchOpenAICompatibleApiId {
  return normalizeApiFormat(source.apiFormat) === 'openai_chat'
    ? 'openai-completions'
    : 'openai-responses';
}

function notDetectedSnapshot(dbPath: string | undefined, statusMessage: string): CcSwitchRegistrySnapshot {
  return {
    dbPath,
    detected: false,
    status: 'not-detected',
    statusMessage,
    sources: [],
    proxyConfigs: [],
  };
}

function validateCcSwitchSchema(db: {
  prepare(sql: string): { all(): Array<Record<string, unknown>> };
}): void {
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const existingColumns = new Set(
      db.prepare(`pragma table_info(${table})`).all()
        .map((row) => typeof row.name === 'string' ? row.name : '')
        .filter(Boolean),
    );
    for (const column of columns) {
      if (!existingColumns.has(column)) {
        throw new Error(`Unsupported CC Switch database schema: ${table}.${column} is missing.`);
      }
    }
  }
}

function normalizeProviderSource(
  row: CcSwitchProviderRow,
  endpointsBySource: Map<string, string[]>,
  proxyConfigs: readonly CcSwitchProxyConfig[],
): CcSwitchProviderSource | null {
  const appType = normalizeAppType(row.app_type);
  const providerId = stringValue(row.id);
  if (!appType || !providerId) return null;
  const settingsConfig = normalizeSettingsConfig(parseJsonObject(row.settings_config));
  const meta = parseJsonObject(row.meta);
  const endpoints = uniqueStrings([
    ...(endpointsBySource.get(sourceKey(appType, providerId)) ?? []),
    extractEndpointFromSettings(settingsConfig),
  ]);
  const apiFormat = extractApiFormat(meta, settingsConfig);
  const modelCatalog = extractModelCatalog(settingsConfig, apiFormat);
  const modelId = extractModelId(settingsConfig, modelCatalog);
  const authKind = classifyAuthKind(settingsConfig);
  const baseSource: Omit<CcSwitchProviderSource, 'routeKind' | 'disabledReason'> = {
    appType,
    providerId,
    name: stringValue(row.name) ?? providerId,
    isCurrent: Boolean(row.is_current),
    endpoints,
    meta,
    settingsConfig,
    authKind,
    apiFormat,
    modelId,
    modelCatalog,
  };
  const route = classifyRoute(baseSource, proxyConfigs);
  return { ...baseSource, ...route };
}

function normalizeProxyConfig(row: CcSwitchProxyRow): CcSwitchProxyConfig | null {
  const appType = normalizeAppType(row.app_type);
  if (!appType) return null;
  const listenPort = integerValue(row.listen_port);
  return {
    appType,
    listenAddress: stringValue(row.listen_address) ?? '127.0.0.1',
    listenPort: listenPort && listenPort > 0 ? listenPort : 0,
    enabled: Boolean(row.enabled),
    proxyEnabled: Boolean(row.proxy_enabled),
  };
}

function classifyRoute(
  source: Omit<CcSwitchProviderSource, 'routeKind' | 'disabledReason'>,
  proxyConfigs: readonly CcSwitchProxyConfig[],
): { routeKind: CcSwitchRouteKind; disabledReason?: string } {
  const normalizedApiFormat = normalizeApiFormat(source.apiFormat);
  const baseUrl = source.endpoints[0];
  const hasModel = Boolean(source.modelId || source.modelCatalog.length > 0);
  if (
    source.appType === 'codex'
    && normalizedApiFormat === 'openai_responses'
    && baseUrl
    && source.authKind === 'api-key'
    && extractCcSwitchApiKey(source.settingsConfig)
    && hasModel
    && !hasProxyOnlySignals(source.meta, source.settingsConfig)
  ) {
    return { routeKind: 'direct' };
  }

  if (source.appType === 'codex' && normalizedApiFormat === 'openai_chat') {
    return {
      routeKind: 'proxy-required',
      disabledReason: 'This CC Switch provider requires Local Proxy because its upstream format is Chat Completions.',
    };
  }

  if (source.authKind === 'oauth' || source.authKind === 'managed') {
    return {
      routeKind: 'proxy-required',
      disabledReason: 'This CC Switch provider uses a managed or OAuth credential shape and must run through CC Switch Local Proxy.',
    };
  }

  if (hasProxyOnlySignals(source.meta, source.settingsConfig)) {
    return {
      routeKind: 'proxy-required',
      disabledReason: 'This CC Switch provider depends on CC Switch routing features that Tenon does not reimplement.',
    };
  }

  if (!baseUrl && proxyConfigs.some((config) => config.appType === source.appType && config.enabled && config.proxyEnabled)) {
    return {
      routeKind: 'proxy-required',
      disabledReason: 'This CC Switch provider needs CC Switch Local Proxy because no direct endpoint is registered.',
    };
  }

  if (source.appType !== 'codex') {
    return {
      routeKind: 'unsupported',
      disabledReason: `CC Switch ${APP_TYPE_LABELS[source.appType]} providers are visible but not directly runnable in Tenon yet.`,
    };
  }
  if (!baseUrl) return { routeKind: 'unsupported', disabledReason: 'This CC Switch provider has no direct endpoint.' };
  if (source.authKind !== 'api-key') return { routeKind: 'unsupported', disabledReason: 'This CC Switch provider has an unsupported credential shape.' };
  if (!hasModel) return { routeKind: 'unsupported', disabledReason: 'This CC Switch provider has no configured model.' };
  return { routeKind: 'unsupported', disabledReason: 'This CC Switch provider is not directly runnable in Tenon yet.' };
}

function groupEndpoints(rows: readonly CcSwitchEndpointRow[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const appType = normalizeAppType(row.app_type);
    const providerId = stringValue(row.provider_id);
    const url = stringValue(row.url);
    if (!appType || !providerId || !url) continue;
    const key = sourceKey(appType, providerId);
    map.set(key, uniqueStrings([...(map.get(key) ?? []), url]));
  }
  return map;
}

function sourceKey(appType: CcSwitchAppType, providerId: string): string {
  return `${appType}:${providerId}`;
}

function normalizeAppType(value: unknown): CcSwitchAppType | null {
  const normalized = stringValue(value)?.toLowerCase();
  return normalized && isCcSwitchAppType(normalized) ? normalized : null;
}

function isCcSwitchAppType(value: string): value is CcSwitchAppType {
  return KNOWN_APP_TYPES.has(value as CcSwitchAppType);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeSettingsConfig(settingsConfig: Record<string, unknown>): Record<string, unknown> {
  const config = settingsConfig.config;
  if (typeof config !== 'string') return settingsConfig;
  const parsedConfig = parseTomlScalars(config);
  if (Object.keys(parsedConfig).length === 0) return settingsConfig;
  return {
    ...settingsConfig,
    config: parsedConfig,
  };
}

function parseTomlScalars(value: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let target = root;
  for (const rawLine of value.split(/\r?\n/g)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (sectionMatch) {
      target = ensureTomlSection(root, sectionMatch[1]!);
      continue;
    }
    const assignmentMatch = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!assignmentMatch) continue;
    const key = assignmentMatch[1]!;
    const parsedValue = parseTomlScalar(assignmentMatch[2]!.trim());
    if (parsedValue !== undefined) target[key] = parsedValue;
  }
  return root;
}

function ensureTomlSection(root: Record<string, unknown>, path: string): Record<string, unknown> {
  let target = root;
  for (const part of path.split('.').filter(Boolean)) {
    const existing = target[part];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      const next: Record<string, unknown> = {};
      target[part] = next;
      target = next;
      continue;
    }
    target = existing as Record<string, unknown>;
  }
  return target;
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#') return line.slice(0, index);
  }
  return line;
}

function parseTomlScalar(value: string): unknown {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value === 'true') return true;
  if (value === 'false') return false;
  const numeric = Number(value.replace(/_/g, ''));
  if (value && Number.isFinite(numeric) && /^[+-]?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return numeric;
  return undefined;
}

function classifyAuthKind(settingsConfig: Record<string, unknown>): CcSwitchAuthKind {
  const explicit = stringValue(deepFindValue(settingsConfig, ['authKind', 'auth_kind', 'credentialType', 'credential_type', 'type']));
  const normalized = explicit?.toLowerCase().replace(/[-\s]/g, '_');
  if (normalized === 'api_key' || normalized === 'apikey') return 'api-key';
  if (normalized === 'oauth' || normalized === 'session') return 'oauth';
  if (normalized === 'managed') return 'managed';
  if (normalized === 'none') return 'none';
  if (extractCcSwitchApiKey(settingsConfig)) return 'api-key';
  if (deepHasKey(settingsConfig, ['refresh', 'refresh_token', 'access', 'access_token', 'session', 'oauth'])) return 'oauth';
  if (deepHasKey(settingsConfig, ['managed', 'account_id', 'accountId'])) return 'managed';
  return 'unknown';
}

function extractApiFormat(...records: Record<string, unknown>[]): string | null {
  for (const record of records) {
    const value = stringValue(deepFindValue(record, ['apiFormat', 'api_format', 'wireApi', 'wire_api', 'format']));
    if (value) return value;
  }
  return null;
}

function normalizeApiFormat(value: string | null | undefined): 'openai_responses' | 'openai_chat' | 'unknown' {
  const normalized = value?.toLowerCase().replace(/[-\s]/g, '_');
  if (!normalized) return 'unknown';
  if (normalized.includes('responses') || normalized === 'openai_response') return 'openai_responses';
  if (normalized.includes('chat') || normalized.includes('completions')) return 'openai_chat';
  return 'unknown';
}

function extractCcSwitchApiKey(settingsConfig: Record<string, unknown>): string | undefined {
  return stringValue(deepFindValue(settingsConfig, ['OPENAI_API_KEY', 'apiKey', 'api_key', 'key']));
}

function extractEndpointFromSettings(settingsConfig: Record<string, unknown>): string | undefined {
  const value = stringValue(deepFindValue(settingsConfig, ['base_url', 'baseUrl', 'endpoint', 'url']));
  return value && /^https?:\/\//i.test(value) ? value : undefined;
}

function extractModelId(
  settingsConfig: Record<string, unknown>,
  modelCatalog: readonly CcSwitchModelDescriptor[],
): string | null {
  return stringValue(deepFindValue(settingsConfig, ['model', 'modelId', 'model_id', 'currentModel', 'current_model']))
    ?? modelCatalog[0]?.id
    ?? null;
}

function extractModelCatalog(settingsConfig: Record<string, unknown>, apiFormat: string | null): CcSwitchModelDescriptor[] {
  const candidates = [
    deepFindValue(settingsConfig, ['modelCatalog', 'model_catalog']),
    settingsConfig,
  ];
  const seen = new Set<string>();
  const models: CcSwitchModelDescriptor[] = [];
  for (const candidate of candidates) {
    const record = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? candidate as Record<string, unknown>
      : {};
    const entries = Array.isArray(record.models)
      ? record.models
      : (Array.isArray(record.data) ? record.data : []);
    for (const entry of entries) {
      const id = modelIdFromListEntry(entry);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const entryRecord = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
      const modelApi = modelApiFromValue(stringValue(entryRecord.api) ?? apiFormat);
      models.push({
        id,
        api: modelApi,
        name: stringField(entryRecord, ['display_name', 'displayName', 'name']),
        contextWindow: positiveIntegerField(entryRecord, ['context_window', 'max_context_window', 'contextWindow']),
        maxTokens: positiveIntegerField(entryRecord, ['max_tokens', 'maxTokens']),
      });
    }
  }
  return models;
}

function hasProxyOnlySignals(...records: Record<string, unknown>[]): boolean {
  return records.some((record) => deepHasKey(record, [
    'failover',
    'requestOverrides',
    'request_overrides',
    'requestRectification',
    'request_rectification',
    'requiresProxy',
    'requires_proxy',
    'protocolConversion',
    'protocol_conversion',
    'userAgent',
    'user_agent',
  ]));
}

function deepFindValue(record: Record<string, unknown>, names: readonly string[]): unknown {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const queue: unknown[] = [record];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
      if (wanted.has(key.toLowerCase())) return value;
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return undefined;
}

function deepHasKey(record: Record<string, unknown>, names: readonly string[]): boolean {
  return deepFindValue(record, names) !== undefined;
}

function modelIdFromListEntry(entry: unknown): string | null {
  if (typeof entry === 'string') return entry.trim() || null;
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  for (const key of ['id', 'model', 'slug']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function modelApiFromValue(value: string | null | undefined): CcSwitchOpenAICompatibleApiId | undefined {
  const normalized = normalizeApiFormat(value);
  if (normalized === 'openai_chat') return 'openai-completions';
  if (normalized === 'openai_responses') return 'openai-responses';
  return undefined;
}

function stringField(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return undefined;
}

function positiveIntegerField(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    const parsed = typeof value === 'number'
      ? value
      : (typeof value === 'string' ? Number.parseInt(value, 10) : NaN);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function integerValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value)))];
}

function formatDiscoveredModelName(modelId: string): string {
  return modelId
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => {
      const normalized = part.toLowerCase();
      if (normalized === 'gpt') return 'GPT';
      if (normalized === 'llama') return 'Llama';
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ') || modelId;
}
