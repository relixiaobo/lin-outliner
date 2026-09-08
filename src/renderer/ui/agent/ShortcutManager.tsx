import { useEffect, useMemo, useState } from 'react';
import {
  CONFIGURABLE_SHORTCUTS,
  portableChordFromEvent,
  type ConfigurableShortcutId,
  type KeybindingOverride,
  type KeybindingsUpdateInput,
  type KeybindingsView,
  type KeybindingsViewEntry,
  type ShortcutContext,
} from '../../../core/keybindings';
import { formatHotkey } from '../../../core/launcher/commands';
import { useT } from '../../i18n/I18nProvider';
import { AddIcon, CloseIcon, FolderIcon, ICON_SIZE, SearchIcon, UndoIcon } from '../icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { Input } from '../primitives/Input';
import { SwitchControl } from '../primitives/SwitchControl';
import { SwitchMark } from '../primitives/SwitchMark';
import { InsetGroup, InsetRow } from './SettingsInsetList';

interface ShortcutManagerProps {
  readonly onError: (message: string | null) => void;
  readonly onNotice: (message: string | null) => void;
}

interface RecordingTarget {
  readonly id: ConfigurableShortcutId;
  readonly index: number;
}

const CONTEXTS: readonly ShortcutContext[] = ['system', 'application', 'preview'];

export function ShortcutManager({ onError, onNotice }: ShortcutManagerProps) {
  const t = useT();
  const labels = t.settings.shortcuts;
  const [view, setView] = useState<KeybindingsView | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState<RecordingTarget | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void window.lin?.keybindings?.get()
      .then((next) => { if (active) setView(next); })
      .catch((error: unknown) => { if (active) onError(errorText(error)); });
    const unsubscribe = window.lin?.keybindings?.onChanged((next) => {
      if (active) setView(next);
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [onError]);

  const filteredIds = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return new Set(CONFIGURABLE_SHORTCUTS.map(({ id }) => id));
    return new Set(configurableShortcutsWithLabels(t).filter(({ id, label, description }) => (
      `${id} ${label} ${description}`.toLocaleLowerCase().includes(needle)
    )).map(({ id }) => id));
  }, [query, t]);

  async function update(input: Omit<KeybindingsUpdateInput, 'observedDigest'>, notice: string): Promise<boolean> {
    if (!view || busy || view.source.status === 'rejected') return false;
    setBusy(true);
    onError(null);
    onNotice(null);
    try {
      const next = await window.lin?.keybindings?.update({
        ...input,
        observedDigest: view.source.observedDigest,
      });
      if (!next) throw new Error('Keyboard Shortcuts are unavailable.');
      setView(next);
      onNotice(notice);
      return true;
    } catch (error) {
      onError(errorText(error));
      return false;
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!recording || !view) return;
    const entry = view.entries.find((candidate) => candidate.id === recording.id);
    if (!entry) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setRecording(null);
        setRecordingError(null);
        return;
      }
      if ((event.key === 'Backspace' || event.key === 'Delete') && recording.index < desiredBindings(entry).length) {
        event.preventDefault();
        const next = desiredBindings(entry).filter((_binding, index) => index !== recording.index);
        void update({ id: entry.id, value: overrideFromBindings(next) }, labels.saved).then((saved) => {
          if (saved) setRecording(null);
        });
        return;
      }
      try {
        const chord = portableChordFromEvent(event);
        if (!chord) return;
        event.preventDefault();
        event.stopPropagation();
        const next = [...desiredBindings(entry)];
        next[recording.index] = chord;
        if (new Set(next).size !== next.length) throw new Error(`${chord} is already assigned to this command`);
        setRecordingError(null);
        void update({ id: entry.id, value: overrideFromBindings(next) }, labels.saved).then((saved) => {
          if (saved) setRecording(null);
        });
      } catch (error) {
        event.preventDefault();
        setRecordingError(errorText(error));
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [busy, labels.saved, recording, view]);

  async function openFile(): Promise<void> {
    onError(null);
    try {
      await window.lin?.keybindings?.openFile();
    } catch {
      onError(labels.openFailed);
    }
  }

  const rejected = view?.source.status === 'rejected';
  const hasResults = CONTEXTS.some((context) => view?.entries.some((entry) => (
    entry.context === context && filteredIds.has(entry.id)
  )));

  return (
    <section className="agent-settings-section settings-shortcuts-section" aria-label={t.settings.pages.shortcuts}>
      <div className="settings-shortcuts-toolbar">
        <div className="settings-shortcuts-search">
          <SearchIcon size={ICON_SIZE.menu} />
          <Input
            label={labels.search}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={labels.search}
            type="search"
            value={query}
            variant="bare"
          />
        </div>
        <Button onClick={() => void openFile()} size="sm" variant="secondary">
          <FolderIcon size={ICON_SIZE.menu} />
          <span>{labels.openFile}</span>
        </Button>
        <Button
          disabled={!view || busy || rejected}
          onClick={() => void update({ resetAll: true }, labels.resetAllNotice)}
          size="sm"
          variant="secondary"
        >
          <UndoIcon size={ICON_SIZE.menu} />
          <span>{labels.resetAll}</span>
        </Button>
      </div>

      {rejected ? (
        <p className="settings-shortcuts-source-error" role="alert">
          {labels.sourceRejected({ error: view?.source.error ?? '' })}
        </p>
      ) : null}

      {!view ? <InsetGroup><InsetRow empty label={t.settings.loading} /></InsetGroup> : null}
      {view ? CONTEXTS.map((context) => {
        const entries = view.entries.filter((entry) => entry.context === context && filteredIds.has(entry.id));
        if (entries.length === 0) return null;
        return (
          <InsetGroup ariaLabel={contextLabel(context, labels)} key={context} label={contextLabel(context, labels)}>
            {entries.map((entry) => (
              <ShortcutRow
                busy={busy || rejected}
                entry={entry}
                key={entry.id}
                onRecord={(index) => {
                  setRecording({ id: entry.id, index });
                  setRecordingError(null);
                }}
                onRemove={(index) => {
                  const next = desiredBindings(entry).filter((_binding, candidate) => candidate !== index);
                  void update({ id: entry.id, value: overrideFromBindings(next) }, labels.saved);
                }}
                onReset={() => void update({ id: entry.id }, labels.resetNotice)}
                onToggle={(enabled) => void update(
                  enabled ? { id: entry.id } : { id: entry.id, value: false },
                  labels.saved,
                )}
                recording={recording?.id === entry.id ? recording.index : null}
                recordingError={recording?.id === entry.id ? recordingError : null}
              />
            ))}
          </InsetGroup>
        );
      }) : null}
      {view && !hasResults ? <InsetGroup><InsetRow empty label={labels.noResults} /></InsetGroup> : null}
    </section>
  );
}

function ShortcutRow({ busy, entry, onRecord, onRemove, onReset, onToggle, recording, recordingError }: {
  readonly busy: boolean;
  readonly entry: KeybindingsViewEntry;
  readonly onRecord: (index: number) => void;
  readonly onRemove: (index: number) => void;
  readonly onReset: () => void;
  readonly onToggle: (enabled: boolean) => void;
  readonly recording: number | null;
  readonly recordingError: string | null;
}) {
  const t = useT();
  const labels = t.settings.shortcuts;
  const command = labels.commands[entry.id];
  const bindings = desiredBindings(entry);
  const enabled = entry.desired !== false;
  const feedback = recordingError ?? (entry.error
    ? labels.effectiveRetained({
        shortcuts: entry.effective.map((binding) => formatHotkey(binding) ?? binding).join(', ') || labels.disabledValue,
      })
    : null);
  return (
    <InsetRow
      feedback={feedback}
      label={(
        <>
          <span>{command.label}</span>
          <span className="settings-chip">{entry.desired === null ? labels.defaultBadge : labels.modifiedBadge}</span>
        </>
      )}
      sublabel={(
        <>
          <span>{command.description}</span>
          <code className="inset-row-code">{entry.id}</code>
        </>
      )}
      trailing={(
        <div className="settings-shortcut-controls">
          <SwitchControl
            checked={enabled}
            disabled={busy}
            label={labels.enabled({ name: command.label })}
            onCheckedChange={onToggle}
          >
            <SwitchMark checked={enabled} />
          </SwitchControl>
          {enabled ? (
            <div className="settings-shortcut-bindings">
              {bindings.map((binding, index) => (
                <span className="settings-shortcut-binding" key={`${binding}:${index}`}>
                  <button
                    aria-label={labels.change({ shortcut: binding })}
                    className={`settings-shortcut-key${recording === index ? ' is-recording' : ''}`}
                    disabled={busy}
                    onClick={() => onRecord(index)}
                    title={labels.change({ shortcut: binding })}
                    type="button"
                  >
                    <kbd>{recording === index ? labels.recording : formatHotkey(binding)}</kbd>
                  </button>
                  <IconButton
                    disabled={busy}
                    icon={CloseIcon}
                    iconSize={ICON_SIZE.tiny}
                    label={labels.remove({ shortcut: binding })}
                    onClick={() => onRemove(index)}
                    variant="chrome"
                  />
                </span>
              ))}
              {recording === bindings.length ? (
                <button
                  className="settings-shortcut-key is-recording"
                  disabled={busy}
                  type="button"
                >
                  <kbd>{labels.recording}</kbd>
                </button>
              ) : null}
              {bindings.length < 4 ? (
                <IconButton
                  disabled={busy}
                  icon={AddIcon}
                  iconSize={ICON_SIZE.tiny}
                  label={labels.add({ name: command.label })}
                  onClick={() => onRecord(bindings.length)}
                  variant="chrome"
                />
              ) : null}
            </div>
          ) : <span className="inset-row-value">{labels.disabledValue}</span>}
          <IconButton
            disabled={busy || entry.desired === null}
            icon={UndoIcon}
            iconSize={ICON_SIZE.menu}
            label={labels.reset({ name: command.label })}
            onClick={onReset}
            variant="chrome"
          />
        </div>
      )}
      wrap
    />
  );
}

function desiredBindings(entry: KeybindingsViewEntry): readonly string[] {
  if (entry.desired === false) return [];
  if (typeof entry.desired === 'string') return [entry.desired];
  if (Array.isArray(entry.desired)) return entry.desired;
  return entry.defaults;
}

function overrideFromBindings(bindings: readonly string[]): KeybindingOverride {
  if (bindings.length === 0) return false;
  return bindings.length === 1 ? bindings[0]! : bindings;
}

function contextLabel(context: ShortcutContext, labels: ReturnType<typeof useT>['settings']['shortcuts']): string {
  if (context === 'system') return labels.systemGroup;
  if (context === 'preview') return labels.previewGroup;
  return labels.applicationGroup;
}

function configurableShortcutsWithLabels(t: ReturnType<typeof useT>) {
  return CONFIGURABLE_SHORTCUTS.map(({ id }) => ({ id, ...t.settings.shortcuts.commands[id] }));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
