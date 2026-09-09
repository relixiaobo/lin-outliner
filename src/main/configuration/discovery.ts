import { AgentConfigurationLoader, userConfigurationPath, projectConfigurationPath } from '../agent/AgentConfigurationLoader';
import { loadKeybindings, ensureKeybindingsFile } from './keybindings';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parse } from 'jsonc-parser';
import {
  PREFERENCE_DEFINITIONS, CONFIGURATION_LINKS, configurationValue, preferenceDefinition, validatePreference, preferenceApplicationDomain,
  type PreferenceEdit, type PreferencesView, type PreferenceValue,
} from '../../core/settingsDefinitions';
import { currentFilePreferencesStatus } from './status';
import { loadFilePreferences, updateFilePreferences } from './filePreferences';

export function readPreferencesView(userDataDir: string, hostSessionId: string, cwd?: string): PreferencesView {
  const loaded = loadFilePreferences(userDataDir);
  const raw: unknown = loaded.sourceStatus === 'accepted' ? parse(loaded.sourceBytes!) : {};
  const observedStatus = currentFilePreferencesStatus(userDataDir, hostSessionId);
  const application: PreferencesView['application'] = observedStatus?.source.observedDigest === loaded.sourceDigest
    && observedStatus.source.status === loaded.sourceStatus ? observedStatus.application : { status: 'pending', error: null };
  const keybindings = loadKeybindings(userDataDir);
  const agentSources = cwd ? new AgentConfigurationLoader(userDataDir).inspectSources(cwd) : [];
  return {
    sources: [
      { destination: 'shortcuts', sourceId: 'shortcuts', path: keybindings.path, status: keybindings.sourceStatus, digest: keybindings.sourceDigest,
        modified: keybindings.sourceStatus === 'accepted' && Object.keys(keybindings.overrides).length > 0, error: keybindings.error },
      ...agentSources.map((source) => ({ destination: 'agents' as const, sourceId: source.layer === 'user' ? 'agent-user' as const : 'agent-project' as const, path: source.path, status: source.state, digest: source.digest,
        modified: source.state === 'accepted' && sourceHasOverrides(source.path), error: source.error })),
    ],
    source: { path: loaded.path, status: loaded.sourceStatus, digest: loaded.sourceDigest,
      acceptedDigest: loaded.acceptedDigest, error: loaded.error, recoveryError: loaded.recoveryError },
    entries: PREFERENCE_DEFINITIONS.map(({ id }) => ({
      id, value: configurationValue(loaded.sourceStatus === 'rejected' && observedStatus?.preferences ? observedStatus.preferences : loaded.preferences, id) as PreferenceValue,
      effectiveValue: configurationValue(observedStatus?.preferences, id) as PreferenceValue | undefined,
      application: observedStatus?.source.observedDigest === loaded.sourceDigest
        ? observedStatus?.domains?.[preferenceApplicationDomain(id)] : { status: 'pending', error: null },
      modified: configurationValue(raw, id) !== undefined,
    })),
    structuredOverrides: CONFIGURATION_LINKS.flatMap(({ paths }) => paths.filter((id) => configurationValue(raw, id) !== undefined)),
    application,
  };
}

export function editPreference(userDataDir: string, raw: PreferenceEdit): void {
  if (!raw || typeof raw !== 'object' || !['set', 'reset'].includes(raw.operation)
    || !(raw.expectedDigest === null || typeof raw.expectedDigest === 'string')) throw new Error('Invalid preference edit');
  const definition = preferenceDefinition(raw.id);
  if (!definition) throw new Error('Unknown preference');
  if (raw.operation === 'set') validatePreference(definition, raw.value);
  updateFilePreferences(userDataDir, [{ path: definition.id.split('.'), value: raw.operation === 'reset' ? undefined : raw.value }], raw.expectedDigest);
}

export function ensurePreferencesFile(userDataDir: string): string {
  const loaded = loadFilePreferences(userDataDir);
  if (loaded.sourceStatus === 'missing') {
    mkdirSync(dirname(loaded.path), { recursive: true, mode: 0o700 });
    try { writeFileSync(loaded.path, '{}\n', { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  return loaded.path;
}

function sourceHasOverrides(path: string): boolean {
  try { return Object.keys(parse(readFileSync(path, 'utf8')) ?? {}).length > 0; }
  catch { return false; }
}

/** Only fixed public sources are addressable; the renderer never supplies a path. */
export function ensureConfigurationSource(userDataDir: string, cwd: string, source: unknown): string {
  if (source === 'preferences') return ensurePreferencesFile(userDataDir);
  if (source === 'shortcuts') return ensureKeybindingsFile(userDataDir);
  const path = source === 'agent-user' ? userConfigurationPath(userDataDir)
    : source === 'agent-project' ? projectConfigurationPath(cwd) : null;
  if (!path) throw new Error('Unknown public configuration source');
  mkdirSync(dirname(path), { recursive: true });
  try { writeFileSync(path, '{}\n', { flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  return path;
}
