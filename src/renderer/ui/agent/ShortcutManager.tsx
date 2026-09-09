import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { SettingsFeedback, type SettingsFeedbackState } from '../configuration/SettingsFeedback';
import { createPortal } from 'react-dom';
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
import { ICON_SIZE, SearchIcon } from '../icons';
import { Button } from '../primitives/Button';
import { Input } from '../primitives/Input';
import { AnchoredActionMenu } from '../primitives/AnchoredActionMenu';
import { InsetGroup, InsetRow } from './SettingsInsetList';

interface ShortcutManagerProps {
  readonly active?: boolean;
  readonly toolbarTarget?: HTMLElement | null;
}

interface RecordingTarget {
  readonly id: ConfigurableShortcutId;
  readonly index: number;
}

const CONTEXTS: readonly ShortcutContext[] = ['system', 'application', 'preview'];

export function ShortcutManager({ active = true, toolbarTarget }: ShortcutManagerProps) {
  const t = useT();
  const labels = t.settings.shortcuts;
  const [view, setView] = useState<KeybindingsView | null>(null);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState<RecordingTarget | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [operationFeedback, setOperationFeedback] = useState<Record<string, SettingsFeedbackState>>({});
  function report(key: string, feedback: SettingsFeedbackState = {}) { setOperationFeedback((current) => ({ ...current, [key]: feedback })); }
  const [recordingError, setRecordingError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let receivedChange = false;
    const unsubscribe = window.lin?.keybindings?.onChanged((next) => {
      if (!active) return;
      receivedChange = true;
      setView(next);
      setReadError(null);
    });
    // A live change supersedes both the initial snapshot and its possible error.
    void window.lin?.keybindings?.get()
      .then((next) => { if (active && !receivedChange) { setView(next); setReadError(null); } })
      .catch((error: unknown) => { if (active && !receivedChange) setReadError(errorText(error)); });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

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
    const key = input.id ?? 'defaults';
    report(key);
    try {
      const next = await window.lin?.keybindings?.update({
        ...input,
        observedDigest: view.source.observedDigest,
      });
      if (!next) throw new Error('Keyboard Shortcuts are unavailable.');
      setView(next);
      report(key, { notice });
      return true;
    } catch (error) {
      report(key, { error: errorText(error) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!active) { setRecording(null); setRecordingError(null); setMenu(null); }
  }, [active]);

  useEffect(() => {
    if (!active || !recording || !view) return;
    const entry = view.entries.find((candidate) => candidate.id === recording.id);
    if (!entry) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing || !(event.target instanceof Element) || !event.target.closest('.settings-shortcut-key.is-recording')) return;
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) return;
      if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) {
        setRecording(null);
        setRecordingError(null);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setRecording(null);
        setRecordingError(null);
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault();
        event.stopPropagation();
        if (recording.index >= desiredBindings(entry).length) {
          setRecording(null);
          setRecordingError(null);
          return;
        }
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
  }, [active, busy, labels.saved, recording, view]);

  async function openFile(): Promise<void> {
    setReadError(null);
    try {
      await window.lin?.keybindings?.openFile();
    } catch {
      setReadError(labels.openFailed);
    }
  }

  const rejected = view?.source.status === 'rejected';
  const hasResults = CONTEXTS.some((context) => view?.entries.some((entry) => (
    entry.context === context && filteredIds.has(entry.id)
  )));

  // The pane owns filtering while the shell owns placement.
  const toolbar = active ? <div className="settings-shortcuts-search settings-toolbar-control" role="search" aria-label={labels.search}>
    <SearchIcon size={ICON_SIZE.menu} aria-hidden />
    <Input
      label={labels.search}
      onChange={(event) => setQuery(event.target.value)}
      placeholder={labels.search}
      type="search"
      value={query}
      variant="bare"
    />
  </div> : null;

  return (
    <section className="agent-settings-section settings-shortcuts-section" aria-label={t.settings.pages.shortcuts}>
      {toolbarTarget === undefined ? toolbar : toolbarTarget && createPortal(toolbar, toolbarTarget)}

      <SettingsFeedback feedback={{ error: readError }} />
      {rejected ? (
        <div className="settings-shortcuts-source-error" role="alert">
          <p>{labels.sourceRejected({ error: view?.source.error ?? '' })}</p>
          <Button size="sm" variant="secondary" onClick={() => void openFile()}>{labels.openFile}</Button>
        </div>
      ) : null}

      {!view ? <InsetGroup><InsetRow empty label={t.settings.loading} /></InsetGroup> : null}
      {view && hasResults ? <div className="settings-shortcuts-table">
        <p className="settings-shortcuts-instruction">{labels.editHint}</p>
        {CONTEXTS.map((context) => {
          const entries = view.entries.filter((entry) => entry.context === context && filteredIds.has(entry.id));
          if (entries.length === 0) return null;
          return (
            <InsetGroup ariaLabel={contextLabel(context, labels)} key={context} label={contextLabel(context, labels)}>
              {entries.map((entry) => (
                <ShortcutRow
                  operationFeedback={operationFeedback[entry.id]}
                  busy={busy || rejected}
                  entry={entry}
                  key={entry.id}
                  menuOpen={menu === entry.id}
                  onMenuOpenChange={(open) => setMenu(open ? entry.id : null)}
                  onCancelRecording={() => { setRecording(null); setRecordingError(null); }}
                  onRecord={(index) => {
                    setRecording({ id: entry.id, index });
                    setRecordingError(null);
                  }}
                  onRemove={(index) => {
                    const next = desiredBindings(entry).filter((_binding, candidate) => candidate !== index);
                    void update({ id: entry.id, value: overrideFromBindings(next) }, labels.saved);
                  }}
                  onReset={() => void update({ id: entry.id }, labels.resetNotice)}
                  recording={recording?.id === entry.id ? recording.index : null}
                  recordingError={recording?.id === entry.id ? recordingError : null}
                />
              ))}
            </InsetGroup>
          );
        })}
      </div> : null}
      {view && !hasResults ? <InsetGroup><InsetRow empty label={labels.noResults} /></InsetGroup> : null}
      <div className="settings-shortcuts-footer">
        <Button disabled={!view || busy || rejected || !view.entries.some((entry) => entry.desired !== null)}
          onClick={() => void update({ resetAll: true }, labels.resetAllNotice)} size="sm" variant="secondary">{labels.resetAll}</Button>
        <SettingsFeedback feedback={operationFeedback.defaults} />
      </div>
    </section>
  );
}

function ShortcutRow({ operationFeedback, busy, entry, onRecord, onRemove, onReset, recording, recordingError, menuOpen, onMenuOpenChange, onCancelRecording }: {
  readonly operationFeedback?: SettingsFeedbackState;
  readonly busy: boolean;
  readonly entry: KeybindingsViewEntry;
  readonly onRecord: (index: number) => void;
  readonly onRemove: (index: number) => void;
  readonly onReset: () => void;
  readonly recording: number | null;
  readonly recordingError: string | null;
  readonly menuOpen: boolean;
  readonly onMenuOpenChange: (open: boolean) => void;
  readonly onCancelRecording: () => void;
}) {
  const t = useT();
  const labels = t.settings.shortcuts;
  const command = labels.commands[entry.id];
  const bindings = desiredBindings(entry);
  const feedback = recordingError ?? (entry.error
    ? labels.effectiveRetained({
        shortcuts: entry.effective.map((binding) => formatHotkey(binding) ?? binding).join(', ') || labels.disabledValue,
      })
    : null);
  const descriptionId = useId();
  const errorId = useId();
  const recordingButton = useRef<HTMLButtonElement>(null);
  const firstKey = useRef<HTMLButtonElement | null>(null);
  const menuAnchor = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (recording === null) return;
    // Menu dismissal first restores its trigger; then the new field receives input.
    const frame = requestAnimationFrame(() => recordingButton.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [recording]);
  const actions = [
    ...(bindings.length < 4 ? [{ label: bindings.length ? labels.add({ name: command.label }) : labels.assign({ name: command.label }), disabled: busy, onSelect: () => onRecord(bindings.length) }] : []),
    ...bindings.map((binding, index) => ({ label: labels.remove({ shortcut: formatHotkey(binding) ?? binding }), disabled: busy, onSelect: () => onRemove(index) })),
    ...(entry.desired !== null ? [{ label: labels.reset({ name: command.label }), disabled: busy, onSelect: onReset }] : []),
  ];
  const keyButton = (binding: string | null, index: number) => <button type="button" key={index}
    ref={(element) => {
      if (recording === index) recordingButton.current = element;
      if (index === 0) firstKey.current = element;
    }}
    aria-label={binding ? labels.change({ shortcut: binding }) : labels.assign({ name: command.label })}
    aria-describedby={`${descriptionId}${feedback ? ` ${errorId}` : ''}`}
    className={`settings-shortcut-key${recording === index ? ' is-recording' : ''}`}
    disabled={busy}
    onClick={(event) => { if (event.detail === 0) onRecord(index); }}
    onDoubleClick={() => onRecord(index)}
    onBlur={() => { if (recording === index) onCancelRecording(); }}
    title={recording === index ? labels.recording : binding ? labels.change({ shortcut: binding }) : labels.recording}>
    <kbd>{recording === index ? labels.recording : binding ? formatHotkey(binding) : labels.disabledValue}</kbd>
  </button>;
  return <div className="settings-shortcut-row" role="listitem" data-shortcut-id={entry.id}
    onContextMenu={(event) => {
      event.preventDefault();
      if (busy) return;
      const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.settings-shortcut-key') : null;
      menuAnchor.current = target ?? firstKey.current;
      menuAnchor.current?.focus();
      onCancelRecording();
      onMenuOpenChange(true);
    }}
    onKeyDown={(event) => {
      if (busy || event.nativeEvent.isComposing || !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return;
      event.preventDefault();
      if (event.target instanceof Element) {
        const key = event.target.closest<HTMLButtonElement>('.settings-shortcut-key');
        if (key) menuAnchor.current = key;
      }
      onCancelRecording();
      onMenuOpenChange(true);
    }}>
    <span className="settings-shortcut-label" title={command.description}>{command.label}</span>
    <span id={descriptionId} hidden>{command.description}</span>
    <div className="settings-shortcut-bindings">
      {bindings.map((binding, index) => keyButton(binding, index))}
      {bindings.length === 0 || recording === bindings.length ? keyButton(null, bindings.length) : null}
    </div>
    {menuOpen ? <AnchoredActionMenu ariaLabel={labels.actions({ name: command.label })}
      anchorRef={menuAnchor} onClose={() => onMenuOpenChange(false)} actions={actions}
      className="settings-row-menu" itemClassName="settings-row-menu-item" /> : null}
    {!feedback && (operationFeedback?.error || operationFeedback?.notice) ? <div className="settings-shortcut-feedback"><SettingsFeedback feedback={operationFeedback} /></div> : null}
    {feedback ? <p id={errorId} className="settings-shortcuts-source-error settings-shortcut-feedback" role="alert">{feedback}</p> : null}
  </div>;

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
